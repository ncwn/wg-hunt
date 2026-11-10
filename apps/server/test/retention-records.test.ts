import { describe, expect, it } from "vitest";
import {
  offerLinks,
  offerPairOverrides,
  offerPrices,
  searchMatches,
  seenAds,
} from "../src/db/schema.js";
import { ingestAds } from "./dedupe-harness.js";
import { bootOffers } from "./offers-harness.js";
import {
  adIdsOf,
  DAY,
  goStale,
  type Harness,
  nights,
  oneOffer,
  recordExists,
  seenAdIds,
} from "./retention-harness.js";

describe("the Offer record's 90 days", () => {
  it("deletes an Offer 90 days after it went Stale, with its Ad IDs and prices", async () => {
    const { h, id } = await oneOffer();
    goStale(h);
    expect(recordExists(h, id)).toBe(true);

    nights(h, 89);
    expect(recordExists(h, id)).toBe(true);
    nights(h, 2);

    expect(recordExists(h, id)).toBe(false);
    expect(adIdsOf(h, id)).toEqual([]);
    expect(h.runtime.db.select().from(offerPrices).all()).toEqual([]);
    expect((await h.json("GET", `/offers/${id}`)).status).toBe(404);
  });

  it("ages an Untracked Offer exactly like a Stale one", async () => {
    const { h, id } = await oneOffer();
    const [search] = (await h.json("GET", "/searches")).body.items;
    await h.json("PATCH", `/searches/${search.id}`, { enabled: false });
    h.runtime.retention.prune();
    expect((await h.json("GET", `/offers/${id}`)).body.stale).toBe(false);

    nights(h, 89);
    expect(recordExists(h, id)).toBe(true);
    nights(h, 2);
    expect(recordExists(h, id)).toBe(false);
  });

  it("does not delete an Offer a Search still matches", async () => {
    const { h, id } = await oneOffer();
    for (let day = 0; day < 100; day++) {
      h.clock.now += DAY;
      h.runtime.db.$client.exec(`UPDATE offer_ads SET lastBumpAt = ${h.clock.now}`);
      h.runtime.retention.prune();
    }
    expect(recordExists(h, id)).toBe(true);
  });

  it("stops both clocks when the Offer comes back, and starts over the next time", async () => {
    const { h, id } = await oneOffer();
    goStale(h);
    nights(h, 80);

    h.runtime.db.$client.exec(`UPDATE offer_ads SET lastBumpAt = ${h.clock.now}`);
    h.runtime.retention.prune();
    nights(h, 5);
    expect(recordExists(h, id)).toBe(true);

    // Quiet again 8 nights after that Bump, with a clock of its own: the old one would have run
    // out long ago.
    nights(h, 55);
    expect(recordExists(h, id)).toBe(true);
    nights(h, 37);
    expect(recordExists(h, id)).toBe(true);
    nights(h, 1);
    expect(recordExists(h, id)).toBe(false);
  });

  it("forgets the Ad IDs it was known under, so a returning Ad ID is a new Offer", async () => {
    const { h, id, adId } = await oneOffer();
    goStale(h);
    nights(h, 91);
    expect(recordExists(h, id)).toBe(false);
    expect(seenAdIds(h)).not.toContain(adId);
    expect(h.runtime.db.select().from(searchMatches).all()).toEqual([]);
  });

  it("removes the Sibling and Cloned links of the Offer's Ad IDs", async () => {
    const h = bootOffers();
    ingestAds(
      h,
      { adId: 9000001 },
      { adId: 9000002, street: "Andere Straße 4", text: "x ".repeat(80) },
    );
    h.runtime.db
      .insert(offerLinks)
      .values({
        source: "wg-gesucht",
        adId: "9000002",
        otherAdId: "9000001",
        kind: "sibling",
        sharedImages: 0,
        textSimilarity: null,
      })
      .run();
    goStale(h);
    nights(h, 91);
    expect(h.runtime.db.select().from(offerLinks).all()).toEqual([]);
  });
});

describe("what the seeker's marks and overrides keep", () => {
  const markCases = [
    ["Dismissed", { dismissed: true }],
    ["Shortlisted", { shortlisted: true }],
    ["Contacted", { contacted: true }],
    ["a scam mark", { scam: "scam" }],
    ["a not-a-scam mark", { scam: "not" }],
  ] as const;

  for (const [name, mark] of markCases) {
    it(`keeps the record of an Offer with ${name}`, async () => {
      const { h, id } = await oneOffer();
      expect((await h.json("PATCH", `/offers/${id}/marks`, mark)).status).toBe(200);
      goStale(h);
      nights(h, 200);
      expect(recordExists(h, id)).toBe(true);
    });
  }

  it("keeps the record of an Offer with a manual fact override, until it is reverted", async () => {
    const { h, id } = await oneOffer();
    expect(
      (await h.json("PUT", `/offers/${id}/facts/anmeldung`, { value: "possible" })).status,
    ).toBe(200);
    goStale(h);
    nights(h, 200);
    expect(recordExists(h, id)).toBe(true);

    expect((await h.json("DELETE", `/offers/${id}/facts/anmeldung`)).status).toBe(200);
    h.runtime.retention.prune();
    nights(h, 89);
    expect(recordExists(h, id)).toBe(true);
    nights(h, 2);
    expect(recordExists(h, id)).toBe(false);
  });

  it("starts the normal clock when the last mark is cleared", async () => {
    const { h, id } = await oneOffer();
    await h.json("PATCH", `/offers/${id}/marks`, { shortlisted: true, contacted: true });
    goStale(h);
    nights(h, 200);

    await h.json("PATCH", `/offers/${id}/marks`, { shortlisted: false });
    h.runtime.retention.prune();
    nights(h, 100);
    expect(recordExists(h, id)).toBe(true);

    await h.json("PATCH", `/offers/${id}/marks`, { contacted: false });
    h.runtime.retention.prune();
    nights(h, 89);
    expect(recordExists(h, id)).toBe(true);
    nights(h, 2);
    expect(recordExists(h, id)).toBe(false);
  });

  it("keeps the records of both Offers of a merge or split pair override", async () => {
    const h = bootOffers();
    const [first, second] = ingestAds(
      h,
      { adId: 9000001 },
      { adId: 9000002, street: "Andere Straße 4", text: "y ".repeat(80), flatSize: 55 },
    );
    expect(first?.offerId).not.toBe(second?.offerId);
    h.runtime.db
      .insert(offerPairOverrides)
      .values({
        source: "wg-gesucht",
        adIdA: "9000001",
        adIdB: "9000002",
        verdict: "different",
        createdAt: new Date(h.clock.now),
      })
      .run();
    goStale(h);
    nights(h, 200);
    expect(recordExists(h, first?.offerId as number)).toBe(true);
    expect(recordExists(h, second?.offerId as number)).toBe(true);
    expect(h.runtime.db.select().from(offerPairOverrides).all()).toHaveLength(1);
  });
});

describe("a re-post after the Offer went quiet", () => {
  it("still merges into the Offer within 90 days", async () => {
    const h = bootOffers();
    const [first] = ingestAds(h, { adId: 9000001, warmRent: 450 });
    goStale(h);
    nights(h, 80);
    const [repost] = ingestAds(h, { adId: 9000002, warmRent: 480 });
    expect(repost?.offerId).toBe(first?.offerId);
    expect(adIdsOf(h, first?.offerId as number).sort()).toEqual(["9000001", "9000002"]);
  });

  it("is a new Offer once the record was deleted", async () => {
    const h = bootOffers();
    const [first] = ingestAds(h, { adId: 9000001, warmRent: 450 });
    goStale(h);
    nights(h, 95);
    expect(recordExists(h, first?.offerId as number)).toBe(false);
    const [repost] = ingestAds(h, { adId: 9000002, warmRent: 480 });
    expect(repost?.offerId).not.toBe(first?.offerId);
  });

  it("does not bring a pruned Offer back when the server restarts", async () => {
    const h = bootOffers();
    const [first] = ingestAds(h, { adId: 9000001 });
    goStale(h);
    nights(h, 95);
    await h.runtime.offers.adoptStoredPages();
    expect(recordExists(h, first?.offerId as number)).toBe(false);
    expect(h.runtime.db.$client.prepare("SELECT COUNT(*) AS n FROM offers").get()).toEqual({
      n: 0,
    });
  });
});

describe("Ad IDs that never became an Offer", () => {
  it("forgets a priced-out card once nothing has seen it for as long as a record is kept", () => {
    const h = bootOffers();
    h.runtime.db
      .insert(seenAds)
      .values({
        source: "wg-gesucht",
        adId: "9000009",
        firstSeenAt: new Date(h.clock.now),
        lastSeenAt: new Date(h.clock.now),
        category: "flat",
        card: JSON.stringify({
          adId: "9000009",
          path: "/9000009.html",
          title: "x",
          advertiser: {},
        }),
        detailState: "priced-out",
      })
      .run();

    nights(h, 89);
    expect(seenAdIds(h)).toContain("9000009");
    nights(h, 2);
    expect(seenAdIds(h)).not.toContain("9000009");
  });

  const matchedAdIds = (h: Harness) =>
    h.runtime.db
      .select()
      .from(searchMatches)
      .all()
      .map((match) => match.adId);

  it("forgets the Search matches of a card it forgets", async () => {
    const h = bootOffers();
    // Published two weeks ago: too old to fetch, so the Search matches it but no Offer is made.
    h.site.cards = [{ id: 9000009, age: "20.10.2026" }];
    await h.addSearch();
    await h.crawl();
    expect((await h.json("GET", "/offers?includeHidden=true")).body.items).toEqual([]);
    expect(matchedAdIds(h)).toEqual(["9000009"]);

    nights(h, 89);
    expect(matchedAdIds(h)).toEqual(["9000009"]);
    nights(h, 2);
    expect(seenAdIds(h)).toEqual([]);
    expect(matchedAdIds(h)).toEqual([]);
  });

  it("clears the Search matches an earlier prune left without their card", async () => {
    const { h, adId } = await oneOffer();
    // The card's row gone, its match still there.
    h.runtime.db
      .insert(searchMatches)
      .values({
        searchId: 1,
        source: "wg-gesucht",
        adId: "9000009",
        lastSeenAt: new Date(h.clock.now - 200 * DAY),
      })
      .run();

    h.runtime.retention.prune();

    expect(matchedAdIds(h)).toEqual([adId]);
  });
});
