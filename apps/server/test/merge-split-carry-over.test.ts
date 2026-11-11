import type { ModelFacts } from "@wg-hunt/core";
import { wgGesuchtSource } from "@wg-hunt/core/sources/wg-gesucht";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { AnalysisRun, OwedEscalation } from "../src/analysis/record.js";
import { offerAds, offerPairOverrides, offers } from "../src/db/schema.js";
import { type AdSpec, adPage, ingestAds, OTHER_ROOM_TEXT, photo } from "./dedupe-harness.js";
import { bootOffers, MINUTE } from "./offers-harness.js";

type Harness = ReturnType<typeof bootOffers>;

const eqAd = (adId: string) => and(eq(offerAds.source, "wg-gesucht"), eq(offerAds.adId, adId));
const detailOf = async (h: Harness, adId: number) =>
  (await h.json("GET", `/offers/lookup?adId=${adId}`)).body;
const rowOf = (h: Harness, id: number) =>
  h.runtime.db.select().from(offers).where(eq(offers.id, id)).get();
const setRow = (h: Harness, id: number, values: Partial<typeof offers.$inferInsert>) =>
  h.runtime.db.update(offers).set(values).where(eq(offers.id, id)).run();

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

/** The reposted room, found by a Search: Tracked, so its band shows its marks. */
async function trackedRepost() {
  const h = bootOffers();
  h.site.cards = h.freshCards([9000001, 9000002]);
  h.site.pages.set(9000001, adPage({ adId: 9000001, warmRent: 450 }));
  h.site.pages.set(9000002, adPage({ adId: 9000002, warmRent: 480 }));
  await h.addSearch();
  await h.crawl();
  return h;
}

function ingestStored(h: Harness, ...specs: AdSpec[]) {
  for (const spec of specs)
    h.runtime.snapshots.write("wg-gesucht", String(spec.adId), adPage(spec));
  return ingestAds(h, ...specs);
}

const run = (contentHash: string | null): AnalysisRun => ({
  model: "claude-haiku-5-5",
  effort: "low",
  escalation: null,
  escalated: false,
  analyzedAt: new Date(0).toISOString(),
  contentHash,
  log: [],
});
/** What the model read, told apart by the minimum stay. */
const read = (months: number) =>
  ({
    anmeldung: { value: "unknown", origin: "model", quote: "" },
    minimumStay: { value: months, origin: "model", quote: "" },
    scamSignals: [],
    conflicts: [],
  }) as unknown as ModelFacts;
const adHash = (h: Harness, adId: string) =>
  h.runtime.db.select().from(offerAds).where(eqAd(adId)).get()?.contentHash ?? null;

describe("a split keeps the seeker's marks (B8)", () => {
  it("gives the split-off Offer the marks, the scam mark and the creation time of the Offer it left", async () => {
    const h = repostedRoom();
    const room = await detailOf(h, 9000001);
    await h.json("PATCH", `/offers/${room.id}/marks`, {
      dismissed: true,
      contacted: true,
      scam: "scam",
    });
    h.clock.now += 60 * MINUTE;

    const split = await h.json("POST", `/offers/${room.id}/split`, { adId: "9000001" });

    expect(split.status).toBe(201);
    expect(split.body.marks).toEqual({ dismissed: true, shortlisted: false, contacted: true });
    expect(rowOf(h, split.body.id)?.scamMark).toBe("scam");
    expect(split.body.createdAt).toBe(room.createdAt);
    const rest = await detailOf(h, 9000002);
    expect(rest.marks).toEqual({ dismissed: true, shortlisted: false, contacted: true });
  });

  it("keeps the band the room was in, so a Dismissed room does not come back as a match", async () => {
    const h = await trackedRepost();
    const room = await detailOf(h, 9000001);
    await h.json("PATCH", `/offers/${room.id}/marks`, { dismissed: true });
    const moved = h.events.filter((e) => e.type === "offer-band-changed").length;

    const split = await h.json("POST", `/offers/${room.id}/split`, { adId: "9000001" });

    expect(split.body.band).toBe("hidden");
    expect(rowOf(h, split.body.id)?.band).toBe("hidden");
    expect(h.events.filter((e) => e.type === "offer-band-changed")).toHaveLength(moved);
  });

  it("leaves the fact corrections with the room that stays", async () => {
    const h = repostedRoom();
    const room = await detailOf(h, 9000001);
    await h.json("PUT", `/offers/${room.id}/facts/roomSize`, { value: 20 });

    const split = await h.json("POST", `/offers/${room.id}/split`, { adId: "9000001" });

    expect(split.body.overrides).toEqual([]);
    expect((await detailOf(h, 9000002)).overrides).toHaveLength(1);
  });
});

describe("a merge declares what it carries over (B9)", () => {
  it("keeps a scam mark from either side, over a 'not a scam' on the survivor", async () => {
    const h = twoRooms();
    const [first, second] = [await detailOf(h, 9000001), await detailOf(h, 9000002)];
    await h.json("PATCH", `/offers/${first.id}/marks`, { scam: "not" });
    await h.json("PATCH", `/offers/${second.id}/marks`, { scam: "scam" });

    await h.json("POST", `/offers/${first.id}/merge`, { offerId: second.id });

    expect(rowOf(h, first.id)?.scamMark).toBe("scam");
  });

  it("keeps the retention clocks running only when the whole room was quiet, from the later one", async () => {
    const h = twoRooms();
    const [first, second] = [await detailOf(h, 9000001), await detailOf(h, 9000002)];
    const [early, late] = [new Date(1_000), new Date(2_000)];
    setRow(h, first.id, { quietSince: early, recordClockSince: late });
    setRow(h, second.id, { quietSince: late, recordClockSince: early });

    await h.json("POST", `/offers/${first.id}/merge`, { offerId: second.id });

    expect(rowOf(h, first.id)).toMatchObject({ quietSince: late, recordClockSince: late });
  });

  it("stops a clock when one side was not quiet or was kept", async () => {
    const h = twoRooms();
    const [first, second] = [await detailOf(h, 9000001), await detailOf(h, 9000002)];
    setRow(h, first.id, { quietSince: new Date(1_000), recordClockSince: new Date(1_000) });
    setRow(h, second.id, { quietSince: new Date(2_000), recordClockSince: null });

    await h.json("POST", `/offers/${second.id}/merge`, { offerId: first.id });

    expect(rowOf(h, second.id)).toMatchObject({
      quietSince: new Date(2_000),
      recordClockSince: null,
    });
  });

  it("takes the absorbed Offer's analysis along with its page, instead of paying for it again", async () => {
    const h = twoRooms();
    const [first, second] = [await detailOf(h, 9000001), await detailOf(h, 9000002)];
    // The second Ad ID is the most recently active: its page becomes the merged Offer's.
    h.runtime.offers.saveAnalysis(first.id, read(0), run(adHash(h, "9000001")));
    h.runtime.offers.saveAnalysis(second.id, read(12), run(adHash(h, "9000002")));

    await h.json("POST", `/offers/${first.id}/merge`, { offerId: second.id });

    const merged = rowOf(h, first.id);
    expect(merged?.analysisState).toBe("analyzed");
    expect(merged?.modelFacts).toBe(JSON.stringify(read(12)));
    expect(h.runtime.offers.analysisJob(first.id)?.wordsChanged).toBe(false);
  });

  it("keeps its own analysis when its own page stays the Offer's", async () => {
    const h = twoRooms();
    const [first, second] = [await detailOf(h, 9000001), await detailOf(h, 9000002)];
    h.runtime.offers.saveAnalysis(first.id, read(18), run(adHash(h, "9000001")));
    h.runtime.offers.saveAnalysis(second.id, read(12), run(adHash(h, "9000002")));

    await h.json("POST", `/offers/${second.id}/merge`, { offerId: first.id });

    expect(rowOf(h, second.id)?.modelFacts).toBe(JSON.stringify(read(12)));
  });

  it("gives a split-off Ad ID the analysis of its own words", async () => {
    const h = twoRooms();
    const [first, second] = [await detailOf(h, 9000001), await detailOf(h, 9000002)];
    h.runtime.offers.saveAnalysis(second.id, read(12), run(adHash(h, "9000002")));
    await h.json("POST", `/offers/${first.id}/merge`, { offerId: second.id });

    const split = await h.json("POST", `/offers/${first.id}/split`, { adId: "9000002" });

    expect(rowOf(h, split.body.id)).toMatchObject({
      analysisState: "analyzed",
      modelFacts: JSON.stringify(read(12)),
    });
    expect(h.runtime.offers.analysisJob(first.id)?.wordsChanged).toBe(true);
  });
});

describe("a merge of two Offers that have both read the words it shows", () => {
  /** One room posted twice with the same words and split; the second post's page is the current one. */
  async function sameWordsSplit() {
    const h = bootOffers();
    const words = { title: "Zimmer in Mitte", text: OTHER_ROOM_TEXT };
    ingestAds(h, { adId: 9000001, ...words }, { adId: 9000002, ...words });
    const first = (await detailOf(h, 9000001)).id as number;
    const second = (await h.json("POST", `/offers/${first}/split`, { adId: "9000002" })).body
      .id as number;
    const hash = adHash(h, "9000001");
    expect(hash).not.toBe(null);
    expect(adHash(h, "9000002")).toBe(hash);
    return { h, first, second, hash: hash as string };
  }

  const owed = (hash: string): OwedEscalation => ({
    carry: {} as OwedEscalation["carry"],
    plan: { model: { model: "claude-haiku-5-5", effort: "low" }, escalation: null },
    contentHash: hash,
  });

  for (const pageTakesOver of [true, false]) {
    const into = pageTakesOver ? "the Offer whose page goes" : "the Offer whose page stays";
    const sides = async () => {
      const split = await sameWordsSplit();
      const [survivor, absorbed] = pageTakesOver
        ? [split.first, split.second]
        : [split.second, split.first];
      return { ...split, survivor, absorbed, page: split.second, other: split.first };
    };

    it(`keeps the final result over the page side's first pass, merged into ${into}`, async () => {
      const { h, survivor, absorbed, page, other, hash } = await sides();
      h.runtime.offers.saveAnalysis(page, read(1), run(hash), owed(hash));
      h.runtime.offers.saveAnalysis(other, read(2), run(hash));

      await h.json("POST", `/offers/${survivor}/merge`, { offerId: absorbed });

      expect(rowOf(h, survivor)?.modelFacts).toBe(JSON.stringify(read(2)));
      expect(h.runtime.offers.analysisJob(survivor)?.escalation).toBe(null);
    });

    it(`keeps the escalated result over the page side's final one, merged into ${into}`, async () => {
      const { h, survivor, absorbed, page, other, hash } = await sides();
      h.runtime.offers.saveAnalysis(page, read(1), run(hash));
      h.runtime.offers.saveAnalysis(other, read(2), { ...run(hash), escalated: true });

      await h.json("POST", `/offers/${survivor}/merge`, { offerId: absorbed });

      expect(rowOf(h, survivor)?.modelFacts).toBe(JSON.stringify(read(2)));
    });
  }

  for (const pageTakesOver of [true, false]) {
    const into = pageTakesOver ? "the Offer whose page goes" : "the Offer whose page stays";
    it(`keeps the page side's failure over an escalated result for other words, merged into ${into}`, async () => {
      const h = twoRooms();
      const [other, page] = [(await detailOf(h, 9000001)).id, (await detailOf(h, 9000002)).id];
      h.runtime.offers.failAnalysis(page, "invalid_response");
      h.runtime.offers.saveAnalysis(other, read(2), {
        ...run(adHash(h, "9000001")),
        escalated: true,
      });
      const [survivor, absorbed] = pageTakesOver ? [other, page] : [page, other];

      await h.json("POST", `/offers/${survivor}/merge`, { offerId: absorbed });

      const merged = rowOf(h, survivor);
      expect(merged).toMatchObject({ analysisState: "failed", modelFacts: null });
      expect(h.runtime.offers.analysisJob(survivor)?.failure).toMatchObject({
        kind: "invalid_response",
        attempts: 1,
        contentHash: adHash(h, "9000002"),
      });
    });
  }
});

describe("an absorbed Offer leaves a tombstone", () => {
  it("answers its old id with a pointer to the Offer it went into", async () => {
    const h = twoRooms();
    const [first, second] = [await detailOf(h, 9000001), await detailOf(h, 9000002)];

    await h.json("POST", `/offers/${first.id}/merge`, { offerId: second.id });

    const gone = await h.json("GET", `/offers/${second.id}`);
    expect(gone.status).toBe(404);
    expect(gone.body).toMatchObject({ type: "offer-merged", mergedInto: first.id });
    expect(gone.body.detail).toContain(`merged into Offer ${first.id}`);
    const marked = await h.json("PATCH", `/offers/${second.id}/marks`, { shortlisted: true });
    expect(marked.body).toMatchObject({ type: "offer-merged", mergedInto: first.id });
    expect((await h.json("GET", "/offers/999")).body.type).toBe("not-found");
  });

  it("follows a chain of merges to the Offer that holds the room now", async () => {
    const h = bootOffers();
    ingestAds(
      h,
      { adId: 9000001, roomSize: 18 },
      { adId: 9000002, roomSize: 12, text: OTHER_ROOM_TEXT, images: [photo(40)] },
      { adId: 9000003, roomSize: 25, text: "Ein ganz anderer Text.", images: [photo(50)] },
    );
    const [a, b, c] = [
      await detailOf(h, 9000001),
      await detailOf(h, 9000002),
      await detailOf(h, 9000003),
    ];
    await h.json("POST", `/offers/${b.id}/merge`, { offerId: a.id });
    await h.json("POST", `/offers/${c.id}/merge`, { offerId: b.id });

    expect((await h.json("GET", `/offers/${a.id}`)).body.mergedInto).toBe(c.id);
    expect((await h.json("GET", `/offers/${b.id}`)).body.mergedInto).toBe(c.id);
  });

  it("announces the absorbed Offer", async () => {
    const h = repostedRoom();
    const room = await detailOf(h, 9000001);
    await h.json("POST", `/offers/${room.id}/split`, { adId: "9000002" });
    const split = await detailOf(h, 9000002);

    await h.json("POST", `/offers/${room.id}/merge`, { offerId: split.id });

    expect(h.events.filter((e) => e.type === "offer-merged").map((e) => e.data)).toEqual([
      { offerId: split.id, mergedInto: room.id },
    ]);
  });

  it("is announced and kept by a dedupe pass too", async () => {
    const h = repostedRoom();
    const { db } = h.runtime;
    const room = await detailOf(h, 9000001);
    const copy = rowOf(h, room.id);
    if (!copy) throw new Error("expected an Offer");
    db.insert(offers)
      .values({ ...copy, id: 77 })
      .run();
    db.update(offerAds).set({ offerId: 77 }).where(eqAd("9000002")).run();

    expect(h.runtime.offers.dedupePass()).toBe(1);

    expect((await h.json("GET", "/offers/77")).body.mergedInto).toBe(room.id);
    expect(h.events.filter((e) => e.type === "offer-merged").map((e) => e.data)).toEqual([
      { offerId: 77, mergedInto: room.id },
    ]);
  });
});

describe("a dedupe pass ranks the Offers it merged again", () => {
  it("remembers the band a Dismiss on the absorbed Offer gives the survivor", async () => {
    const h = await trackedRepost();
    const { db } = h.runtime;
    const room = await detailOf(h, 9000001);
    const copy = rowOf(h, room.id);
    if (!copy) throw new Error("expected an Offer");
    db.insert(offers)
      .values({ ...copy, id: 77, dismissed: true, band: "hidden" })
      .run();
    db.update(offerAds).set({ offerId: 77 }).where(eqAd("9000002")).run();
    expect(rowOf(h, room.id)?.band).not.toBe("hidden");

    h.runtime.offers.dedupePass();

    expect(rowOf(h, room.id)?.band).toBe("hidden");
  });
});

describe("the seeker's verdicts on pairs of Ad IDs", () => {
  it("keeps the Sibling link of two rooms the seeker says are not the same (B10)", async () => {
    const h = twoRooms();
    const [first, second] = [await detailOf(h, 9000001), await detailOf(h, 9000002)];
    await h.json("POST", `/offers/${first.id}/merge`, { offerId: second.id });

    const split = await h.json("POST", `/offers/${first.id}/split`, { adId: "9000002" });

    const siblings = (await detailOf(h, 9000001)).siblings.map(
      (s: { offer: { id: number } }) => s.offer.id,
    );
    expect(siblings).toEqual([split.body.id]);
  });

  it("links a re-post the seeker split off as a Sibling: same Advertiser, another room", async () => {
    const h = repostedRoom();
    const room = await detailOf(h, 9000001);

    const split = await h.json("POST", `/offers/${room.id}/split`, { adId: "9000002" });

    const siblings = (await detailOf(h, 9000001)).siblings.map(
      (s: { offer: { id: number } }) => s.offer.id,
    );
    expect(siblings).toEqual([split.body.id]);
  });

  it("never lets a new Ad ID join an Offer holding an Ad ID the seeker said is another room", async () => {
    const h = repostedRoom();
    h.runtime.db
      .insert(offerPairOverrides)
      .values({
        source: "wg-gesucht",
        adIdA: "9000001",
        adIdB: "9000003",
        verdict: "different",
        createdAt: new Date(h.clock.now),
      })
      .run();

    const [third] = ingestAds(h, { adId: 9000003, warmRent: 500 });

    expect(third?.outcome).toBe("created");
  });
});

describe("merges while the background loops run (B17)", () => {
  /** Offers whose one Ad ID has no stored page: each counts toward a loop's batch and is skipped. */
  function padding(h: Harness, count: number, rulesVersion: number) {
    const { db } = h.runtime;
    const now = new Date(h.clock.now);
    for (let n = 0; n < count; n++) {
      const { id } = db
        .insert(offers)
        .values({
          category: "flatshare-room",
          title: "padding",
          facts: "{}",
          card: "{}",
          rulesVersion,
          analysisState: "pending",
          firstSeenAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: offers.id })
        .get();
      db.insert(offerAds)
        .values({
          offerId: id,
          source: "wg-gesucht",
          adId: String(100 + n),
          path: `/padding.${100 + n}.html`,
          firstSeenAt: now,
          pageStatus: "active",
        })
        .run();
    }
  }

  it("reads the profile of an Ad ID whose Offer was merged away while the backfill waited", async () => {
    const h = bootOffers();
    padding(h, 25, wgGesuchtSource.rulesVersion);
    ingestStored(
      h,
      { adId: 9000001, roomSize: 18 },
      { adId: 9000002, roomSize: 12, text: OTHER_ROOM_TEXT, images: [photo(40)] },
    );
    const [first, second] = [await detailOf(h, 9000001), await detailOf(h, 9000002)];
    h.runtime.db
      .update(offerAds)
      .set({ profile: null, category: null, postalCode: null })
      .where(eqAd("9000002"))
      .run();

    const backfill = h.runtime.offers.backfillProfiles();
    // The first batch is done; the seeker merges before the next one.
    await h.json("POST", `/offers/${first.id}/merge`, { offerId: second.id });
    await backfill;

    expect(h.runtime.db.select().from(offerAds).where(eqAd("9000002")).get()?.profile).not.toBe(
      null,
    );
  });

  it("re-parses a survivor that took an older rules version from an Offer it absorbed", async () => {
    const h = bootOffers();
    const older = wgGesuchtSource.rulesVersion - 1;
    padding(h, 24, older);
    ingestStored(
      h,
      { adId: 9000001, roomSize: 18 },
      { adId: 9000002, roomSize: 12, text: OTHER_ROOM_TEXT, images: [photo(40)] },
    );
    const [first, second] = [await detailOf(h, 9000001), await detailOf(h, 9000002)];
    setRow(h, first.id, { rulesVersion: older });
    setRow(h, second.id, { rulesVersion: older });

    const reparse = h.runtime.offers.reparseOutdated();
    // The first batch re-parsed the first Offer; the second one, holding the current Ad ID,
    // merges into it before its turn and brings its older facts along.
    expect(rowOf(h, first.id)?.rulesVersion).toBe(wgGesuchtSource.rulesVersion);
    await h.json("POST", `/offers/${first.id}/merge`, { offerId: second.id });
    expect(rowOf(h, first.id)?.rulesVersion).toBe(older);
    await reparse;

    expect(rowOf(h, first.id)?.rulesVersion).toBe(wgGesuchtSource.rulesVersion);
  });
});
