import { rmSync } from "node:fs";
import { join } from "node:path";
import { wgGesuchtSource } from "@wg-hunt/core/sources/wg-gesucht";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATABASE_FILE } from "../src/config.js";
import { readJson } from "../src/crawl/kv.js";
import { openDatabase } from "../src/db/index.js";
import { offerAds, offers, seenAds } from "../src/db/schema.js";
import { type CatchUpStep, readCatchUp, startCatchUp } from "../src/offers/catch-up.js";
import { WIPE_CONFIRMATION } from "../src/retention/constants.js";
import { tempDataDir } from "./helpers.js";
import { bootOffers, HOUR, MORNING } from "./offers-harness.js";

const DAY = 24 * HOUR;

type Harness = ReturnType<typeof bootOffers>;

function breakOffersStepFor(h: Harness, adId: number): void {
  h.runtime.db.$client.exec(
    `CREATE TRIGGER broken_offers_step BEFORE INSERT ON offer_ads WHEN NEW.adId = '${adId}'
     BEGIN SELECT RAISE(ABORT, 'broken Offers step'); END`,
  );
}

async function folderWithBrokenPage() {
  const first = bootOffers();
  breakOffersStepFor(first, 9000001);
  first.site.cards = first.freshCards([9000001, 9000002]);
  await first.addSearch();
  await first.crawl();
  const stored = first.runtime.db.select().from(seenAds).where(eq(seenAds.adId, "9000001")).get();
  expect(stored).toMatchObject({ detailState: "fetched", ingestedAt: null });
  first.runtime.db
    .update(offers)
    .set({
      rulesVersion: 0,
      facts: JSON.stringify({ roomSize: { value: 99, origin: "field", quote: "old" } }),
    })
    .run();
  first.runtime.close();
  return first.dataDir;
}

const rulesVersionOf = (h: Harness, adId: string) => {
  const ad = h.runtime.db.select().from(offerAds).where(eq(offerAds.adId, adId)).get();
  if (ad === undefined) return undefined;
  return h.runtime.db.select().from(offers).where(eq(offers.id, ad.offerId)).get()?.rulesVersion;
};

describe("the catch-up after a start", () => {
  let logged: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logged = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logged.mockRestore();
  });

  it("carries on past a stored page whose Offers step throws", async () => {
    const dataDir = await folderWithBrokenPage();

    const restarted = bootOffers({ dataDir });
    await restarted.runtime.catchUp;

    expect(rulesVersionOf(restarted, "9000002")).toBe(wgGesuchtSource.rulesVersion);
  });

  it("records the page as one failure, at this start and the next", async () => {
    const dataDir = await folderWithBrokenPage();

    const second = bootOffers({ dataDir });
    const outcome = await second.runtime.catchUp;

    expect(outcome.state).toBe("finished");
    expect(outcome.phases.adoptPages).toMatchObject({
      state: "finished",
      done: 0,
      skipped: 0,
      failed: 1,
    });
    expect(outcome.phases.reparse).toMatchObject({ state: "finished", done: 1, failed: 0 });
    expect(logged).toHaveBeenCalledWith(
      "Catch-up: adopting the stored page of Ad ID 9000001 failed: SqliteError (SQLITE_CONSTRAINT_TRIGGER)",
    );
    second.runtime.close();

    const third = bootOffers({ dataDir });
    const again = await third.runtime.catchUp;

    expect(again.state).toBe("finished");
    expect(again.phases.adoptPages).toMatchObject({ state: "finished", failed: 1 });
    expect(again.phases.reparse).toMatchObject({ state: "finished", done: 0, failed: 0 });
  });

  it("is shown on GET /storage, phase by phase", async () => {
    const dataDir = await folderWithBrokenPage();

    const restarted = bootOffers({ dataDir });
    await restarted.runtime.catchUp;

    const at = new Date(MORNING).toISOString();
    const untouched = {
      state: "finished",
      startedAt: at,
      finishedAt: at,
      done: 0,
      skipped: 0,
      failed: 0,
    };
    expect((await restarted.json("GET", "/storage")).body.catchUp).toEqual({
      state: "finished",
      startedAt: at,
      finishedAt: at,
      phases: {
        adoptPages: { ...untouched, failed: 1 },
        backfillProfiles: untouched,
        followCurrent: untouched,
        reparse: { ...untouched, done: 1 },
      },
    });
  });

  it("is served from memory when its record could not be stored, not as an earlier start left it", async () => {
    const first = bootOffers();
    first.site.cards = first.freshCards([9000001]);
    await first.addSearch();
    await first.crawl();
    await first.runtime.catchUp;
    first.runtime.db.update(offers).set({ rulesVersion: 0 }).run();
    rmSync(join(first.dataDir, "offer-pages", "wg-gesucht", "9000001.html.gz"));
    first.runtime.db.$client.exec(
      `CREATE TRIGGER no_catch_up_record BEFORE INSERT ON settings WHEN NEW.key = 'offers.catchUp'
       BEGIN SELECT RAISE(ABORT, 'no room'); END`,
    );
    first.runtime.close();

    const restarted = bootOffers({ dataDir: first.dataDir, start: MORNING + DAY });
    await restarted.runtime.catchUp;

    const { catchUp } = (await restarted.json("GET", "/storage")).body;
    expect(catchUp.startedAt).toBe(new Date(MORNING + DAY).toISOString());
    expect(catchUp.phases.reparse).toMatchObject({ state: "finished", skipped: 1 });
    expect(readCatchUp(restarted.runtime.db)?.startedAt).toBe(MORNING);
    expect(logged.mock.calls.flat()).toEqual([
      "Could not store how the catch-up went, so it is kept in memory: SqliteError (SQLITE_CONSTRAINT_TRIGGER)",
    ]);
  });

  describe("a stored page whose Offers step keeps throwing", () => {
    const seenRow = (h: Harness) =>
      h.runtime.db.select().from(seenAds).where(eq(seenAds.adId, "9000001")).get();
    const adoption = async (h: Harness) => (await h.runtime.catchUp).phases.adoptPages;
    // The first start after the crawl comes a month later: the host was off, or an older build
    // ran, which stopped at this page without counting anything.
    const FIRST = MORNING + 30 * DAY;

    it("is tried at each start for a week from the first start that failed on it, however old it is", async () => {
      const dataDir = await folderWithBrokenPage();

      const first = bootOffers({ dataDir, start: FIRST });
      expect(await adoption(first)).toMatchObject({ failed: 1, skipped: 0 });
      expect(seenRow(first)).toMatchObject({ detailState: "fetched", ingestedAt: null });
      first.runtime.close();

      const sixDaysOn = bootOffers({ dataDir, start: FIRST + 6 * DAY });
      expect(await adoption(sixDaysOn)).toMatchObject({ failed: 1, skipped: 0 });
      expect(seenRow(sixDaysOn)).toMatchObject({ detailState: "fetched", ingestedAt: null });
    });

    it("is given up a week on, settled as a failed fetch and counted as left as it is", async () => {
      const dataDir = await folderWithBrokenPage();
      const first = bootOffers({ dataDir, start: FIRST });
      await first.runtime.catchUp;
      first.runtime.close();

      const aWeekOn = bootOffers({ dataDir, start: FIRST + 7 * DAY });
      // Not `failed`: what is counted there is tried again at the next start, and this is not.
      expect(await adoption(aWeekOn)).toMatchObject({ state: "finished", failed: 0, skipped: 1 });
      expect(seenRow(aWeekOn)).toMatchObject({ detailState: "failed" });
      expect(logged).toHaveBeenCalledWith(
        `Catch-up: gave up on the stored page of Ad ID 9000001, which has thrown since ${new Date(FIRST).toISOString()}: SqliteError (SQLITE_CONSTRAINT_TRIGGER)`,
      );
      aWeekOn.runtime.close();

      const later = bootOffers({ dataDir, start: FIRST + 8 * DAY });
      expect(await adoption(later)).toMatchObject({ done: 0, skipped: 0, failed: 0 });
    });

    it("becomes an Offer at the first start of a build that no longer throws, however late", async () => {
      const dataDir = await folderWithBrokenPage();
      const failing = bootOffers({ dataDir, start: FIRST });
      await failing.runtime.catchUp;
      failing.runtime.db.$client.exec("DROP TRIGGER broken_offers_step");
      failing.runtime.close();

      const fixed = bootOffers({ dataDir, start: FIRST + 60 * DAY });
      expect(await adoption(fixed)).toMatchObject({ done: 1, skipped: 0, failed: 0 });
      expect(rulesVersionOf(fixed, "9000001")).toBe(wgGesuchtSource.rulesVersion);
      fixed.runtime.close();

      const after = bootOffers({ dataDir, start: FIRST + 61 * DAY });
      expect(await adoption(after)).toMatchObject({ done: 0, skipped: 0, failed: 0 });
    });
  });

  it("counts an Offer on older rules whose page is gone as skipped by the re-parse", async () => {
    const first = bootOffers();
    first.site.cards = first.freshCards([9000001, 9000002]);
    await first.addSearch();
    await first.crawl();
    first.runtime.db.update(offers).set({ rulesVersion: 0 }).run();
    rmSync(join(first.dataDir, "offer-pages", "wg-gesucht", "9000001.html.gz"));
    first.runtime.close();

    const restarted = bootOffers({ dataDir: first.dataDir });
    const outcome = await restarted.runtime.catchUp;

    expect(outcome.state).toBe("finished");
    expect(outcome.phases.reparse).toMatchObject({ state: "finished", done: 1, skipped: 1 });
    expect(rulesVersionOf(restarted, "9000001")).toBe(0);
    expect(rulesVersionOf(restarted, "9000002")).toBe(wgGesuchtSource.rulesVersion);
  });

  it("forgets what it left as it was once all Offer data is deleted", async () => {
    const dataDir = await folderWithBrokenPage();
    rmSync(join(dataDir, "offer-pages", "wg-gesucht", "9000002.html.gz"));
    const h = bootOffers({ dataDir });
    await h.runtime.catchUp;
    expect((await h.json("GET", "/storage")).body.catchUp.phases).toMatchObject({
      adoptPages: { failed: 1 },
      reparse: { skipped: 1 },
    });
    expect(readJson(h.runtime.db, "offers.adoptFailures")).toEqual({
      "wg-gesucht/9000001": MORNING,
    });

    const wiped = await h.json("POST", "/storage/wipe", { confirm: WIPE_CONFIRMATION });

    const nothingLeft = {
      state: "finished",
      phases: {
        adoptPages: { state: "finished", done: 0, skipped: 0, failed: 0 },
        reparse: { state: "finished", done: 0, skipped: 0, failed: 0 },
      },
    };
    expect(wiped.body.storage.catchUp).toMatchObject(nothingLeft);
    expect((await h.json("GET", "/storage")).body.catchUp).toMatchObject(nothingLeft);
    expect(readCatchUp(h.runtime.db)).toMatchObject(nothingLeft);
    expect(readJson(h.runtime.db, "offers.adoptFailures")).toBeUndefined();
  });

  it("breaks a phase off at the first error that is the whole database's, not the Offer's", async () => {
    const h = bootOffers();
    h.site.cards = h.freshCards([9000001, 9000002, 9000003]);
    await h.addSearch();
    await h.crawl();
    await h.runtime.catchUp;
    h.runtime.db.update(offers).set({ rulesVersion: 0 }).run();
    h.runtime.db.$client.pragma("query_only = ON");

    const step = await h.runtime.offers.reparseOutdated();

    // Not three failures: the first Offer's is not its own, so the other two are not tried.
    expect(step).toEqual({ done: 0, skipped: 0, failed: 0, state: "failed" });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Catch-up: re-parsing Offer \d+ failed: SqliteError \(SQLITE_READONLY\); the phase stops here$/,
      ),
    );
  });

  it("is recorded as stopped when the server shuts down part-way, before the database closes", async () => {
    const first = bootOffers();
    const ids = Array.from({ length: 30 }, (_, n) => 9000001 + n);
    first.site.cards = first.freshCards(ids);
    await first.addSearch();
    await first.crawl(6 * HOUR);
    expect(first.runtime.db.select().from(offers).all()).toHaveLength(30);
    first.runtime.db.update(offers).set({ rulesVersion: 0 }).run();
    first.runtime.close();

    const restarted = bootOffers({ dataDir: first.dataDir });
    expect(readCatchUp(restarted.runtime.db)?.state).toBe("running");
    // A few turns of the event loop on, it has looked at 25 Offers and waits before the next.
    const reached = () => readCatchUp(restarted.runtime.db)?.phases.followCurrent.state;
    for (let turn = 0; turn < 10 && reached() === "pending"; turn++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(readCatchUp(restarted.runtime.db)).toMatchObject({
      state: "running",
      finishedAt: null,
      phases: { followCurrent: { state: "running" }, reparse: { state: "pending" } },
    });
    await restarted.runtime.shutdown();

    const db = openDatabase(join(first.dataDir, DATABASE_FILE));
    const stored = readCatchUp(db);
    const outdated = db.select().from(offers).where(eq(offers.rulesVersion, 0)).all();
    db.$client.close();
    expect(stored).toMatchObject({
      state: "stopped",
      phases: {
        adoptPages: { state: "finished" },
        followCurrent: { state: "stopped" },
        reparse: { state: "pending", startedAt: null },
      },
    });
    expect(stored?.finishedAt).not.toBeNull();
    expect(await restarted.runtime.catchUp).toEqual(stored);
    expect(outdated).toHaveLength(30);
  });
});

describe("a phase of the catch-up that breaks off", () => {
  const nothing = async (): Promise<CatchUpStep> => ({
    done: 0,
    skipped: 0,
    failed: 0,
    state: "finished",
  });

  it("is recorded as failed, and the phases after it still run", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = openDatabase(join(tempDataDir(), DATABASE_FILE));
    let deduped = 0;

    const outcome = await startCatchUp({
      db,
      clock: () => MORNING,
      offers: {
        adoptStoredPages: async () => {
          throw new TypeError("broken");
        },
        backfillProfiles: async () => ({ done: 2, skipped: 0, failed: 0, state: "finished" }),
        dedupePass: () => deduped++,
        followStoredCurrent: async () => ({ done: 1, skipped: 0, failed: 0, state: "failed" }),
        reparseOutdated: async () => ({ done: 3, skipped: 1, failed: 0, state: "finished" }),
      },
    }).done;

    expect(outcome.state).toBe("failed");
    expect(outcome.phases.adoptPages).toMatchObject({ state: "failed", finishedAt: MORNING });
    expect(outcome.phases.backfillProfiles).toMatchObject({ state: "finished", done: 2 });
    expect(deduped).toBe(1);
    expect(outcome.phases.followCurrent).toMatchObject({ state: "failed", done: 1 });
    expect(outcome.phases.reparse).toMatchObject({ state: "finished", done: 3, skipped: 1 });
    expect(readCatchUp(db)).toEqual(outcome);
    expect(logged).toHaveBeenCalledWith("Catch-up: adopting stored pages broke off: TypeError");
    logged.mockRestore();
    db.$client.close();
  });

  it("leaves the Duplicates pass for the next start when the profile backfill broke off", async () => {
    const db = openDatabase(join(tempDataDir(), DATABASE_FILE));
    let deduped = 0;

    const outcome = await startCatchUp({
      db,
      clock: () => MORNING,
      offers: {
        adoptStoredPages: nothing,
        backfillProfiles: async () => ({ done: 2, skipped: 0, failed: 0, state: "failed" }),
        dedupePass: () => deduped++,
        followStoredCurrent: nothing,
        reparseOutdated: nothing,
      },
    }).done;

    expect(deduped).toBe(0);
    expect(outcome.phases.backfillProfiles).toMatchObject({ state: "failed", done: 2 });
    db.$client.close();
  });

  it("gives the event loop a turn before the next phase, so a stop that arrives then is served", async () => {
    const db = openDatabase(join(tempDataDir(), DATABASE_FILE));
    const catchUp = startCatchUp({
      db,
      clock: () => MORNING,
      offers: {
        adoptStoredPages: nothing,
        backfillProfiles: nothing,
        dedupePass: () => 0,
        followStoredCurrent: nothing,
        reparseOutdated: nothing,
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
    catchUp.stop();
    const outcome = await catchUp.done;

    expect(outcome.state).toBe("stopped");
    expect(outcome.phases.adoptPages.state).toBe("finished");
    expect(outcome.phases.reparse.state).toBe("pending");
    db.$client.close();
  });
});
