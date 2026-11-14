import { utimesSync } from "node:fs";
import { join } from "node:path";
import { wgGesuchtSource } from "@wg-hunt/core/sources/wg-gesucht";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createOfferReader } from "../src/analysis/read-offer.js";
import type { FetchedOffer } from "../src/crawl/search-polls.js";
import { createSnapshotStore } from "../src/crawl/snapshots.js";
import { offerAds, offers, seenAds } from "../src/db/schema.js";
import { type AdSpec, fetchedAd, OTHER_ROOM_TEXT, ROOM_TEXT_EDITED } from "./dedupe-harness.js";
import { bootOffers, MINUTE } from "./offers-harness.js";
import { DAY, snapshotExists } from "./retention-harness.js";

type Harness = ReturnType<typeof bootOffers>;

function storeAds(h: Harness, ...specs: AdSpec[]) {
  const snapshots = createSnapshotStore(h.dataDir);
  return specs.map((spec, index) => {
    const fetched = fetchedAd(h, spec, index * 10 * MINUTE);
    snapshots.write(fetched.source, fetched.adId, fetched.html);
    h.runtime.db
      .insert(seenAds)
      .values({
        source: fetched.source,
        adId: fetched.adId,
        firstSeenAt: new Date(fetched.fetchedAt),
        lastSeenAt: new Date(fetched.fetchedAt),
        category: fetched.category,
        card: JSON.stringify(fetched.card),
        detailState: "fetched",
        detailFetchedAt: new Date(fetched.fetchedAt),
      })
      .run();
    return h.runtime.offers.ingest(fetched);
  });
}

function readAgain(h: Harness, spec: AdSpec, status: "deactivated" | "deleted") {
  h.clock.now += 60 * MINUTE;
  const fetched = fetchedAd(h, spec);
  const parsed: FetchedOffer["parsed"] =
    status === "deleted"
      ? { outcome: "parsed", status: "deleted", rulesVersion: fetched.parsed.rulesVersion }
      : { ...(fetched.parsed as Extract<FetchedOffer["parsed"], { text: unknown }>), status };
  return h.runtime.offers.ingest({ ...fetched, parsed });
}

const detailOf = async (h: Harness, id: number) => (await h.json("GET", `/offers/${id}`)).body;
const currentOf = (offer: { ads: { adId: string; current: boolean }[] }) =>
  offer.ads.find((ad) => ad.current)?.adId;

const A: AdSpec = { adId: 9000001, warmRent: 450, title: "Zimmer A" };
const B: AdSpec = { adId: 9000002, warmRent: 480, title: "Zimmer B", text: ROOM_TEXT_EDITED };

describe("the current Ad ID", () => {
  it("is the most recently active one: a newer deactivated Ad ID is not current", async () => {
    const h = bootOffers();
    const [first] = storeAds(h, A, B);
    const id = first?.offerId as number;
    expect(currentOf(await detailOf(h, id))).toBe("9000002");

    readAgain(h, B, "deactivated");

    const offer = await detailOf(h, id);
    expect(currentOf(offer)).toBe("9000001");
    expect(offer.url).toContain("9000001");
    expect(h.runtime.offers.analysisJob(id)?.adId).toBe("9000001");
  });

  it("is a deactivated one only when no Ad ID is active", async () => {
    const h = bootOffers();
    const [first] = storeAds(h, A, B);
    const id = first?.offerId as number;
    readAgain(h, A, "deactivated");
    readAgain(h, B, "deactivated");
    expect(currentOf(await detailOf(h, id))).toBe("9000002");

    readAgain(h, B, "deleted");
    expect(currentOf(await detailOf(h, id))).toBe("9000001");
  });
});

describe("losing the current Ad ID", () => {
  it("re-reads the Offer's facts, title and card from the new current page when the page is deleted", async () => {
    const h = bootOffers();
    const [first] = storeAds(h, A, B);
    const id = first?.offerId as number;
    const before = await detailOf(h, id);
    expect(before.title).toBe("Zimmer B");
    expect(before.keyFacts.warmRent.amount).toBe(480);

    readAgain(h, B, "deleted");

    const offer = await detailOf(h, id);
    expect(currentOf(offer)).toBe("9000001");
    expect(offer.title).toBe("Zimmer A");
    expect(offer.keyFacts.warmRent.amount).toBe(450);
    const row = h.runtime.db.select().from(offers).where(eq(offers.id, id)).get();
    expect(JSON.parse(row?.card ?? "{}").adId).toBe("9000001");
    expect(offer.priceHistory.at(-1)).toMatchObject({ adId: "9000001", warmRent: 450 });
  });

  it("re-reads them when the page is deactivated", async () => {
    const h = bootOffers();
    const [first] = storeAds(h, A, B);
    const id = first?.offerId as number;

    readAgain(h, B, "deactivated");

    const offer = await detailOf(h, id);
    expect(offer.title).toBe("Zimmer A");
    expect(offer.keyFacts.warmRent.amount).toBe(450);
  });

  it("re-reads them when a Bump makes an older Ad ID current", async () => {
    const h = bootOffers();
    const [first] = storeAds(h, A, B);
    const id = first?.offerId as number;
    h.clock.now += 2 * 60 * MINUTE;
    const card = fetchedAd(h, A).card;

    h.runtime.offers.noteSighting({
      source: "wg-gesucht",
      adId: "9000001",
      card,
      bumped: true,
      lastBumpAt: h.clock.now - MINUTE,
    });

    const offer = await detailOf(h, id);
    expect(currentOf(offer)).toBe("9000001");
    expect(offer.title).toBe("Zimmer A");
    expect(offer.keyFacts.warmRent.amount).toBe(450);
  });

  it("does not send the Offer back to the model pass when the new current page has the same words", async () => {
    const h = bootOffers();
    const same: AdSpec = { ...A, adId: 9000002, warmRent: 480 };
    const [first] = storeAds(h, A, same);
    const id = first?.offerId as number;
    const job = h.runtime.offers.analysisJob(id);
    h.runtime.db
      .update(offers)
      .set({
        analysisState: "analyzed",
        analysis: JSON.stringify({ run: { contentHash: job?.contentHash } }),
      })
      .where(eq(offers.id, id))
      .run();

    readAgain(h, same, "deleted");

    expect(h.runtime.offers.analysisJob(id)).toMatchObject({
      adId: "9000001",
      wordsChanged: false,
    });
  });

  it("sends it back with the facts of the page that will be read when the words differ", async () => {
    const h = bootOffers();
    const other = { ...B, text: OTHER_ROOM_TEXT };
    const [first] = storeAds(h, A, other);
    const id = first?.offerId as number;
    if (first?.outcome !== "created") throw new Error("expected a new Offer");

    readAgain(h, B, "deleted");

    const job = h.runtime.offers.analysisJob(id);
    const offer = await detailOf(h, id);
    expect(job?.adId).toBe(currentOf(offer));
    expect(offer.title).toBe("Zimmer A");
  });
});

describe("an Offer stored by a build that picked its current Ad ID differently", () => {
  it("takes its facts, title, card and rent from the current page when the server starts", async () => {
    const first = bootOffers();
    const [stored] = storeAds(first, A, B);
    const id = stored?.offerId as number;
    first.runtime.db
      .update(offerAds)
      .set({ pageStatus: "deactivated" })
      .where(eq(offerAds.adId, "9000002"))
      .run();
    first.runtime.close();

    const restarted = bootOffers({ dataDir: first.dataDir, start: first.clock.now + 60 * MINUTE });
    await restarted.runtime.catchUp;

    const offer = await detailOf(restarted, id);
    expect(offer.title).toBe("Zimmer A");
    expect(currentOf(offer)).toBe("9000001");
    expect(offer.keyFacts.warmRent.amount).toBe(450);
    expect(offer.priceHistory.at(-1)).toMatchObject({ adId: "9000001", warmRent: 450 });
    const row = restarted.runtime.db.select().from(offers).where(eq(offers.id, id)).get();
    expect(JSON.parse(row?.card ?? "{}").adId).toBe("9000001");
    expect(restarted.runtime.offers.analysisJob(id)?.adId).toBe("9000001");
  });
});

describe("the rent an Offer takes from an older stored page", () => {
  it("is dated by that page, not by the restart, and stays the last point", async () => {
    const first = bootOffers();
    const [stored] = storeAds(first, A, B);
    const id = stored?.offerId as number;
    const stopped = first.clock.now;
    first.runtime.db
      .update(offerAds)
      .set({ pageStatus: "deactivated" })
      .where(eq(offerAds.adId, "9000002"))
      .run();
    first.runtime.close();

    const restarted = bootOffers({ dataDir: first.dataDir, start: stopped + 2 * DAY });
    await restarted.runtime.catchUp;
    const history = (await detailOf(restarted, id)).priceHistory;
    expect(history.at(-1)).toMatchObject({ adId: "9000001", warmRent: 450 });
    // A's page was read before B's, whose point is the latest: the new point goes right after it.
    expect(Date.parse(history.at(-1).observedAt)).toBe(stopped + 10 * MINUTE);
  });

  it("is dated by that page when the current one is deleted", async () => {
    const h = bootOffers();
    const [first] = storeAds(h, A, B);
    const id = first?.offerId as number;
    const stored = h.clock.now;
    h.clock.now += 3 * DAY;

    readAgain(h, B, "deleted");

    const history = (await detailOf(h, id)).priceHistory;
    expect(history.at(-1)).toMatchObject({ adId: "9000001", warmRent: 450 });
    expect(Date.parse(history.at(-1).observedAt)).toBe(stored + 10 * MINUTE);
  });
});

describe("pages stored but not yet made into Offers", () => {
  async function unadopted() {
    const h = bootOffers();
    h.site.cards = h.freshCards([9000001]);
    await h.addSearch();
    await h.crawl();
    h.runtime.db.delete(offers).run();
    h.runtime.db.update(seenAds).set({ ingestedAt: null }).run();
    return h;
  }

  it("keeps the page through a prune, however old, until it is adopted", async () => {
    const h = await unadopted();
    h.clock.now += 40 * DAY;
    const file = join(h.dataDir, "offer-pages", "wg-gesucht", "9000001.html.gz");
    const old = new Date(h.clock.now - 40 * DAY);
    utimesSync(file, old, old);

    h.runtime.retention.prune();
    expect(snapshotExists(h, "9000001")).toBe(true);

    expect(await h.runtime.offers.adoptStoredPages()).toMatchObject({ done: 1 });
    expect((await h.json("GET", "/offers?includeHidden=true")).body.items).toHaveLength(1);
  });

  it("settles a page that is gone from the data folder as a failed fetch, so it is not left for ever", async () => {
    const h = await unadopted();
    const { rmSync } = await import("node:fs");
    rmSync(join(h.dataDir, "offer-pages", "wg-gesucht", "9000001.html.gz"));

    expect(await h.runtime.offers.adoptStoredPages()).toMatchObject({ done: 0, skipped: 1 });

    const row = h.runtime.db.select().from(seenAds).where(eq(seenAds.adId, "9000001")).get();
    expect(row?.detailState).toBe("failed");
    expect(row?.ingestedAt).toBeNull();
  });

  it("settles a page the rules can't read, so the prune can remove it and it is not retried at every boot", async () => {
    const h = await unadopted();
    createSnapshotStore(h.dataDir).write("wg-gesucht", "9000001", "<html>not an Offer</html>");

    expect(await h.runtime.offers.adoptStoredPages()).toMatchObject({ done: 0, skipped: 1 });
    const row = h.runtime.db.select().from(seenAds).where(eq(seenAds.adId, "9000001")).get();
    expect(row?.detailState).toBe("failed");

    h.clock.now += 40 * DAY;
    const file = join(h.dataDir, "offer-pages", "wg-gesucht", "9000001.html.gz");
    const old = new Date(h.clock.now - 40 * DAY);
    utimesSync(file, old, old);
    h.runtime.retention.prune();
    expect(snapshotExists(h, "9000001")).toBe(false);
  });

  it("keeps an Offer's Ad ID fetched when its page read again is gone, so a Recheck can still read it", async () => {
    const h = bootOffers();
    h.site.cards = h.freshCards([9000001]);
    await h.addSearch();
    await h.crawl();
    h.runtime.db.update(seenAds).set({ ingestedAt: null }).run();
    const { rmSync } = await import("node:fs");
    rmSync(join(h.dataDir, "offer-pages", "wg-gesucht", "9000001.html.gz"));

    expect(await h.runtime.offers.adoptStoredPages()).toMatchObject({ done: 0, skipped: 1 });
    const row = h.runtime.db.select().from(seenAds).where(eq(seenAds.adId, "9000001")).get();
    expect(row?.detailState).toBe("fetched");
    expect(row?.ingestedAt).not.toBeNull();
    expect((await h.json("GET", "/offers?includeHidden=true")).body.items).toHaveLength(1);
  });
});

describe('a merged Offer whose current page says "frei ab: sofort"', () => {
  const SEPTEMBER = Date.parse("2026-09-01T10:00:00Z");
  const NOVEMBER = Date.parse("2026-11-01T10:00:00Z");

  function mergedRepost() {
    const h = bootOffers({ start: SEPTEMBER });
    const [first] = storeAds(h, A);
    h.clock.now = NOVEMBER;
    const [second] = storeAds(h, { ...B, availableFrom: "sofort" });
    expect(second?.outcome).toBe("merged");
    return { h, id: first?.offerId as number };
  }

  it("is available from the current Ad ID's first day after a rules re-parse", async () => {
    const { h, id } = mergedRepost();
    expect((await detailOf(h, id)).facts.availableFrom.value).toBe("2026-11-01");

    h.runtime.db.update(offers).set({ rulesVersion: 0 }).where(eq(offers.id, id)).run();
    await h.runtime.offers.reparseOutdated();

    const offer = await detailOf(h, id);
    expect(offer.rulesVersion).toBeGreaterThan(0);
    expect(offer.facts.availableFrom.value).toBe("2026-11-01");
  });

  it("hands the model pass rule facts from the current Ad ID's first day", () => {
    const { h, id } = mergedRepost();
    const job = h.runtime.offers.analysisJob(id);
    expect(job).toMatchObject({ adId: "9000002", adFirstSeenAt: new Date(NOVEMBER) });

    const reader = createOfferReader({
      adapters: { "wg-gesucht": wgGesuchtSource },
      snapshots: createSnapshotStore(h.dataDir),
    });
    const read = job && reader.read(job);
    expect(typeof read === "object" && read.facts.availableFrom?.value).toBe("2026-11-01");
  });
});
