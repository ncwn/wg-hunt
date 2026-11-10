import { wgGesuchtSource } from "@wg-hunt/core/sources/wg-gesucht";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { FetchedOffer } from "../src/crawl/search-polls.js";
import { offerAds, offers, seenAds } from "../src/db/schema.js";
import { adapterFixture, offerPageWith } from "./fixtures/search-pages.js";
import { bootOffers, HOUR, MINUTE } from "./offers-harness.js";

type Harness = ReturnType<typeof bootOffers>;

async function crawledOffer() {
  const h = bootOffers();
  h.site.cards = h.freshCards([9000001]);
  await h.addSearch();
  await h.crawl();
  const id = (await h.json("GET", "/offers")).body.items[0].id as number;
  return { h, id };
}

function fetchedFrom(h: Harness, adId: number, html: string): FetchedOffer {
  const parsed = wgGesuchtSource.parseOffer(html, {
    firstSeen: new Date(h.clock.now),
    category: "flatshare-room",
  });
  if (parsed.outcome !== "parsed") throw new Error("unreadable");
  return {
    source: "wg-gesucht",
    adId: String(adId),
    fetchedAt: h.clock.now + 5 * MINUTE,
    card: {
      adId: String(adId),
      path: `/wg-zimmer-in-Teststadt-Mitte.${adId}.html`,
      title: `Zimmer ${adId}`,
      advertiser: { name: "Anna", kind: "private" },
    },
    parsed,
  };
}

const storedCard = (h: Harness, id: number) =>
  JSON.parse(h.runtime.db.select().from(offers).where(eq(offers.id, id)).get()?.card ?? "{}");

describe("an Offer follows what the polls see", () => {
  it("moves the Bump time and the card when a poll sees the Ad ID Bumped", async () => {
    const { h, id } = await crawledOffer();
    const before = (await h.json("GET", `/offers/${id}`)).body;
    expect(storedCard(h, id).title).toBe("Zimmer 9000001");

    h.site.cards = [{ id: 9000001, age: "3 Min.", title: "Zimmer 9000001, neu eingestellt" }];
    await h.crawl(2 * HOUR);

    const after = (await h.json("GET", `/offers/${id}`)).body;
    expect(new Date(after.lastBumpAt).getTime()).toBeGreaterThan(
      new Date(before.lastBumpAt).getTime() + 30 * MINUTE,
    );
    expect(after.ads[0].lastBumpAt).toBe(after.lastBumpAt);
    expect(storedCard(h, id).title).toBe("Zimmer 9000001, neu eingestellt");
    expect((await h.json("GET", "/offers")).body.items).toHaveLength(1);
    expect(h.events.filter((e) => e.type === "offer-added")).toHaveLength(1);
  });

  it("keeps the Bump time while the card only ages", async () => {
    const { h, id } = await crawledOffer();
    const before = (await h.json("GET", `/offers/${id}`)).body.lastBumpAt;

    // The same publish, seen 45 minutes later: "50 Min." rather than "5 Min.".
    h.site.cards = [{ id: 9000001, age: "50 Min.", title: "Zimmer 9000001" }];
    await h.crawl(20 * MINUTE);

    // A second poll did see the card: page 1 was asked for by the first poll, by the new Search's
    // backfill, and now by the second poll.
    expect(h.sent.filter((path) => /in-Berlin\.\d+\.0\.1\.0\.html/.test(path))).toHaveLength(3);
    expect((await h.json("GET", `/offers/${id}`)).body.lastBumpAt).toBe(before);
  });
});

describe("an older Ad ID", () => {
  async function offerWithTwoAds() {
    const { h, id } = await crawledOffer();
    h.runtime.db
      .insert(offerAds)
      .values({
        source: "wg-gesucht",
        adId: "9000002",
        offerId: id,
        path: "/wg-zimmer-in-Teststadt-Mitte.9000002.html",
        firstSeenAt: new Date(h.clock.now),
        lastBumpAt: new Date(h.clock.now),
        pageStatus: "active",
      })
      .run();
    return { h, id };
  }

  it("does not overwrite the facts, title or card of an Offer with a more recent Ad ID", async () => {
    const { h, id } = await offerWithTwoAds();

    h.runtime.offers.ingest(
      fetchedFrom(h, 9000001, offerPageWith({ title: "Der alte Text", warmRent: 700 })),
    );

    const { body } = await h.json("GET", `/offers/${id}`);
    expect(body.title).toBe("Helles Zimmer in ruhiger Studenten-WG");
    expect(body.keyFacts.warmRent.amount).toBe(489);
    expect(body.priceHistory).toHaveLength(1);
    expect(body.current).toBeUndefined();
    expect(body.ads.map((a: { adId: string; current: boolean }) => [a.adId, a.current])).toEqual([
      ["9000001", false],
      ["9000002", true],
    ]);
  });

  it("is overwritten by the most recent Ad ID's page", async () => {
    const { h, id } = await offerWithTwoAds();

    h.runtime.offers.ingest(
      fetchedFrom(h, 9000002, offerPageWith({ title: "Der neue Text", warmRent: 520 })),
    );

    const { body } = await h.json("GET", `/offers/${id}`);
    expect(body.title).toBe("Der neue Text");
    expect(body.keyFacts.warmRent.amount).toBe(520);
    expect(body.priceHistory.map((p: { warmRent: number }) => p.warmRent)).toEqual([489, 520]);
  });
});

describe("a page the Source has deleted", () => {
  it("marks the Ad ID of a known Offer deleted and leaves its facts alone", async () => {
    const { h, id } = await crawledOffer();

    h.runtime.offers.ingest(fetchedFrom(h, 9000001, adapterFixture("deleted")));

    const { body } = await h.json("GET", `/offers/${id}`);
    expect(body.pageStatus).toBe("deleted");
    expect(body.ads[0].pageStatus).toBe("deleted");
    expect(body.keyFacts.warmRent.amount).toBe(489);
  });

  it("still makes no Offer of an Ad ID it did not know", async () => {
    const { h } = await crawledOffer();

    h.runtime.offers.ingest(fetchedFrom(h, 9000077, adapterFixture("deleted")));

    expect((await h.json("GET", "/offers")).body.items).toHaveLength(1);
    expect((await h.json("GET", "/offers/lookup?adId=9000077")).body.type).toBe("not-known");
  });
});

describe("stored pages and boot", () => {
  it("marks every page the Offers step has dealt with, deleted ones included", async () => {
    const h = bootOffers();
    h.site.cards = h.freshCards([9000001, 9000002]);
    h.site.pages.set(9000002, adapterFixture("deleted"));
    await h.addSearch();
    await h.crawl();

    const marked = h.runtime.db.select().from(seenAds).all();
    expect(marked.map((row) => [row.adId, row.ingestedAt !== null])).toEqual([
      ["9000001", true],
      ["9000002", true],
    ]);
  });

  it("does not bring back an Offer that was removed", async () => {
    const { h, id } = await crawledOffer();
    // As dedupe or pruning will remove it; its page stays marked.
    h.runtime.db.delete(offers).where(eq(offers.id, id)).run();
    h.runtime.close();

    const restarted = bootOffers({ dataDir: h.dataDir });
    await restarted.runtime.catchUp;

    expect((await restarted.json("GET", "/offers")).body.items).toEqual([]);
  });
});

describe("the content hash", () => {
  const hashes = (h: Harness) =>
    h.runtime.db
      .select()
      .from(offerAds)
      .all()
      .map((ad) => [ad.adId, ad.contentHash] as const);

  it("is stored with each Ad ID, and is the same for the same words", async () => {
    const h = bootOffers();
    h.site.cards = h.freshCards([9000001, 9000002, 9000003]);
    h.site.pages.set(9000003, offerPageWith({ title: "Ganz anderer Text", warmRent: 489 }));
    await h.addSearch();
    await h.crawl();

    const byAd = Object.fromEntries(hashes(h));
    expect(byAd["9000001"]).toMatch(/^[0-9a-f]{64}$/);
    expect(byAd["9000002"]).toBe(byAd["9000001"]);
    expect(byAd["9000003"]).not.toBe(byAd["9000001"]);
  });

  it("follows the page when the Ad ID is stored again", async () => {
    const { h } = await crawledOffer();
    const first = hashes(h)[0]?.[1];

    h.runtime.offers.ingest(
      fetchedFrom(h, 9000001, offerPageWith({ title: "Neuer Titel", warmRent: 489 })),
    );

    const second = hashes(h)[0]?.[1];
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
  });
});
