import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { offerAds, offerPairOverrides, offers, searchMatches } from "../src/db/schema.js";
import { mergedClocks, nextClocks } from "../src/retention/clocks.js";
import { nextScheduledPrune } from "../src/retention/schedule.js";
import { ingestAds, OTHER_ROOM_TEXT, photo } from "./dedupe-harness.js";
import { bootOffers, HOUR } from "./offers-harness.js";
import { adIdsOf, DAY, goStale, nights, oneOffer, recordExists } from "./retention-harness.js";

type Harness = ReturnType<typeof bootOffers>;

const retentionOf = async (h: Harness, id: number) =>
  (await h.json("GET", `/offers/${id}`)).body.retention;

const clocksOf = (h: Harness, id: number) => {
  const row = h.runtime.db.select().from(offers).where(eq(offers.id, id)).get();
  return { quietSince: row?.quietSince ?? null, recordClockSince: row?.recordClockSince ?? null };
};

const iso = (ms: number) => new Date(ms).toISOString();

function twoRooms() {
  const h = bootOffers();
  const [first, second] = ingestAds(
    h,
    { adId: 9000001, warmRent: 450, roomSize: 18 },
    { adId: 9000002, warmRent: 400, roomSize: 12, text: OTHER_ROOM_TEXT, images: [photo(40)] },
  );
  if (first?.offerId === second?.offerId) throw new Error("expected two Offers");
  return { h, first: first?.offerId as number, second: second?.offerId as number };
}

function releasedRoomWithRepost() {
  const h = bootOffers();
  const [first, , second] = ingestAds(
    h,
    { adId: 9000001, warmRent: 450 },
    { adId: 9000003, warmRent: 450 },
    { adId: 9000002, warmRent: 400, roomSize: 12, text: OTHER_ROOM_TEXT, images: [photo(40)] },
  );
  const [room, other] = [first?.offerId, second?.offerId];
  if (room == null || other == null) throw new Error("expected two Offers");
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
  h.runtime.offers.releasePairPins(room);
  const repost = 77;
  const row = h.runtime.db.select().from(offers).where(eq(offers.id, room)).get();
  if (row === undefined) throw new Error("expected the room's Offer");
  h.runtime.db
    .insert(offers)
    .values({ ...row, id: repost, pairPinsReleasedAt: null })
    .run();
  h.runtime.db.update(offerAds).set({ offerId: repost }).where(eq(offerAds.adId, "9000003")).run();
  return { h, room, other, repost };
}

describe("GET /offers/{id}: retention", () => {
  it("runs no clock while a Search matches the Offer and it is fresh", async () => {
    const { h, id } = await oneOffer();
    expect(await retentionOf(h, id)).toEqual({
      state: "not-quiet",
      keptBecause: [],
      recordExpiresAt: null,
      snapshotExpiresAt: null,
    });
  });

  it("shows when the record and the snapshot fall due once the Offer went quiet", async () => {
    const { h, id } = await oneOffer();
    goStale(h);
    const since = clocksOf(h, id).quietSince?.getTime() as number;
    expect(await retentionOf(h, id)).toEqual({
      state: "expiring",
      keptBecause: [],
      recordExpiresAt: iso(since + 90 * DAY),
      snapshotExpiresAt: iso(since + 30 * DAY),
    });
  });

  it("counts from the next nightly prune when the Offer went quiet since the last one", async () => {
    const { h, id } = await oneOffer();
    h.clock.now += 8 * DAY;
    expect(clocksOf(h, id).quietSince).toBeNull();
    const starts = nextScheduledPrune(h.clock.now);
    expect(await retentionOf(h, id)).toMatchObject({
      state: "expiring",
      recordExpiresAt: iso(starts + 90 * DAY),
      snapshotExpiresAt: iso(starts + 30 * DAY),
    });
  });

  it("says what keeps a quiet record, while the snapshot still ages", async () => {
    const { h, id } = await oneOffer();
    await h.json("PATCH", `/offers/${id}/marks`, { shortlisted: true, scam: "not" });
    await h.json("PUT", `/offers/${id}/facts/anmeldung`, { value: "possible" });
    goStale(h);
    const since = clocksOf(h, id).quietSince?.getTime() as number;
    expect(await retentionOf(h, id)).toEqual({
      state: "kept",
      keptBecause: ["shortlisted", "scam-mark", "fact-override"],
      recordExpiresAt: null,
      snapshotExpiresAt: iso(since + 30 * DAY),
    });
  });

  it("names what would keep the record before the Offer goes quiet", async () => {
    const { h, id } = await oneOffer();
    await h.json("PATCH", `/offers/${id}/marks`, { dismissed: true, contacted: true });
    expect(await retentionOf(h, id)).toMatchObject({
      state: "not-quiet",
      keptBecause: ["dismissed", "contacted"],
    });
  });
});

async function quietFor(days: number) {
  const { h, id } = await oneOffer();
  goStale(h);
  nights(h, days);
  return { h, id, quietSince: clocksOf(h, id).quietSince?.getTime() as number };
}

describe("a change to what keeps the record, between two prunes", () => {
  const markCases = [
    ["Shortlisted", { shortlisted: true }, { shortlisted: false }],
    ["Dismissed", { dismissed: true }, { dismissed: false }],
    ["Contacted", { contacted: true }, { contacted: false }],
    ["a scam mark", { scam: "scam" }, { scam: "clear" }],
  ] as const;

  for (const [name, on, off] of markCases) {
    it(`gives a fresh 90 days when ${name} is taken off the day it was put on`, async () => {
      const { h, id } = await quietFor(85);
      const marked = await h.json("PATCH", `/offers/${id}/marks`, on);
      expect(marked.body.retention).toMatchObject({ state: "kept", recordExpiresAt: null });
      h.clock.now += 10 * HOUR;

      const unmarked = await h.json("PATCH", `/offers/${id}/marks`, off);
      expect(unmarked.body.retention).toMatchObject({
        state: "expiring",
        keptBecause: [],
        recordExpiresAt: iso(h.clock.now + 90 * DAY),
      });
      expect(await retentionOf(h, id)).toEqual(unmarked.body.retention);
    });
  }

  it("deletes the record 90 days after the mark came off, not when the old clock ran out", async () => {
    const { h, id } = await quietFor(85);
    await h.json("PATCH", `/offers/${id}/marks`, { shortlisted: true });
    h.clock.now += 10 * HOUR;
    await h.json("PATCH", `/offers/${id}/marks`, { shortlisted: false });

    nights(h, 89);
    expect(recordExists(h, id)).toBe(true);
    nights(h, 1);
    expect(recordExists(h, id)).toBe(false);
  });

  it("gives a fresh 90 days when a fact override is cleared the day it was set", async () => {
    const { h, id } = await quietFor(85);
    const set = await h.json("PUT", `/offers/${id}/facts/anmeldung`, { value: "possible" });
    expect(set.body.retention).toMatchObject({ state: "kept", recordExpiresAt: null });
    h.clock.now += 10 * HOUR;

    const cleared = await h.json("DELETE", `/offers/${id}/facts/anmeldung`);
    expect(cleared.body.retention).toMatchObject({
      state: "expiring",
      keptBecause: [],
      recordExpiresAt: iso(h.clock.now + 90 * DAY),
    });
    expect(await retentionOf(h, id)).toEqual(cleared.body.retention);
  });

  it("counts the same 90 days when a prune did run while the mark was on", async () => {
    const { h, id } = await quietFor(85);
    await h.json("PATCH", `/offers/${id}/marks`, { shortlisted: true });
    nights(h, 1);
    h.clock.now += 10 * HOUR;

    const unmarked = await h.json("PATCH", `/offers/${id}/marks`, { shortlisted: false });
    expect(unmarked.body.retention.recordExpiresAt).toBe(iso(h.clock.now + 90 * DAY));
  });

  it("starts no clock while another mark still keeps the record", async () => {
    const { h, id, quietSince } = await quietFor(85);
    await h.json("PATCH", `/offers/${id}/marks`, { shortlisted: true });
    h.clock.now += 2 * HOUR;

    const second = await h.json("PATCH", `/offers/${id}/marks`, { contacted: true });
    expect(second.body.retention).toEqual({
      state: "kept",
      keptBecause: ["shortlisted", "contacted"],
      recordExpiresAt: null,
      snapshotExpiresAt: iso(quietSince + 30 * DAY),
    });
    h.clock.now += 2 * HOUR;
    const one = await h.json("PATCH", `/offers/${id}/marks`, { shortlisted: false });
    expect(one.body.retention).toMatchObject({
      state: "kept",
      keptBecause: ["contacted"],
      recordExpiresAt: null,
    });
    h.clock.now += 2 * HOUR;

    const none = await h.json("PATCH", `/offers/${id}/marks`, { contacted: false });
    expect(none.body.retention).toMatchObject({
      state: "expiring",
      recordExpiresAt: iso(h.clock.now + 90 * DAY),
    });
  });

  it("leaves a running clock alone when the write keeps and frees nothing", async () => {
    const { h, id, quietSince } = await quietFor(85);
    h.clock.now += 10 * HOUR;

    const same = await h.json("PATCH", `/offers/${id}/marks`, { shortlisted: false });
    expect(same.body.retention).toEqual({
      state: "expiring",
      keptBecause: [],
      recordExpiresAt: iso(quietSince + 90 * DAY),
      snapshotExpiresAt: iso(quietSince + 30 * DAY),
    });
  });
});

describe("pins from a merge or split verdict (B11)", () => {
  it("names the verdict as what keeps both Offers of a split", async () => {
    const h = bootOffers();
    ingestAds(h, { adId: 9000001, warmRent: 450 }, { adId: 9000002, warmRent: 480 });
    const [offer] = (await h.json("GET", "/offers?includeHidden=true")).body.items;
    const split = await h.json("POST", `/offers/${offer.id}/split`, { adId: "9000002" });
    expect(split.status).toBe(201);
    goStale(h);
    for (const id of [offer.id, split.body.id]) {
      expect(await retentionOf(h, id)).toMatchObject({
        state: "kept",
        keptBecause: ["pair-override"],
        recordExpiresAt: null,
      });
    }
  });

  it("releases one Offer's pin without undoing the verdict or freeing the other Offer", async () => {
    const { h, first, second } = twoRooms();
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
    nights(h, 10);

    const released = await h.json("POST", `/offers/${first}/retention/release`);
    expect(released.status).toBe(200);
    expect(released.body.retention).toEqual({
      state: "expiring",
      keptBecause: [],
      recordExpiresAt: iso(h.clock.now + 90 * DAY),
      snapshotExpiresAt: iso((clocksOf(h, first).quietSince?.getTime() as number) + 30 * DAY),
    });
    expect((await retentionOf(h, second)).keptBecause).toEqual(["pair-override"]);

    nights(h, 89);
    expect(recordExists(h, first)).toBe(true);
    nights(h, 2);
    expect(recordExists(h, first)).toBe(false);
    expect(recordExists(h, second)).toBe(true);
    expect(h.runtime.db.select().from(offerPairOverrides).all()).toHaveLength(1);
  });

  it("leaves the seeker's marks pinning after a release", async () => {
    const { h, first } = twoRooms();
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
    await h.json("PATCH", `/offers/${first}/marks`, { contacted: true });
    goStale(h);
    const released = await h.json("POST", `/offers/${first}/retention/release`);
    expect(released.body.retention).toMatchObject({ state: "kept", keptBecause: ["contacted"] });
  });

  it("pins again when the seeker gives a verdict after the release", async () => {
    const { h, first, second } = twoRooms();
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
    await h.json("POST", `/offers/${first}/retention/release`);
    h.clock.now += 60_000;
    const merged = await h.json("POST", `/offers/${first}/merge`, { offerId: second });
    expect(merged.status).toBe(200);
    expect(merged.body.retention.keptBecause).toEqual(["pair-override"]);
  });

  it("starts a fresh 90 days when a merge's pin is released before any prune saw it", async () => {
    const { h, first, second } = twoRooms();
    const long = new Date(h.clock.now - 89 * DAY);
    for (const id of [first, second]) {
      h.runtime.db
        .update(offers)
        .set({ quietSince: long, recordClockSince: long })
        .where(eq(offers.id, id))
        .run();
    }
    expect((await h.json("POST", `/offers/${first}/merge`, { offerId: second })).status).toBe(200);
    h.clock.now += 60_000;

    const released = await h.json("POST", `/offers/${first}/retention/release`);
    expect(released.body.retention).toMatchObject({
      state: "expiring",
      keptBecause: [],
      recordExpiresAt: iso(h.clock.now + 90 * DAY),
    });
    nights(h, 2);
    expect(recordExists(h, first)).toBe(true);
  });

  it("keeps a release through a dedupe merge with an Offer no verdict pins", async () => {
    const { h, room, other } = releasedRoomWithRepost();

    expect(h.runtime.offers.dedupePass()).toBe(1);

    const merged = await h.json("GET", `/offers/${room}`);
    expect(adIdsOf(h, merged.body.id).sort()).toEqual(["9000001", "9000003"]);
    expect(merged.body.retention).toMatchObject({ state: "expiring", keptBecause: [] });
    expect((await retentionOf(h, other)).keptBecause).toEqual(["pair-override"]);
  });

  it("pins the merged record when the other side of a dedupe merge is still pinned", async () => {
    const { h, room, repost } = releasedRoomWithRepost();
    h.clock.now += 60_000;
    h.runtime.db
      .insert(offerPairOverrides)
      .values({
        source: "wg-gesucht",
        adIdA: "9000002",
        adIdB: "9000003",
        verdict: "different",
        createdAt: new Date(h.clock.now),
      })
      .run();
    expect((await retentionOf(h, repost)).keptBecause).toEqual(["pair-override"]);

    expect(h.runtime.offers.dedupePass()).toBe(1);

    expect((await h.json("GET", `/offers/${room}`)).body.retention.keptBecause).toEqual([
      "pair-override",
    ]);
  });

  it("answers 404 for an Offer that does not exist", async () => {
    const h = bootOffers();
    expect((await h.json("POST", "/offers/999/retention/release")).status).toBe(404);
  });

  it("points an Offer a merge absorbed at the one it went into, like every Offer route", async () => {
    const { h, first, second } = twoRooms();
    await h.json("POST", `/offers/${first}/merge`, { offerId: second });

    const gone = await h.json("POST", `/offers/${second}/retention/release`);
    expect(gone.status).toBe(404);
    expect(gone.body).toMatchObject({ type: "offer-merged", mergedInto: first });
  });
});

describe("clocks across a merge", () => {
  it("keeps the later quiet clock of the two: the room was quiet only once both were", async () => {
    const { h, first, second } = twoRooms();
    const early = new Date(h.clock.now - 20 * DAY);
    const late = new Date(h.clock.now - 5 * DAY);
    h.runtime.db
      .update(offers)
      .set({ quietSince: early, recordClockSince: early })
      .where(eq(offers.id, first))
      .run();
    h.runtime.db
      .update(offers)
      .set({ quietSince: late, recordClockSince: late })
      .where(eq(offers.id, second))
      .run();

    await h.json("POST", `/offers/${first}/merge`, { offerId: second });
    // The "same room" verdict pins the record, which stops its clock; the carry-over is the rule's.
    expect(clocksOf(h, first)).toEqual({ quietSince: late, recordClockSince: null });
    expect((await retentionOf(h, first)).keptBecause).toEqual(["pair-override"]);
    expect(
      mergedClocks(
        { quietSince: early, recordClockSince: early },
        { quietSince: late, recordClockSince: late },
      ),
    ).toEqual({ quietSince: late, recordClockSince: late });
  });

  it("starts no clock early when either side was not quiet", async () => {
    const { h, first, second } = twoRooms();
    const early = new Date(h.clock.now - 20 * DAY);
    h.runtime.db
      .update(offers)
      .set({ quietSince: early, recordClockSince: early })
      .where(eq(offers.id, first))
      .run();
    await h.addSearch();
    h.runtime.db
      .insert(searchMatches)
      .values({
        searchId: 1,
        source: "wg-gesucht",
        adId: "9000002",
        lastSeenAt: new Date(h.clock.now),
      })
      .run();
    await h.json("POST", `/offers/${first}/merge`, { offerId: second });
    expect(clocksOf(h, first)).toEqual({ quietSince: null, recordClockSince: null });
  });
});

describe("clocks across a split", () => {
  it("gives the split-off Offer the room's quiet clock, and stops both record clocks for the new pin", async () => {
    const h = bootOffers();
    const [room] = ingestAds(h, { adId: 9000001, warmRent: 450 }, { adId: 9000002, warmRent: 480 });
    const id = room?.offerId as number;
    goStale(h);
    const quiet = clocksOf(h, id);
    expect(quiet.quietSince).not.toBeNull();
    expect(quiet.recordClockSince).not.toBeNull();
    h.clock.now += 60_000;

    const split = await h.json("POST", `/offers/${id}/split`, { adId: "9000002" });
    expect(split.status).toBe(201);

    for (const each of [id, split.body.id]) {
      expect(clocksOf(h, each)).toEqual({ quietSince: quiet.quietSince, recordClockSince: null });
    }
  });
});

describe("the clock rule", () => {
  const at = new Date("2026-11-09T02:00:00Z");
  const before = new Date("2026-10-01T02:00:00Z");
  const between = new Date("2026-10-15T02:00:00Z");

  it("never leaves a record clock running without a quiet clock", () => {
    expect(
      nextClocks({ state: "shown", kept: false, quietSince: null, recordClockSince: before }, at),
    ).toEqual({ quietSince: null, recordClockSince: null });
  });

  it("never starts the record clock before the quiet clock", () => {
    expect(
      nextClocks(
        { state: "stale", kept: false, quietSince: between, recordClockSince: before },
        at,
      ),
    ).toEqual({ quietSince: between, recordClockSince: between });
  });

  it("starts both at `at` the first time an Offer is seen quiet", () => {
    expect(
      nextClocks({ state: "untracked", kept: false, quietSince: null, recordClockSince: null }, at),
    ).toEqual({ quietSince: at, recordClockSince: at });
  });

  it("holds the record clock while the record is kept", () => {
    expect(
      nextClocks({ state: "stale", kept: true, quietSince: before, recordClockSince: before }, at),
    ).toEqual({ quietSince: before, recordClockSince: null });
  });

  it("repairs the stored columns at the next prune", async () => {
    const { h, id } = await oneOffer();
    goStale(h);
    const quiet = clocksOf(h, id).quietSince as Date;
    h.runtime.db
      .update(offers)
      .set({ recordClockSince: new Date(quiet.getTime() - 10 * DAY) })
      .where(eq(offers.id, id))
      .run();
    h.runtime.retention.prune();
    expect(clocksOf(h, id).recordClockSince).toEqual(quiet);
  });
});
