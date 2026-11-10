import { describe, expect, it } from "vitest";
import { offerAds } from "../src/db/schema.js";
import {
  fetchedAd,
  HALF_ALIKE_TEXT,
  hash,
  ingestAds,
  OTHER_ROOM_TEXT,
  photo,
  ROOM_TEXT_EDITED,
  TEMPLATE_TEXT,
} from "./dedupe-harness.js";
import { bootOffers, MINUTE } from "./offers-harness.js";

const marek = { name: "Marek", memberSince: "Mai 2026" };
const coliving = {
  name: "Coliving GmbH",
  avatar: `https://img.example.test/media/up/2026/40/${hash(900)}_logo.sized.jpg`,
  memberSince: "Januar 2024",
  company: true,
};

const offersOf = async (h: ReturnType<typeof bootOffers>) =>
  // These Offers are ingested without a Search, so ranking calls them Untracked: list them all.
  (await h.json("GET", "/offers?includeHidden=true")).body.items;
const detailOf = async (h: ReturnType<typeof bootOffers>, adId: number) =>
  (await h.json("GET", `/offers/lookup?adId=${adId}`)).body;

describe("a Duplicate collapses into the Offer", () => {
  it("merges a re-post with a changed price, keeping every Ad ID and the price history", async () => {
    const h = bootOffers();
    ingestAds(
      h,
      { adId: 9000001, warmRent: 450 },
      { adId: 9000002, warmRent: 480, text: ROOM_TEXT_EDITED },
    );

    const items = await offersOf(h);
    expect(items).toHaveLength(1);
    const offer = await detailOf(h, 9000002);
    expect(offer.id).toBe(items[0].id);
    expect(offer.ads.map((ad: { adId: string }) => ad.adId)).toEqual(["9000001", "9000002"]);
    expect(offer.ads.map((ad: { current: boolean }) => ad.current)).toEqual([false, true]);
    expect(offer.url).toContain("9000002");
    expect(
      offer.priceHistory.map((p: { warmRent: number; adId: string }) => [p.adId, p.warmRent]),
    ).toEqual([
      ["9000001", 450],
      ["9000002", 480],
    ]);
    expect(offer.keyFacts.warmRent.amount).toBe(480);
    expect((await detailOf(h, 9000001)).id).toBe(offer.id);
  });

  it("keeps the earliest first-seen time and the first Ad ID's Offer id", async () => {
    const h = bootOffers();
    const first = h.clock.now;
    ingestAds(h, { adId: 9000001 }, { adId: 9000002 });

    const offer = await detailOf(h, 9000002);
    expect(offer.firstSeenAt).toBe(new Date(first).toISOString());
    expect(offer.createdAt).toBe(new Date(first).toISOString());
    expect(h.events.filter((event) => event.type === "offer-added")).toHaveLength(1);
  });

  it("adds no price point when the rent did not change", async () => {
    const h = bootOffers();
    ingestAds(h, { adId: 9000001, warmRent: 450 }, { adId: 9000002, warmRent: 450 });

    expect((await detailOf(h, 9000001)).priceHistory).toHaveLength(1);
  });

  it("does not let an older Ad ID's page overwrite the newer one's facts", async () => {
    const h = bootOffers();
    h.runtime.offers.ingest(fetchedAd(h, { adId: 9000002, warmRent: 480 }));
    // Found later, but published earlier than the Ad ID the Offer already has.
    h.runtime.offers.ingest(fetchedAd(h, { adId: 9000001, warmRent: 450 }, -60 * MINUTE));

    const offer = await detailOf(h, 9000001);
    expect(offer.ads.find((ad: { current: boolean }) => ad.current).adId).toBe("9000002");
    expect(offer.keyFacts.warmRent.amount).toBe(480);
  });

  it("compares with Stale Offers too: a re-post of a deleted Ad ID revives the Offer", async () => {
    const h = bootOffers();
    ingestAds(h, { adId: 9000001 });
    h.runtime.offers.ingest({
      ...fetchedAd(h, { adId: 9000001 }),
      parsed: { outcome: "parsed", status: "deleted", rulesVersion: 1 },
    });
    expect((await detailOf(h, 9000001)).pageStatus).toBe("deleted");

    ingestAds(h, { adId: 9000002 });

    const offer = await detailOf(h, 9000002);
    expect(await offersOf(h)).toHaveLength(1);
    expect(offer.pageStatus).toBe("active");
    expect(offer.ads.map((ad: { pageStatus: string }) => ad.pageStatus)).toEqual([
      "deleted",
      "active",
    ]);
  });

  it("merges a re-post whose photos are all new when the text is near-identical", async () => {
    const h = bootOffers();
    ingestAds(h, { adId: 9000001 }, { adId: 9000002, images: [photo(70), photo(71)] });

    expect(await offersOf(h)).toHaveLength(1);
  });
});

describe("rooms and Advertisers dedupe keeps apart", () => {
  it("links a different room size in the same flat as a Sibling, in both directions", async () => {
    const h = bootOffers();
    ingestAds(
      h,
      { adId: 9000001, roomSize: 18 },
      { adId: 9000002, roomSize: 12, text: OTHER_ROOM_TEXT },
    );

    expect(await offersOf(h)).toHaveLength(2);
    const [first, second] = [await detailOf(h, 9000001), await detailOf(h, 9000002)];
    expect(first.siblings.map((s: { offer: { id: number } }) => s.offer.id)).toEqual([second.id]);
    expect(second.siblings.map((s: { offer: { id: number } }) => s.offer.id)).toEqual([first.id]);
    expect(first.cloned).toEqual([]);
  });

  it("links the same photos from a different Advertiser as a Cloned offer, never merging them", async () => {
    const h = bootOffers();
    ingestAds(
      h,
      { adId: 9000001, text: OTHER_ROOM_TEXT },
      { adId: 9000002, advertiser: marek, text: ROOM_TEXT_EDITED },
    );

    expect(await offersOf(h)).toHaveLength(2);
    const [original, copy] = [await detailOf(h, 9000001), await detailOf(h, 9000002)];
    expect(original.siblings).toEqual([]);
    expect(copy.cloned).toHaveLength(1);
    expect(copy.cloned[0]).toMatchObject({
      role: "copy",
      sharedImages: 3,
      offer: { id: original.id },
    });
    expect(original.cloned[0]).toMatchObject({ role: "original", offer: { id: copy.id } });
  });

  it("links near-identical text from a different Advertiser as a Cloned offer", async () => {
    const h = bootOffers();
    ingestAds(h, { adId: 9000001 }, { adId: 9000002, advertiser: marek, images: [photo(50)] });

    const copy = await detailOf(h, 9000002);
    expect(copy.cloned).toHaveLength(1);
    expect(copy.cloned[0].sharedImages).toBe(0);
    expect(copy.cloned[0].textSimilarity).toBe(1);
  });

  it("keeps a company's template text without a shared photo apart", async () => {
    const h = bootOffers();
    ingestAds(
      h,
      { adId: 9000001, advertiser: coliving, text: TEMPLATE_TEXT, images: [photo(60)] },
      { adId: 9000002, advertiser: coliving, text: TEMPLATE_TEXT, images: [photo(61)] },
    );

    expect(await offersOf(h)).toHaveLength(2);
    expect((await detailOf(h, 9000001)).cloned).toEqual([]);
  });

  it("merges a company's re-post whose photos were uploaded again under new hashes", async () => {
    const h = bootOffers();
    // The harness uploads each Ad ID's photos afresh: only their original names are shared.
    ingestAds(
      h,
      { adId: 9000001, advertiser: coliving, text: TEMPLATE_TEXT, images: [photo(60), photo(62)] },
      { adId: 9000002, advertiser: coliving, text: TEMPLATE_TEXT, images: [photo(62), photo(60)] },
    );

    expect(await offersOf(h)).toHaveLength(1);
  });

  it("ignores a photo name Ad IDs of several other Offers already show", async () => {
    const h = bootOffers();
    const stock = [photo(80), photo(81)];
    const jonas = { name: "Jonas", memberSince: "April 2025" };
    const lea = { name: "Lea", memberSince: "Juni 2025" };
    ingestAds(
      h,
      { adId: 9000001, images: stock },
      { adId: 9000002, advertiser: marek, text: OTHER_ROOM_TEXT, images: stock },
    );
    expect((await detailOf(h, 9000002)).cloned).toHaveLength(1);

    ingestAds(
      h,
      { adId: 9000003, advertiser: jonas, text: TEMPLATE_TEXT, images: stock },
      { adId: 9000004, advertiser: lea, text: HALF_ALIKE_TEXT, images: stock },
    );
    expect((await detailOf(h, 9000004)).cloned).toEqual([]);
  });

  it("keeps a borderline pair apart and unlinked", async () => {
    const h = bootOffers();
    ingestAds(h, { adId: 9000001 }, { adId: 9000002, images: [photo(70)], text: HALF_ALIKE_TEXT });

    expect(await offersOf(h)).toHaveLength(2);
    const offer = await detailOf(h, 9000001);
    expect(offer.siblings).toEqual([]);
    expect(offer.cloned).toEqual([]);
  });

  it("does not compare Ad IDs of different flats", async () => {
    const h = bootOffers();
    ingestAds(h, { adId: 9000001 }, { adId: 9000002, street: "Bahnhofstraße 3" });

    expect(await offersOf(h)).toHaveLength(2);
    expect((await detailOf(h, 9000001)).siblings).toEqual([]);
  });
});

describe("an exact re-post", () => {
  it("reuses the Offer's facts: the answer says no model pass is needed", async () => {
    const h = bootOffers();
    const title = "Helles Zimmer am Park";
    const [first, repost, edited] = ingestAds(
      h,
      { adId: 9000001, title, warmRent: 450 },
      { adId: 9000002, title, warmRent: 480 },
      { adId: 9000003, title, warmRent: 480, text: ROOM_TEXT_EDITED },
    );

    expect(first).toMatchObject({ outcome: "created", reusedFacts: false });
    expect(repost).toMatchObject({ outcome: "merged", reusedFacts: true });
    expect(edited).toMatchObject({ outcome: "merged", reusedFacts: false });
  });
});

describe("the page of an Ad ID that was stored before dedupe", () => {
  it("stays out of the comparison until its profile is read", async () => {
    const h = bootOffers();
    ingestAds(h, { adId: 9000001 });
    h.runtime.db.update(offerAds).set({ profile: null, category: null, postalCode: null }).run();

    ingestAds(h, { adId: 9000002 });

    expect(await offersOf(h)).toHaveLength(2);
  });
});
