import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { offerAds, offerLinks, offerPrices, offers } from "../src/db/schema.js";
import { adPage, ingestAds, OTHER_ROOM_TEXT, photo } from "./dedupe-harness.js";
import { bootOffers, MINUTE } from "./offers-harness.js";

type Harness = ReturnType<typeof bootOffers>;

const eqAd = (adId: string) => and(eq(offerAds.source, "wg-gesucht"), eq(offerAds.adId, adId));
const eqPriceAd = (adId: string) =>
  and(eq(offerPrices.source, "wg-gesucht"), eq(offerPrices.adId, adId));

function cutOut(h: Harness, adId: string, newOfferId: number): void {
  const { db } = h.runtime;
  const ad = db.select().from(offerAds).where(eqAd(adId)).get();
  const offer = ad && db.select().from(offers).where(eq(offers.id, ad.offerId)).get();
  if (!offer) throw new Error("expected an Offer");
  db.insert(offers)
    .values({ ...offer, id: newOfferId })
    .run();
  db.update(offerAds).set({ offerId: newOfferId }).where(eqAd(adId)).run();
  db.update(offerPrices).set({ offerId: newOfferId }).where(eqPriceAd(adId)).run();
}

// These Offers are ingested without a Search, so ranking calls them Untracked: list them all.
const offersOf = async (h: Harness) =>
  (await h.json("GET", "/offers?includeHidden=true")).body.items;
const detailOf = async (h: Harness, adId: number) =>
  (await h.json("GET", `/offers/lookup?adId=${adId}`)).body;
const adIds = (offer: { ads: { adId: string }[] }) => offer.ads.map((ad) => ad.adId);

/** Two rooms of one flat: dedupe keeps them apart and links them as Siblings. */
function twoRooms() {
  const h = bootOffers();
  ingestAds(
    h,
    { adId: 9000001, warmRent: 450, roomSize: 18 },
    { adId: 9000002, warmRent: 400, roomSize: 12, text: OTHER_ROOM_TEXT, images: [photo(40)] },
  );
  return h;
}

/** A room posted twice: dedupe collapses the second post into the first Offer. */
function repostedRoom() {
  const h = bootOffers();
  ingestAds(h, { adId: 9000001, warmRent: 450 }, { adId: 9000002, warmRent: 480 });
  return h;
}

describe("POST /offers/{id}/merge: 'same room'", () => {
  it("collapses the other Offer into this one, keeping every Ad ID and the price history", async () => {
    const h = twoRooms();
    const [first, second] = [await detailOf(h, 9000001), await detailOf(h, 9000002)];

    const merged = await h.json("POST", `/offers/${first.id}/merge`, { offerId: second.id });

    expect(merged.status).toBe(200);
    expect(merged.body.id).toBe(first.id);
    expect(adIds(merged.body)).toEqual(["9000001", "9000002"]);
    expect(merged.body.priceHistory.map((p: { warmRent: number }) => p.warmRent)).toEqual([
      450, 400,
    ]);
    expect(merged.body.siblings).toEqual([]);
    expect(await offersOf(h)).toHaveLength(1);
    expect((await h.json("GET", `/offers/${second.id}`)).status).toBe(404);
    expect((await detailOf(h, 9000002)).id).toBe(first.id);
  });

  it("keeps the earlier first-seen time and links to the most recently active Ad ID", async () => {
    const h = twoRooms();
    const [first, second] = [await detailOf(h, 9000001), await detailOf(h, 9000002)];

    const merged = (await h.json("POST", `/offers/${second.id}/merge`, { offerId: first.id })).body;

    expect(merged.id).toBe(second.id);
    expect(merged.firstSeenAt).toBe(first.firstSeenAt);
    expect(merged.url).toContain("9000002");
    expect(merged.keyFacts.warmRent.amount).toBe(400);
  });

  it("keeps the earliest Dismiss of either side, and a Dismiss only the other side had", async () => {
    const h = twoRooms();
    const [first, second] = [await detailOf(h, 9000001), await detailOf(h, 9000002)];
    h.clock.now += MINUTE;
    const earlier = new Date(h.clock.now).toISOString();
    await h.json("PATCH", `/offers/${second.id}/marks`, { dismissed: true });
    h.clock.now += MINUTE;
    await h.json("PATCH", `/offers/${first.id}/marks`, { dismissed: true });

    const merged = (await h.json("POST", `/offers/${first.id}/merge`, { offerId: second.id })).body;
    expect(merged.visibility.hidden).toContainEqual({
      cause: "dismissed",
      since: earlier,
      endsWhen: "undismissed",
    });

    const h2 = twoRooms();
    const [kept, gone] = [await detailOf(h2, 9000001), await detailOf(h2, 9000002)];
    h2.clock.now += MINUTE;
    const dismissedAt = new Date(h2.clock.now).toISOString();
    await h2.json("PATCH", `/offers/${gone.id}/marks`, { dismissed: true });
    h2.clock.now += MINUTE;

    const taken = (await h2.json("POST", `/offers/${kept.id}/merge`, { offerId: gone.id })).body;
    expect(taken.marks.dismissed).toBe(true);
    expect(taken.visibility.hidden).toContainEqual({
      cause: "dismissed",
      since: dismissedAt,
      endsWhen: "undismissed",
    });
  });

  it("answers the problems: itself, an unknown Offer", async () => {
    const h = twoRooms();
    const first = await detailOf(h, 9000001);

    expect((await h.json("POST", `/offers/${first.id}/merge`, { offerId: first.id })).status).toBe(
      400,
    );
    expect((await h.json("POST", `/offers/${first.id}/merge`, { offerId: 999 })).status).toBe(404);
    expect((await h.json("POST", "/offers/999/merge", { offerId: first.id })).status).toBe(404);
    expect((await h.json("POST", `/offers/${first.id}/merge`, {})).status).toBe(400);
  });

  it("names the Offer in the address when that is the one that does not exist", async () => {
    const h = twoRooms();
    const first = await detailOf(h, 9000001);

    const { status, body } = await h.json("POST", "/offers/999/merge", { offerId: first.id });

    expect(status).toBe(404);
    expect(body.type).toBe("not-found");
    expect(body.detail).toBe("There is no Offer with id 999.");
  });

  it("names the Offer in the body when that is the one that does not exist", async () => {
    const h = twoRooms();
    const first = await detailOf(h, 9000001);

    const { status, body } = await h.json("POST", `/offers/${first.id}/merge`, { offerId: 999 });

    expect(status).toBe(404);
    expect(body.type).toBe("not-found");
    expect(body.detail).toBe("There is no Offer with id 999.");
  });

  it("names the Offer in the address when neither exists", async () => {
    const h = twoRooms();

    const { status, body } = await h.json("POST", "/offers/998/merge", { offerId: 999 });

    expect(status).toBe(404);
    expect(body.detail).toBe("There is no Offer with id 998.");
  });

  it("points at the room of a side that was merged away, in the address or in the body", async () => {
    const h = twoRooms();
    const [first, second] = [await detailOf(h, 9000001), await detailOf(h, 9000002)];
    await h.json("POST", `/offers/${first.id}/merge`, { offerId: second.id });
    const merged = {
      type: "offer-merged",
      detail: `Offer ${second.id} was merged into Offer ${first.id}: read that one.`,
      mergedInto: first.id,
    };

    const again = await h.json("POST", `/offers/${first.id}/merge`, { offerId: second.id });
    expect(again.status).toBe(404);
    expect(again.body).toMatchObject(merged);

    const fromGone = await h.json("POST", `/offers/${second.id}/merge`, { offerId: first.id });
    expect(fromGone.status).toBe(404);
    expect(fromGone.body).toMatchObject(merged);

    const neither = await h.json("POST", "/offers/999/merge", { offerId: second.id });
    expect(neither.body).toMatchObject({
      type: "not-found",
      detail: "There is no Offer with id 999.",
    });
  });

  it("lets a later re-post of either Ad ID join the merged Offer", async () => {
    const h = twoRooms();
    const [first, second] = [await detailOf(h, 9000001), await detailOf(h, 9000002)];
    await h.json("POST", `/offers/${first.id}/merge`, { offerId: second.id });

    ingestAds(h, { adId: 9000003, roomSize: 12, text: OTHER_ROOM_TEXT, images: [photo(40)] });

    expect(await offersOf(h)).toHaveLength(1);
    expect(adIds(await detailOf(h, 9000003)).sort()).toEqual(["9000001", "9000002", "9000003"]);
  });
});

describe("POST /offers/{id}/split: 'not the same room'", () => {
  it("makes an Offer of its own of the Ad ID, taking its price points with it", async () => {
    const h = repostedRoom();
    const before = await detailOf(h, 9000001);
    expect(adIds(before)).toEqual(["9000001", "9000002"]);

    const split = await h.json("POST", `/offers/${before.id}/split`, { adId: "9000001" });

    expect(split.status).toBe(201);
    expect(split.body.id).not.toBe(before.id);
    expect(adIds(split.body)).toEqual(["9000001"]);
    expect(split.body.priceHistory.map((p: { warmRent: number }) => p.warmRent)).toEqual([450]);
    const rest = await detailOf(h, 9000002);
    expect(rest.id).toBe(before.id);
    expect(adIds(rest)).toEqual(["9000002"]);
    expect(rest.priceHistory.map((p: { warmRent: number }) => p.warmRent)).toEqual([480]);
    expect(rest.firstSeenAt).toBe(rest.ads[0].firstSeenAt);
    expect(await offersOf(h)).toHaveLength(2);
  });

  it("announces the new Offer like any other", async () => {
    const h = repostedRoom();
    const before = await detailOf(h, 9000001);
    const added = h.events.filter((event) => event.type === "offer-added").length;

    const split = await h.json("POST", `/offers/${before.id}/split`, { adId: "9000002" });

    const events = h.events.filter((event) => event.type === "offer-added");
    expect(events).toHaveLength(added + 1);
    expect(events.at(-1)?.data).toMatchObject({ id: split.body.id });
  });

  it("answers the problems: an Ad ID that is not in the Offer, an Offer with one Ad ID", async () => {
    const h = repostedRoom();
    const other = twoRooms();
    const room = await detailOf(h, 9000001);
    const single = await detailOf(other, 9000001);

    expect((await h.json("POST", `/offers/${room.id}/split`, { adId: "123" })).status).toBe(404);
    const only = await other.json("POST", `/offers/${single.id}/split`, { adId: "9000001" });
    expect(only.status).toBe(409);
    expect(only.body.type).toBe("offer-has-one-ad");
    expect((await h.json("POST", "/offers/999/split", { adId: "9000001" })).status).toBe(404);
    expect((await h.json("POST", `/offers/${room.id}/split`, {})).status).toBe(400);
  });
});

describe("the overrides survive later dedupe passes", () => {
  it("keeps a split apart, though the rules still call the two Ad IDs a Duplicate", async () => {
    const h = repostedRoom();
    const room = await detailOf(h, 9000001);
    await h.json("POST", `/offers/${room.id}/split`, { adId: "9000001" });

    expect(h.runtime.offers.dedupePass()).toBe(0);

    expect(await offersOf(h)).toHaveLength(2);
    expect(adIds(await detailOf(h, 9000001))).toEqual(["9000001"]);
  });

  it("keeps a split apart when a third post of the room arrives", async () => {
    const h = repostedRoom();
    const room = await detailOf(h, 9000001);
    await h.json("POST", `/offers/${room.id}/split`, { adId: "9000001" });

    const [third] = ingestAds(h, { adId: 9000003, warmRent: 500 });

    expect(third?.outcome).toBe("merged");
    expect(await offersOf(h)).toHaveLength(2);
    expect(h.runtime.offers.dedupePass()).toBe(0);
    expect(await offersOf(h)).toHaveLength(2);
  });

  it("keeps a merge together through a pass", async () => {
    const h = twoRooms();
    const [first, second] = [await detailOf(h, 9000001), await detailOf(h, 9000002)];
    await h.json("POST", `/offers/${first.id}/merge`, { offerId: second.id });

    h.runtime.offers.dedupePass();

    expect(await offersOf(h)).toHaveLength(1);
    expect(adIds(await detailOf(h, 9000001))).toEqual(["9000001", "9000002"]);
  });

  it("merges what a merge override says is one room, though the rules keep it apart", async () => {
    const h = twoRooms();
    const [first, second] = [await detailOf(h, 9000001), await detailOf(h, 9000002)];
    await h.json("POST", `/offers/${first.id}/merge`, { offerId: second.id });
    cutOut(h, "9000002", 99);
    expect(await offersOf(h)).toHaveLength(2);

    expect(h.runtime.offers.dedupePass()).toBe(1);

    expect(await offersOf(h)).toHaveLength(1);
  });
});

describe("a pass over Offers stored before dedupe", () => {
  it("reads the profiles of their pages, then collapses the Duplicates", async () => {
    const h = bootOffers();
    h.site.cards = h.freshCards([9000001, 9000002]);
    h.site.pages.set(9000001, adPage({ adId: 9000001, warmRent: 450 }));
    h.site.pages.set(9000002, adPage({ adId: 9000002, warmRent: 480 }));
    await h.addSearch();
    await h.crawl();
    expect(await offersOf(h)).toHaveLength(1);

    // Back to how a build without dedupe left them: two Offers whose Ad IDs have no profile.
    const { db } = h.runtime;
    const offer = db.select().from(offers).get();
    if (!offer) throw new Error("expected an Offer");
    cutOut(h, "9000002", 50);
    db.update(offerAds).set({ profile: null, category: null, postalCode: null }).run();
    db.delete(offerLinks).run();
    expect(await offersOf(h)).toHaveLength(2);
    expect(h.runtime.offers.dedupePass()).toBe(0);

    expect(await h.runtime.offers.backfillProfiles()).toMatchObject({ done: 2 });
    expect(h.runtime.offers.dedupePass()).toBe(1);

    const merged = await offersOf(h);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe(offer.id);
    expect(adIds(await detailOf(h, 9000001))).toEqual(["9000001", "9000002"]);
    expect(await h.runtime.offers.backfillProfiles()).toMatchObject({ done: 0 });
  });

  it("reads again the profiles stored in an older format, so their photo keys match", async () => {
    const h = bootOffers();
    h.site.cards = h.freshCards([9000001]);
    h.site.pages.set(9000001, adPage({ adId: 9000001 }));
    await h.addSearch();
    await h.crawl();

    // Back to how a build before photo keys left it: the photos stored as upload hashes.
    const { db } = h.runtime;
    const stored = db.select().from(offerAds).where(eqAd("9000001")).get();
    if (!stored?.profile) throw new Error("expected a profile");
    const { format: _, ...older } = JSON.parse(stored.profile) as Record<string, unknown>;
    db.update(offerAds)
      .set({ profile: JSON.stringify({ ...older, images: ["a".repeat(64)] }) })
      .where(eqAd("9000001"))
      .run();

    expect(await h.runtime.offers.backfillProfiles()).toMatchObject({ done: 1 });
    const reread = db.select().from(offerAds).where(eqAd("9000001")).get();
    const profile = JSON.parse(reread?.profile ?? "null") as { images: string[] };
    expect(profile.images).toContain(photo(1).toLowerCase().replaceAll("_", " "));
    expect(await h.runtime.offers.backfillProfiles()).toMatchObject({ done: 0 });
  });

  it("is done by the server on start", async () => {
    const first = bootOffers();
    first.site.cards = first.freshCards([9000001]);
    first.site.pages.set(9000001, adPage({ adId: 9000001 }));
    await first.addSearch();
    await first.crawl();
    first.runtime.db
      .update(offerAds)
      .set({ profile: null, category: null, postalCode: null })
      .run();
    first.runtime.close();

    const restarted = bootOffers({ dataDir: first.dataDir });
    await restarted.runtime.catchUp;

    expect(restarted.runtime.db.select().from(offerAds).get()?.postalCode).toBe("12345");
  });
});

describe("a crawl", () => {
  it("collapses a Bumped-and-reposted room found under two Ad IDs into one Offer", async () => {
    const h = bootOffers();
    h.site.cards = [
      { id: 9000002, age: "5 Min.", title: "Zimmer am Park" },
      { id: 9000001, age: "3 Tage", title: "Zimmer am Park" },
    ];
    h.site.pages.set(9000001, adPage({ adId: 9000001, title: "Zimmer am Park", warmRent: 450 }));
    h.site.pages.set(9000002, adPage({ adId: 9000002, title: "Zimmer am Park", warmRent: 450 }));
    await h.addSearch();
    await h.crawl(2 * 60 * MINUTE);

    const items = await offersOf(h);
    expect(items).toHaveLength(1);
    const offer = await detailOf(h, 9000001);
    expect(adIds(offer)).toEqual(["9000001", "9000002"]);
    expect(offer.url).toContain("9000002");
    expect(h.events.filter((event) => event.type === "offer-added")).toHaveLength(1);
  });
});
