import { wgGesuchtSource } from "@wg-hunt/core/sources/wg-gesucht";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultCrawlSettings, saveCrawlSettings } from "../src/crawl/settings.js";
import { MAX_SWEEP_ATTEMPTS } from "../src/crawl/sweeps.js";
import { crawlJobs, searches, searchSweeps } from "../src/db/schema.js";
import { relaxCaps } from "./offers-harness.js";
import { berlin, bootSweep, DAY, HOUR } from "./sweep-harness.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const boot = () => bootSweep({ pageSize: 5 });

async function settled(count: number) {
  const h = boot();
  h.site.listing = h.cards(9003000, count);
  const search = await h.addSearch();
  await h.crawlUntil(berlin(4, 23));
  expect((await h.json("GET", "/offers")).body.items).toHaveLength(count);
  return { h, search };
}

const pageNumbers = (requests: { path: string }[]) =>
  requests.map((r) => Number(/\.1\.(\d+)\.html/.exec(r.path)?.[1]));

const sweepPageJobs = (h: ReturnType<typeof bootSweep>) =>
  h.runtime.db
    .select()
    .from(crawlJobs)
    .where(eq(crawlJobs.kind, "deeper-page"))
    .all()
    .filter((job) => JSON.parse(job.payload ?? "{}").type === "sweep-page");

describe("the Sweep's lifecycle", () => {
  it("starts a backfill when a Search it could not read becomes readable without an edit (B6)", async () => {
    const h = boot();
    h.site.listing = h.cards(9003000, 7);
    const pages = vi
      .spyOn(wgGesuchtSource, "searchPages")
      .mockReturnValue({ ok: false, reason: "unknown-city" });
    const search = await h.addSearch();
    await h.crawlUntil(berlin(4, 12));
    expect(h.requestsOf("deeper-page")).toEqual([]);
    expect((await h.json("GET", `/searches/${search.id}`)).body.sweep).toMatchObject({
      status: "idle",
      mode: null,
    });

    // A release teaches the adapter the city; the Search itself is unchanged. The server restarts.
    pages.mockRestore();
    h.runtime.polling.sync();
    const readable = h.clock.now;
    await h.crawlUntil(readable + 2 * HOUR);

    expect(pageNumbers(h.requestsOf("deeper-page", readable)).sort()).toEqual([0, 1, 2]);
    const sweep = (await h.json("GET", `/searches/${search.id}`)).body.sweep;
    expect(sweep).toMatchObject({ status: "scheduled", mode: "daily" });
    expect(sweep.lastFinishedAt).not.toBeNull();
  });

  it("never judges from a running Sweep with no start time; it starts over instead (B12)", async () => {
    const { h, search } = await settled(7);
    // A row that says "running" but has no start time: every match would look unseen.
    h.runtime.db
      .update(searchSweeps)
      .set({
        status: "running",
        cursors: { "flatshare-room": null },
        cardCount: 25,
      })
      .where(eq(searchSweeps.searchId, search.id))
      .run();
    h.runtime.sweeps.sync();

    expect(
      h.runtime.db.select().from(crawlJobs).where(eq(crawlJobs.kind, "stale-confirmation")).all(),
    ).toEqual([]);
    const sweep = (await h.json("GET", `/searches/${search.id}`)).body.sweep;
    expect(sweep).toMatchObject({ status: "scheduled", mode: "backfill" });
    expect(sweepPageJobs(h)).toHaveLength(1);
  });

  it("starts over a running Sweep with no cursors instead of waiting forever", async () => {
    const { h, search } = await settled(7);
    h.runtime.db
      .update(searchSweeps)
      .set({ status: "running", startedAt: new Date(h.clock.now), cursors: null })
      .where(eq(searchSweeps.searchId, search.id))
      .run();
    h.runtime.db.delete(crawlJobs).where(eq(crawlJobs.kind, "deeper-page")).run();
    h.runtime.sweeps.sync();
    expect(sweepPageJobs(h)).toHaveLength(1);

    const restarted = h.clock.now;
    await h.crawlUntil(restarted + 2 * HOUR);
    expect(pageNumbers(h.requestsOf("deeper-page", restarted)).sort()).toEqual([0, 1, 2]);
  });

  it("gives up a Sweep whose page keeps failing, judges nothing, and sweeps again the next day", async () => {
    const { h, search } = await settled(12);
    for (let i = 0; i < MAX_SWEEP_ATTEMPTS; i++) {
      h.site.failNext.push({ match: /\.1\.1\.html/, status: 500 });
    }
    h.site.listing = h.site.listing.slice(0, 11);

    await h.crawlUntil(berlin(5, 23));
    expect(pageNumbers(h.requestsOf("deeper-page", berlin(5, 0)))).toEqual([
      0,
      ...Array(MAX_SWEEP_ATTEMPTS).fill(1),
    ]);
    expect(h.requestsOf("stale-confirmation")).toEqual([]);
    const given = (await h.json("GET", `/searches/${search.id}`)).body.sweep;
    expect(given).toMatchObject({ status: "scheduled", mode: "daily", pagesRead: 0 });
    expect(new Date(given.startAt).getTime()).toBeGreaterThanOrEqual(berlin(6, 7));
    expect(new Date(given.startAt).getTime()).toBeLessThan(berlin(6, 10));

    await h.crawlUntil(berlin(6, 23));
    expect(pageNumbers(h.requestsOf("deeper-page", berlin(6, 0)))).toEqual([0, 1, 2, 3]);
    expect(h.requestsOf("stale-confirmation", berlin(6, 0))).toHaveLength(1);
  });

  it("keeps a backfill a backfill when it is given up", async () => {
    const h = boot();
    h.site.listing = h.cards(9003000, 12);
    for (let i = 0; i < MAX_SWEEP_ATTEMPTS; i++) {
      h.site.failNext.push({ match: /\.1\.1\.html/, status: 500 });
    }
    const search = await h.addSearch();
    await h.crawlUntil(berlin(4, 23));
    expect((await h.json("GET", `/searches/${search.id}`)).body.sweep).toMatchObject({
      status: "scheduled",
      mode: "backfill",
      lastFinishedAt: null,
    });
  });

  it("takes over a poll continuation queued for the page it needs, so the page is read once (B11)", async () => {
    const { h, search } = await settled(12);
    const settings = defaultCrawlSettings();
    saveCrawlSettings(
      h.runtime.db,
      { ...settings, pacing: { ...settings.pacing, dailyCap: 1 } },
      h.clock.now,
    );
    await h.crawlUntil(berlin(5, 23, 30));
    expect(pageNumbers(h.requestsOf("deeper-page", berlin(5, 0)))).toEqual([0]);
    const running = (await h.json("GET", `/searches/${search.id}`)).body.sweep;
    expect(running).toMatchObject({
      status: "running",
      mode: "daily",
      startAt: null,
      pagesRead: 1,
    });

    h.runtime.db.delete(crawlJobs).where(eq(crawlJobs.kind, "deeper-page")).run();
    const row = h.runtime.db.select().from(searches).where(eq(searches.id, search.id)).get();
    if (row === undefined) throw new Error("no Search");
    const path = h.runtime.polling.pageRequest(row, "flatshare-room", 1)?.path ?? "";
    h.runtime.crawl.enqueue({
      kind: "deeper-page",
      path,
      payload: { type: "search-page", searchId: search.id, category: "flatshare-room", page: 1 },
    });
    h.runtime.sweeps.sync();
    expect(sweepPageJobs(h).map((job) => job.path)).toEqual([path]);

    relaxCaps(h.runtime, h.clock.now);
    const from = h.clock.now;
    await h.crawlUntil(berlin(6, 12));
    expect(pageNumbers(h.requestsOf("deeper-page", from))).toEqual([1, 2, 3]);
    expect((await h.json("GET", `/searches/${search.id}`)).body.sweep.status).toBe("scheduled");
  });

  it("runs a new Search's backfill at once though another Search's daily Sweep waits on the same page", async () => {
    const h = boot();
    h.site.listing = h.cards(9003000, 7);
    const first = await h.addSearch();
    await h.crawlUntil(berlin(4, 12));
    expect((await h.json("GET", `/searches/${first.id}`)).body.sweep).toMatchObject({
      status: "scheduled",
      mode: "daily",
    });

    const second = await h.addSearch({ pollInterval: { minMinutes: 1400, maxMinutes: 1440 } });
    const added = h.clock.now;
    expect(sweepPageJobs(h)).toHaveLength(1);
    expect(sweepPageJobs(h)[0]?.dueAt.getTime()).toBe(added);

    await h.crawlUntil(added + 2 * HOUR);
    const sweep = (await h.json("GET", `/searches/${second.id}`)).body.sweep;
    expect(sweep).toMatchObject({ status: "scheduled", mode: "daily" });
    expect(new Date(sweep.lastFinishedAt).getTime()).toBeLessThan(added + 2 * HOUR);
    const firstSweep = (await h.json("GET", `/searches/${first.id}`)).body.sweep;
    expect(sweepPageJobs(h).map((job) => job.dueAt.getTime())).toContain(
      new Date(firstSweep.startAt).getTime(),
    );
  });

  it("shows the Sweep on the Search: the backfill, then the next daily Sweep", async () => {
    const h = boot();
    h.site.listing = h.cards(9003000, 12);
    const search = await h.addSearch();
    const created = (await h.json("GET", `/searches/${search.id}`)).body.sweep;
    expect(created).toMatchObject({
      status: "scheduled",
      mode: "backfill",
      pagesRead: 0,
      lastFinishedAt: null,
    });
    expect(new Date(created.startAt).getTime()).toBe(h.clock.now);

    await h.crawlUntil(berlin(5, 6));
    const next = (await h.json("GET", `/searches/${search.id}`)).body.sweep;
    expect(next).toMatchObject({ status: "scheduled", mode: "daily", pagesRead: 0 });
    expect(new Date(next.startAt).getTime()).toBeGreaterThanOrEqual(berlin(5, 7));
    expect(new Date(next.startAt).getTime()).toBeLessThan(berlin(5, 7) + 3 * HOUR);
    expect(new Date(next.lastFinishedAt).getTime()).toBeLessThan(berlin(5, 0) + DAY);
  });
});
