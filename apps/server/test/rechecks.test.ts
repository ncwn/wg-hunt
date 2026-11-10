import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { jobPriority } from "../src/crawl/constants.js";
import { RECHECK_RETRY_HOURS } from "../src/crawl/rechecks.js";
import { crawlJobs, crawlRequests, offerAds, searchMatches, seenAds } from "../src/db/schema.js";
import { adapterFixture } from "./fixtures/search-pages.js";
import { DAY, HOUR, MINUTE, settledRooms } from "./recheck-harness.js";

const ORIGINAL_TITLE = "Helles Zimmer in ruhiger Studenten-WG";
const NEW_PAGE = { title: "Frisch renoviert, ruhig", warmRent: 450 };

describe("automatic Rechecks", () => {
  it("reads the page again when an Offer is Bumped and its card changed", async () => {
    const w = await settledRooms(9003000, 5);
    expect(w.requestsOf("recheck")).toEqual([]);
    expect((await w.offerOf(9003002)).priceHistory).toHaveLength(1);

    w.bump(9003002, { title: "Zimmer 9003002, jetzt günstiger" }, NEW_PAGE);
    const from = w.clock.now;
    await w.crawlUntil(from + 2 * HOUR);

    expect(w.requestsOf("recheck", from)).toHaveLength(1);
    expect(w.rechecksOf(9003002, from)).toHaveLength(1);
    const offer = await w.offerOf(9003002);
    expect(offer.title).toBe(NEW_PAGE.title);
    expect(offer.priceHistory.map((p: { warmRent: number }) => p.warmRent)).toEqual([489, 450]);
    expect(offer.textHistory.map((v: { title: string }) => v.title)).toEqual([
      ORIGINAL_TITLE,
      NEW_PAGE.title,
    ]);

    await w.crawlUntil(w.clock.now + 6 * HOUR);
    expect(w.requestsOf("recheck", from)).toHaveLength(1);
  });

  it("leaves a Bumped Offer alone while its card is unchanged and its page is fresh", async () => {
    const w = await settledRooms(9003000, 5);
    w.bump(9003001);
    const from = w.clock.now;
    await w.crawlUntil(from + 3 * HOUR);
    expect(w.requestsOf("recheck", from)).toEqual([]);
    expect(new Date((await w.offerOf(9003001)).lastBumpAt).getTime()).toBeGreaterThan(from - HOUR);
  });

  it("reads the page again when a Bumped Offer's stored page is more than 72 h old", async () => {
    const w = await settledRooms(9003000, 5);
    await w.crawlUntil(w.clock.now + 3 * DAY + 12 * HOUR);
    expect(w.requestsOf("recheck")).toEqual([]);

    // It is the middle of the night: the next poll is in the morning.
    w.bump(9003001);
    const from = w.clock.now;
    await w.crawlUntil(from + 12 * HOUR);
    expect(w.rechecksOf(9003001, from)).toHaveLength(1);
    expect(w.requestsOf("recheck", from)).toHaveLength(1);
  });

  it("goes by the page age in the settings", async () => {
    const w = await settledRooms(9003000, 5);
    w.settings({ enabled: true, maxPageAgeHours: 1 });
    await w.crawlUntil(w.clock.now + HOUR);
    w.bump(9003001);
    const from = w.clock.now;
    await w.crawlUntil(from + 3 * HOUR);
    expect(w.rechecksOf(9003001, from)).toHaveLength(1);
  });

  it("serves the oldest stored page first", async () => {
    const w = await settledRooms(9003000, 5);
    // 9003004 is Bumped first, but 9003001's page was fetched earlier.
    w.bump(9003004, { title: "Zimmer 9003004 neu" }, NEW_PAGE);
    w.bump(9003001, { title: "Zimmer 9003001 neu" }, NEW_PAGE);
    const from = w.clock.now;
    await w.crawlUntil(from + 3 * HOUR);
    const order = w.requestsOf("recheck", from).map((r) => /\.(\d+)\.html$/.exec(r.path)?.[1]);
    expect(order).toEqual(["9003001", "9003004"]);
  });

  it("runs only on budget the day's polls, Sweeps and new Offers leave over", async () => {
    const w = await settledRooms(9003000, 5);
    // 40 requests a day cannot even cover the polls, Sweeps and new Offers still to come.
    w.pacing({ dailyCap: 40 });
    w.bump(9003002, { title: "Zimmer 9003002 neu" }, NEW_PAGE);
    const from = w.clock.now;
    await w.crawlUntil(from + 3 * HOUR);
    expect(w.requestsOf("recheck", from)).toEqual([]);
    expect(w.requestsOf("poll", from).length).toBeGreaterThan(0);

    w.pacing({ dailyCap: 600 });
    await w.crawlUntil(w.clock.now + 2 * HOUR);
    expect(w.rechecksOf(9003002, from)).toHaveLength(1);
  });

  it("has the same room with an enabled Search the Source cannot read as without it", async () => {
    const w = await settledRooms(9003000, 5);
    // In every category, but the adapter has no id for the city: it sends nothing, so it needs
    // nothing. Counted, its share would leave no room at all under this cap.
    await w.addSearch({
      city: "Teststadt",
      categories: ["flatshare-room", "one-room-flat", "flat", "house"],
      pollInterval: { minMinutes: 30, maxMinutes: 60 },
    });
    w.pacing({ dailyCap: 200 });
    w.bump(9003002, { title: "Zimmer 9003002 neu" }, NEW_PAGE);
    const from = w.clock.now;
    await w.crawlUntil(from + 3 * HOUR);
    expect(w.rechecksOf(9003002, from)).toHaveLength(1);
  });

  it("runs no Rechecks at all while they are switched off", async () => {
    const w = await settledRooms(9003000, 5);
    w.settings({ enabled: false, maxPageAgeHours: 72 });
    w.bump(9003002, { title: "Zimmer 9003002 neu" }, NEW_PAGE);
    const from = w.clock.now;
    await w.crawlUntil(from + 3 * HOUR);
    expect(w.requestsOf("recheck", from)).toEqual([]);
    expect((await w.offerOf(9003002)).title).toBe(ORIGINAL_TITLE);

    w.settings({ enabled: true, maxPageAgeHours: 72 });
    await w.crawlUntil(w.clock.now + 2 * HOUR);
    expect(w.rechecksOf(9003002, from)).toHaveLength(1);
  });

  it("skips an Offer that no enabled Search matches any more", async () => {
    const w = await settledRooms(9003000, 5);
    w.pacing({ dailyCap: 40 });
    w.bump(9003002, { title: "Zimmer 9003002 neu" }, NEW_PAGE);
    w.bump(9003003, { title: "Zimmer 9003003 neu" }, NEW_PAGE);
    const from = w.clock.now;
    await w.crawlUntil(from + 2 * HOUR);
    w.rooms.delete(9003002);
    w.runtime.db.delete(searchMatches).where(eq(searchMatches.adId, "9003002")).run();
    expect((await w.offerOf(9003002)).tracked).toBe(false);

    w.pacing({ dailyCap: 600 });
    await w.crawlUntil(w.clock.now + 2 * HOUR);
    expect(w.rechecksOf(9003003, from)).toHaveLength(1);
    expect(w.rechecksOf(9003002, from)).toEqual([]);
  });

  it("does not try a failing page again straight away", async () => {
    const w = await settledRooms(9003000, 5);
    w.bump(9003002, { title: "Zimmer 9003002 neu" }, NEW_PAGE);
    w.site.failNext.push({ match: /\.9003002\.html$/, status: 500 });
    const from = w.clock.now;
    await w.crawlUntil(from + 3 * HOUR);
    expect(w.rechecksOf(9003002, from)).toHaveLength(1);
    expect((await w.offerOf(9003002)).title).toBe(ORIGINAL_TITLE);

    await w.crawlUntil(from + 10 * HOUR);
    expect(w.rechecksOf(9003002, from).length).toBeGreaterThanOrEqual(2);
    expect((await w.offerOf(9003002)).title).toBe(NEW_PAGE.title);
  });
});

describe("a changed text", () => {
  const stateOf = (w: Awaited<ReturnType<typeof settledRooms>>, adId: number) =>
    w.runtime.db.$client
      .prepare(
        "select analysisState as state from offers where id = (select offerId from offer_ads where adId = ?)",
      )
      .get(String(adId)) as { state: string };
  const markAnalysed = (w: Awaited<ReturnType<typeof settledRooms>>) =>
    w.runtime.db.$client
      .prepare(
        `update offers set analysisState = 'analyzed',
           analysis = json_object('run', json_object('contentHash',
             (select contentHash from offer_ads where offer_ads.offerId = offers.id limit 1)))`,
      )
      .run();

  it("sends the Offer back to the model pass when a Recheck finds new words", async () => {
    const w = await settledRooms(9003000, 5);
    markAnalysed(w);
    w.bump(9003002, { title: "Zimmer 9003002 neu" }, NEW_PAGE);
    await w.crawlUntil(w.clock.now + 2 * HOUR);
    expect(w.rechecksOf(9003002)).toHaveLength(1);
    await w.runtime.analysis.idle();
    expect(stateOf(w, 9003002).state).toBe("pending");
    expect(stateOf(w, 9003000).state).toBe("analyzed");
  });

  it("leaves the analysis alone when the words are the same", async () => {
    const w = await settledRooms(9003000, 5);
    markAnalysed(w);
    w.bump(
      9003002,
      { title: "Zimmer 9003002 neu" },
      {
        title: "Helles Zimmer in ruhiger Studenten-WG",
        warmRent: 450,
      },
    );
    await w.crawlUntil(w.clock.now + 2 * HOUR);
    expect(w.rechecksOf(9003002)).toHaveLength(1);
    await w.runtime.analysis.idle();
    expect(stateOf(w, 9003002).state).toBe("analyzed");
  });
});

describe("POST /offers/{id}/recheck", () => {
  it("queues one Recheck at Recheck priority, even with automatic Rechecks switched off", async () => {
    const w = await settledRooms(9003000, 5);
    w.settings({ enabled: false, maxPageAgeHours: 72 });
    const offer = await w.offerOf(9003001);
    const from = w.clock.now;

    const first = await w.json("POST", `/offers/${offer.id}/recheck`);
    expect(first.status).toBe(202);
    expect(first.body.queued).toBe(true);
    expect((await w.json("POST", `/offers/${offer.id}/recheck`)).status).toBe(202);
    const jobs = w.runtime.db.select().from(crawlJobs).where(eq(crawlJobs.kind, "recheck")).all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.priority).toBe(4);

    await w.crawlUntil(from + HOUR);
    expect(w.rechecksOf(9003001, from)).toHaveLength(1);
  });

  it("re-reads the page: the Offer shows what it says now", async () => {
    const w = await settledRooms(9003000, 5);
    w.site.pages.set(9003001, (await import("./fixtures/search-pages.js")).offerPageWith(NEW_PAGE));
    const offer = await w.offerOf(9003001);
    await w.json("POST", `/offers/${offer.id}/recheck`);
    await w.crawlUntil(w.clock.now + HOUR);
    expect((await w.offerOf(9003001)).title).toBe(NEW_PAGE.title);
  });

  it("answers not-found for an Offer that does not exist", async () => {
    const w = await settledRooms(9003000, 1);
    const res = await w.json("POST", "/offers/9999/recheck");
    expect(res.status).toBe(404);
  });

  it("refuses an Offer no enabled Search matches: Untracked Offers are never crawled", async () => {
    const w = await settledRooms(9003000, 2);
    const offer = await w.offerOf(9003000);
    await w.json("PATCH", "/searches/1", { enabled: false });
    expect((await w.offerOf(9003000)).tracked).toBe(false);

    const res = await w.json("POST", `/offers/${offer.id}/recheck`);
    expect(res.status).toBe(409);
    expect(res.body.type).toBe("offer-untracked");
    expect(
      w.runtime.db.select().from(crawlJobs).where(eq(crawlJobs.kind, "recheck")).all(),
    ).toEqual([]);
  });
});

describe("the Offer's Recheck state", () => {
  it("is queued once asked for, then idle with a newer page and update time once it ran", async () => {
    const w = await settledRooms(9003000, 2);
    w.site.pages.set(9003001, (await import("./fixtures/search-pages.js")).offerPageWith(NEW_PAGE));
    const before = await w.offerOf(9003001);
    expect(before.recheck).toMatchObject({ state: "idle", manual: false, lastFailedAt: null });

    await w.json("POST", `/offers/${before.id}/recheck`);
    expect((await w.offerOf(9003001)).recheck).toMatchObject({ state: "queued", manual: true });

    await w.crawlUntil(w.clock.now + HOUR);
    const after = await w.offerOf(9003001);
    expect(after.recheck).toMatchObject({ state: "idle", lastFailedAt: null, retryAfter: null });
    expect(Date.parse(after.recheck.pageFetchedAt)).toBeGreaterThan(
      Date.parse(before.recheck.pageFetchedAt),
    );
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt));
    expect(after.title).toBe(NEW_PAGE.title);
  });

  it("is in flight while its request is out", async () => {
    const w = await settledRooms(9003000, 1);
    const offer = await w.offerOf(9003000);
    await w.json("POST", `/offers/${offer.id}/recheck`);
    const [job] = w.runtime.db.select().from(crawlJobs).where(eq(crawlJobs.kind, "recheck")).all();
    // What the engine writes as the request goes out, before any answer.
    w.runtime.db
      .insert(crawlRequests)
      .values({
        at: new Date(w.clock.now),
        kind: "recheck",
        path: job?.path ?? "",
        outcome: "pending",
      })
      .run();
    expect((await w.offerOf(9003000)).recheck.state).toBe("in-flight");
  });

  it("is failed until the retry time after a Recheck that got no page", async () => {
    const w = await settledRooms(9003000, 1);
    const offer = await w.offerOf(9003000);
    w.site.failNext.push({ match: /\.9003000\.html$/, status: 500 });
    await w.json("POST", `/offers/${offer.id}/recheck`);
    await w.crawlUntil(w.clock.now + HOUR);

    const { recheck } = await w.offerOf(9003000);
    expect(recheck.state).toBe("failed");
    expect(Date.parse(recheck.retryAfter) - Date.parse(recheck.lastFailedAt)).toBe(
      RECHECK_RETRY_HOURS * HOUR,
    );
    w.clock.now = Date.parse(recheck.retryAfter) + 1;
    expect((await w.offerOf(9003000)).recheck).toMatchObject({ state: "idle" });
  });
});

const recheckJobs = (w: Awaited<ReturnType<typeof settledRooms>>) =>
  w.runtime.db
    .select()
    .from(crawlJobs)
    .where(eq(crawlJobs.kind, "recheck"))
    .all()
    .map((job) => ({ ...job, payload: JSON.parse(job.payload ?? "null") }));

const AHEAD = jobPriority("new-offer");
const LAST = jobPriority("recheck");

describe("a returning Stale Ad ID's re-read", () => {
  async function returning() {
    const w = await settledRooms(9003000, 1);
    w.runtime.db
      .update(offerAds)
      .set({ lastBumpAt: new Date(w.clock.now - 9 * DAY) })
      .where(eq(offerAds.adId, "9003000"))
      .run();
    const offer = await w.offerOf(9003000);
    expect(offer.stale).toBe(true);
    w.runtime.rechecks.queueReturning("wg-gesucht", "9003000");
    const [job] = recheckJobs(w);
    return { w, offer, job };
  }

  it("is a Recheck served where a new Offer's page is, and shows as queued, then in flight", async () => {
    const { w, job } = await returning();
    expect(job).toMatchObject({ priority: AHEAD, payload: { reason: "returning" } });
    expect(
      w.runtime.db.select().from(crawlJobs).where(eq(crawlJobs.kind, "new-offer")).all(),
    ).toEqual([]);
    expect((await w.offerOf(9003000)).recheck).toMatchObject({ state: "queued", manual: false });

    w.runtime.db
      .insert(crawlRequests)
      .values({
        at: new Date(w.clock.now),
        kind: "recheck",
        path: job?.path ?? "",
        outcome: "pending",
      })
      .run();
    expect((await w.offerOf(9003000)).recheck.state).toBe("in-flight");
  });

  it("is listed among the next jobs and in the request log as a Recheck", async () => {
    const { w, job } = await returning();
    const next = (await w.json("GET", "/crawl")).body.nextJobs as { kind: string; path: string }[];
    expect(next.find((each) => each.path === job?.path)?.kind).toBe("recheck");

    const from = w.clock.now;
    await w.crawlUntil(from + HOUR);
    expect(w.rechecksOf(9003000, from)).toHaveLength(1);
    expect(w.requestsOf("new-offer", from)).toEqual([]);
    expect((await w.offerOf(9003000)).stale).toBe(false);
  });

  it("is read whatever the Recheck switch says", async () => {
    const { w } = await returning();
    w.settings({ enabled: false, maxPageAgeHours: 72 });
    w.runtime.rechecks.sync();
    const from = w.clock.now;
    await w.crawlUntil(from + HOUR);
    expect(w.rechecksOf(9003000, from)).toHaveLength(1);
  });

  it("takes a Recheck press into the job that waits, which is then manual and reads the page once", async () => {
    const { w, offer } = await returning();
    const res = await w.json("POST", `/offers/${offer.id}/recheck`);
    expect(res.status).toBe(202);
    expect(res.body.alreadyQueued).toBe(true);
    expect(recheckJobs(w)).toMatchObject([{ priority: AHEAD, payload: { reason: "manual" } }]);
    expect((await w.offerOf(9003000)).recheck).toMatchObject({ state: "queued", manual: true });

    const from = w.clock.now;
    await w.crawlUntil(from + HOUR);
    expect(w.pageFetches(9003000, from)).toBe(1);
    expect((await w.offerOf(9003000)).recheck).toMatchObject({ state: "idle", manual: false });
  });

  it("ends a press folded into it as failed when the page gives nothing", async () => {
    const { w, offer } = await returning();
    await w.json("POST", `/offers/${offer.id}/recheck`);
    expect((await w.offerOf(9003000)).recheck).toMatchObject({ state: "queued", manual: true });
    w.site.failNext.push({ match: /\.9003000\.html$/, status: 500 });
    const from = w.clock.now;
    await w.crawlUntil(from + 3 * HOUR);

    expect(w.requestsOf("poll", from).length).toBeGreaterThanOrEqual(2);
    expect(w.pageFetches(9003000, from)).toBe(1);
    const { recheck } = await w.offerOf(9003000);
    expect(recheck.state).toBe("failed");
    expect(Date.parse(recheck.lastFailedAt)).toBeGreaterThanOrEqual(from);
    expect(Date.parse(recheck.retryAfter) - Date.parse(recheck.lastFailedAt)).toBe(
      RECHECK_RETRY_HOURS * HOUR,
    );
  });

  it("puts a press folded into it back, manual and in its place, when a Bot check drops it", async () => {
    const { w, offer } = await returning();
    const before = (await w.offerOf(9003000)).recheck;
    await w.json("POST", `/offers/${offer.id}/recheck`);
    w.site.failNext.push({ match: /\.9003000\.html$/, status: 429 });
    const from = w.clock.now;
    await w.crawlUntil(from + HOUR);
    expect(w.rechecksOf(9003000, from)).toHaveLength(1);
    expect((await w.json("GET", "/crawl")).body.state).toBe("cooling-down");

    expect((await w.offerOf(9003000)).recheck).toMatchObject({ state: "queued", manual: true });
    expect(recheckJobs(w)).toMatchObject([{ priority: AHEAD, payload: { reason: "manual" } }]);

    await w.crawlUntil(from + 2 * DAY);
    expect(w.rechecksOf(9003000, from)).toHaveLength(2);
    const after = (await w.offerOf(9003000)).recheck;
    expect(after.state).toBe("idle");
    expect(Date.parse(after.pageFetchedAt)).toBeGreaterThan(Date.parse(before.pageFetchedAt));
  });

  it("keeps a press made while its request is out, should a Bot check drop that request", async () => {
    const { w, job } = await returning();
    w.site.failNext.push({ match: /\.9003000\.html$/, status: 429 });
    // The press arrives after the page's request goes out, before its answer.
    let out = w.runtime.crawl.step();
    for (let i = 0; i < 10 && w.sent.at(-1)?.path !== job?.path; i++) {
      await out;
      w.clock.now += MINUTE;
      out = w.runtime.crawl.step();
    }
    expect(w.sent.at(-1)?.path).toBe(job?.path);
    expect(w.runtime.rechecks.request("wg-gesucht", "9003000")).toEqual({ alreadyQueued: true });
    await out;

    expect((await w.json("GET", "/crawl")).body.state).toBe("cooling-down");
    expect((await w.offerOf(9003000)).recheck).toMatchObject({ state: "queued", manual: true });
    expect(recheckJobs(w)).toMatchObject([{ priority: AHEAD, payload: { reason: "manual" } }]);
  });

  it("is put back in its place when a Bot check drops it, though nobody pressed Recheck", async () => {
    const { w } = await returning();
    w.site.failNext.push({ match: /\.9003000\.html$/, status: 429 });
    const from = w.clock.now;
    await w.crawlUntil(from + HOUR);
    expect((await w.json("GET", "/crawl")).body.state).toBe("cooling-down");
    expect(recheckJobs(w)).toMatchObject([{ priority: AHEAD, payload: { reason: "returning" } }]);
    expect((await w.offerOf(9003000)).recheck).toMatchObject({
      state: "queued",
      manual: false,
      lastFailedAt: null,
    });

    await w.crawlUntil(from + 2 * DAY);
    expect(w.rechecksOf(9003000, from)).toHaveLength(2);
    expect((await w.offerOf(9003000)).stale).toBe(false);
  });

  it("is read after the Cooldown when a Bot check dropped it and no later card asks for it", async () => {
    const w = await settledRooms(9003000, 1);
    w.settings({ enabled: false, maxPageAgeHours: 72 });
    const old = w.clock.now - 9 * DAY;
    w.runtime.db
      .update(offerAds)
      .set({ lastBumpAt: new Date(old) })
      .where(eq(offerAds.adId, "9003000"))
      .run();
    w.runtime.db
      .update(seenAds)
      .set({ onlineEarliest: new Date(old - DAY), onlineLatest: new Date(old) })
      .where(eq(seenAds.adId, "9003000"))
      .run();
    w.edit(9003000, { publishedAt: old });
    const before = await w.offerOf(9003000);
    expect(before.stale).toBe(true);

    w.bump(9003000);
    w.site.failNext.push({ match: /\.9003000\.html$/, status: 429 });
    const from = w.clock.now;
    await w.crawlUntil(from + 90 * MINUTE);
    expect(w.rechecksOf(9003000, from)).toHaveLength(1);
    expect((await w.json("GET", "/crawl")).body.state).toBe("cooling-down");
    expect((await w.offerOf(9003000)).stale).toBe(false);
    expect(recheckJobs(w)).toMatchObject([{ priority: AHEAD, payload: { reason: "returning" } }]);

    await w.crawlUntil(from + 2 * DAY);
    expect(w.rechecksOf(9003000, from)).toHaveLength(2);
    const after = (await w.offerOf(9003000)).recheck;
    expect(after).toMatchObject({ state: "idle", lastFailedAt: null });
    expect(Date.parse(after.pageFetchedAt)).toBeGreaterThan(
      Date.parse(before.recheck.pageFetchedAt),
    );
  });

  it("moves a manual Recheck that waits up to its place, and leaves it manual", async () => {
    const w = await settledRooms(9003000, 1);
    const offer = await w.offerOf(9003000);
    await w.json("POST", `/offers/${offer.id}/recheck`);
    expect(recheckJobs(w)).toMatchObject([{ priority: LAST, payload: { reason: "manual" } }]);

    w.runtime.rechecks.queueReturning("wg-gesucht", "9003000");
    expect(recheckJobs(w)).toMatchObject([{ priority: AHEAD, payload: { reason: "manual" } }]);
  });

  it("leaves a Recheck that waits where it was when the queue refuses its card's path", async () => {
    const w = await settledRooms(9003000, 1);
    const offer = await w.offerOf(9003000);
    await w.json("POST", `/offers/${offer.id}/recheck`);
    const before = recheckJobs(w);
    const seen = w.runtime.db.select().from(seenAds).where(eq(seenAds.adId, "9003000")).get();
    w.runtime.db
      .update(seenAds)
      .set({
        card: JSON.stringify({ ...JSON.parse(seen?.card ?? "{}"), path: "/api/9003000.html" }),
      })
      .where(eq(seenAds.adId, "9003000"))
      .run();

    expect(() => w.runtime.rechecks.queueReturning("wg-gesucht", "9003000")).toThrow();
    expect(recheckJobs(w)).toEqual(before);
  });

  it("takes over an automatic Recheck that waits for the same page, under the path its card shows now", async () => {
    const w = await settledRooms(9003000, 1);
    // The page was first fetched under another path than the one its cards show today.
    const fetchedUnder = "/wg-zimmer-in-Teststadt-Nord.9003000.html";
    const listedUnder = "/wg-zimmer-in-Teststadt-Mitte.9003000.html";
    w.runtime.db
      .update(offerAds)
      .set({ lastBumpAt: new Date(w.clock.now), pageCardKey: null, path: fetchedUnder })
      .where(eq(offerAds.adId, "9003000"))
      .run();
    w.runtime.rechecks.sync();
    expect(recheckJobs(w)).toMatchObject([
      { priority: LAST, path: fetchedUnder, payload: { reason: "automatic" } },
    ]);

    w.runtime.rechecks.queueReturning("wg-gesucht", "9003000");
    expect(recheckJobs(w)).toMatchObject([
      { priority: AHEAD, path: listedUnder, payload: { reason: "returning" } },
    ]);
    w.settings({ enabled: false, maxPageAgeHours: 72 });
    w.runtime.rechecks.sync();
    expect(recheckJobs(w)).toMatchObject([{ priority: AHEAD, payload: { reason: "returning" } }]);

    const offer = await w.offerOf(9003000);
    await w.json("POST", `/offers/${offer.id}/recheck`);
    expect(recheckJobs(w)).toMatchObject([
      { priority: AHEAD, path: listedUnder, payload: { reason: "manual" } },
    ]);
  });

  it("takes no automatic Recheck's place in the day's budget while it waits", async () => {
    const w = await settledRooms(9003000, 3);
    for (const adId of ["9003000", "9003001"]) {
      w.runtime.db
        .update(offerAds)
        .set({ lastBumpAt: new Date(w.clock.now), pageCardKey: null })
        .where(eq(offerAds.adId, adId))
        .run();
    }
    const reasons = () => recheckJobs(w).map((job) => job.payload.reason);
    const lookAgain = (kept: () => void = () => {}) => {
      w.runtime.db.delete(crawlJobs).where(eq(crawlJobs.kind, "recheck")).run();
      kept();
      w.runtime.rechecks.sync();
      return reasons();
    };
    while (lookAgain().length > 1) {
      w.runtime.db
        .insert(crawlRequests)
        .values({ at: new Date(w.clock.now), kind: "poll", path: "/sent.html", outcome: "ok" })
        .run();
    }
    expect(lookAgain()).toEqual(["automatic"]);

    const withReturning = lookAgain(() =>
      w.runtime.rechecks.queueReturning("wg-gesucht", "9003002"),
    );
    expect(withReturning.sort()).toEqual(["automatic", "returning"]);
  });

  it("waits out the Recheck backoff after a failure, however many polls show its card", async () => {
    const w = await settledRooms(9003000, 2);
    w.runtime.db
      .update(offerAds)
      .set({ pageStatus: "deactivated" })
      .where(eq(offerAds.adId, "9003000"))
      .run();
    for (let i = 0; i < 20; i++) w.site.failNext.push({ match: /\.9003000\.html$/, status: 500 });
    const fetches = (from: number) =>
      w.sent.filter((r) => r.at >= from && r.path.endsWith(".9003000.html")).map((r) => r.at);

    const from = w.clock.now;
    await w.crawlUntil(from + 5 * HOUR);
    expect(w.requestsOf("poll", from).length).toBeGreaterThanOrEqual(4);
    expect(fetches(from)).toHaveLength(1);
    expect((await w.offerOf(9003000)).recheck).toMatchObject({ state: "failed", manual: false });

    await w.crawlUntil(from + 9 * HOUR);
    const [first, second, ...more] = fetches(from);
    expect(more).toEqual([]);
    expect((second as number) - (first as number)).toBeGreaterThanOrEqual(
      RECHECK_RETRY_HOURS * HOUR,
    );
  });

  it("is read at once on a Recheck press, though it was put off until the retry time", async () => {
    const w = await settledRooms(9003000, 1);
    w.runtime.db
      .update(offerAds)
      .set({ pageStatus: "deactivated" })
      .where(eq(offerAds.adId, "9003000"))
      .run();
    w.site.failNext.push({ match: /\.9003000\.html$/, status: 500 });
    const from = w.clock.now;
    await w.crawlUntil(from + 2 * HOUR);
    const failed = await w.offerOf(9003000);
    expect(failed.recheck.state).toBe("failed");
    expect(recheckJobs(w)).toMatchObject([
      { payload: { reason: "returning" }, dueAt: new Date(failed.recheck.retryAfter) },
    ]);

    const pressed = w.clock.now;
    const res = await w.json("POST", `/offers/${failed.id}/recheck`);
    expect(res.body.alreadyQueued).toBe(true);
    expect((await w.offerOf(9003000)).recheck).toMatchObject({ state: "queued", manual: true });
    await w.crawlUntil(pressed + 30 * MINUTE);
    expect(w.pageFetches(9003000, pressed)).toBe(1);
    expect((await w.offerOf(9003000)).recheck).toMatchObject({ state: "idle", lastFailedAt: null });
  });

  it("is read once the backoff is over when the one card that asked for it came in the middle of it", async () => {
    const w = await settledRooms(9003000, 1);
    w.settings({ enabled: false, maxPageAgeHours: 72 });
    const old = w.clock.now - 9 * DAY;
    w.runtime.db
      .update(offerAds)
      .set({ lastBumpAt: new Date(old) })
      .where(eq(offerAds.adId, "9003000"))
      .run();
    w.runtime.db
      .update(seenAds)
      .set({ onlineEarliest: new Date(old - DAY), onlineLatest: new Date(old) })
      .where(eq(seenAds.adId, "9003000"))
      .run();
    w.edit(9003000, { publishedAt: old });
    const offer = await w.offerOf(9003000);
    expect(offer.stale).toBe(true);

    w.site.failNext.push({ match: /\.9003000\.html$/, status: 500 });
    const from = w.clock.now;
    await w.json("POST", `/offers/${offer.id}/recheck`);
    await w.crawlUntil(from + 90 * MINUTE);
    const failed = (await w.offerOf(9003000)).recheck;
    expect(failed.state).toBe("failed");
    expect(w.pageFetches(9003000, from)).toBe(1);

    w.bump(9003000);
    const retryAfter = Date.parse(failed.retryAfter);
    await w.crawlUntil(retryAfter - MINUTE);
    expect((await w.offerOf(9003000)).stale).toBe(false);
    expect(w.pageFetches(9003000, from)).toBe(1);
    expect((await w.offerOf(9003000)).recheck).toMatchObject({ state: "failed", manual: false });

    await w.crawlUntil(retryAfter + HOUR);
    expect(w.pageFetches(9003000, from)).toBe(2);
    expect((await w.offerOf(9003000)).recheck).toMatchObject({ state: "idle", lastFailedAt: null });
  });

  it("does not leave the old page for the next boot when the new one says deleted and the Offers step fails", async () => {
    const { w } = await returning();
    w.site.pages.set(
      9003000,
      (await import("./fixtures/search-pages.js")).adapterFixture("deleted"),
    );
    const ingest = w.runtime.offers.ingest;
    w.runtime.offers.ingest = () => {
      throw new Error("broken Offers step");
    };
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await w.crawlUntil(w.clock.now + HOUR);
    quiet.mockRestore();
    w.runtime.offers.ingest = ingest;

    const seen = w.runtime.db.select().from(seenAds).where(eq(seenAds.adId, "9003000")).get();
    expect(seen?.ingestedAt).not.toBeNull();
    const before = await w.offerOf(9003000);
    await w.runtime.offers.adoptStoredPages();
    expect((await w.offerOf(9003000)).updatedAt).toBe(before.updatedAt);
  });
});

describe("a returning Stale Ad ID's re-read, after a Recheck that read the page fine", () => {
  async function listedThoughDeactivated() {
    const w = await settledRooms(9003000, 2);
    w.site.pages.set(9003000, adapterFixture("deactivated"));
    w.runtime.db
      .update(offerAds)
      .set({ pageStatus: "deactivated" })
      .where(eq(offerAds.adId, "9003000"))
      .run();
    const fetches = (from: number) =>
      w.sent.filter((r) => r.at >= from && r.path.endsWith(".9003000.html")).map((r) => r.at);
    return { w, fetches };
  }

  it("is fetched once, then not again for six hours, over a day of polls that list its card", async () => {
    const { w, fetches } = await listedThoughDeactivated();
    const from = w.clock.now;
    await w.crawlUntil(from + 5 * HOUR);
    expect(w.requestsOf("poll", from).length).toBeGreaterThanOrEqual(4);
    expect(fetches(from)).toHaveLength(1);
    expect(await w.offerOf(9003000)).toMatchObject({ pageStatus: "deactivated", stale: true });

    await w.crawlUntil(from + DAY);
    const at = fetches(from);
    expect(at.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < at.length; i++) {
      expect((at[i] as number) - (at[i - 1] as number)).toBeGreaterThanOrEqual(
        RECHECK_RETRY_HOURS * HOUR,
      );
    }
  });

  it("is queued for six hours after that read by the next card, and the Offer says idle meanwhile", async () => {
    const { w, fetches } = await listedThoughDeactivated();
    const from = w.clock.now;
    await w.crawlUntil(from + 3 * HOUR);
    const [read, ...more] = fetches(from);
    expect(more).toEqual([]);
    expect(recheckJobs(w)).toMatchObject([
      {
        priority: AHEAD,
        payload: { reason: "returning" },
        dueAt: new Date((read as number) + RECHECK_RETRY_HOURS * HOUR),
      },
    ]);
    expect((await w.offerOf(9003000)).recheck).toMatchObject({
      state: "idle",
      manual: false,
      lastFailedAt: null,
      retryAfter: null,
    });

    w.clock.now = (read as number) + RECHECK_RETRY_HOURS * HOUR;
    expect((await w.offerOf(9003000)).recheck).toMatchObject({ state: "queued", manual: false });
  });

  it("is read at once on a Recheck press made during that wait", async () => {
    const { w, fetches } = await listedThoughDeactivated();
    const from = w.clock.now;
    await w.crawlUntil(from + 2 * HOUR);
    expect(fetches(from)).toHaveLength(1);

    const pressed = w.clock.now;
    const offer = await w.offerOf(9003000);
    const res = await w.json("POST", `/offers/${offer.id}/recheck`);
    expect(res.status).toBe(202);
    expect((await w.offerOf(9003000)).recheck).toMatchObject({ state: "queued", manual: true });
    await w.crawlUntil(pressed + 30 * MINUTE);
    expect(fetches(pressed)).toHaveLength(1);

    await w.crawlUntil(pressed + 5 * HOUR);
    expect(w.requestsOf("poll", pressed).length).toBeGreaterThanOrEqual(4);
    expect(fetches(pressed)).toHaveLength(1);
  });

  it("waits out a Recheck that read the page under the path it was stored with, not the card's", async () => {
    const w = await settledRooms(9003000, 1);
    // No poll gets in the way: the card that asks is the call below.
    await w.json("PATCH", "/searches/1", { pollInterval: { minMinutes: 1440, maxMinutes: 1440 } });
    const storedUnder = "/wg-zimmer-in-Teststadt-Nord.9003000.html";
    w.runtime.db
      .update(offerAds)
      .set({ path: storedUnder, lastBumpAt: new Date(w.clock.now - 9 * DAY) })
      .where(eq(offerAds.adId, "9003000"))
      .run();
    const offer = await w.offerOf(9003000);
    await w.json("POST", `/offers/${offer.id}/recheck`);
    const from = w.clock.now;
    await w.crawlUntil(from + HOUR);
    const [read] = w.rechecksOf(9003000, from);
    expect(read?.path).toBe(storedUnder);

    w.runtime.rechecks.queueReturning("wg-gesucht", "9003000");
    expect(recheckJobs(w)).toMatchObject([
      {
        payload: { reason: "returning" },
        dueAt: new Date((read?.at as number) + RECHECK_RETRY_HOURS * HOUR),
      },
    ]);
  });

  it("is not held by a Recheck request that a Bot check answered: no page was read", async () => {
    const w = await settledRooms(9003000, 1);
    const ad = w.runtime.db.select().from(offerAds).where(eq(offerAds.adId, "9003000")).get();
    w.runtime.db
      .insert(crawlRequests)
      .values({
        at: new Date(w.clock.now - HOUR),
        kind: "recheck",
        path: ad?.path ?? "",
        status: 429,
        outcome: "bot-check",
      })
      .run();
    w.runtime.rechecks.queueReturning("wg-gesucht", "9003000");
    expect(recheckJobs(w)).toMatchObject([
      { payload: { reason: "returning" }, dueAt: new Date(w.clock.now) },
    ]);
  });

  it("is not held by the page's first fetch three hours ago: only a Recheck of the page counts", async () => {
    const { w, fetches } = await listedThoughDeactivated();
    const fetchedAt = Date.parse((await w.offerOf(9003000)).recheck.pageFetchedAt);
    expect(w.clock.now - fetchedAt).toBeLessThan(RECHECK_RETRY_HOURS * HOUR);
    const from = w.clock.now;
    await w.crawlUntil(from + 2 * HOUR);
    expect(fetches(from)).toHaveLength(1);
  });
});

describe("a manual Recheck that meets a Bot check", () => {
  it("stays queued and goes out once the Cooldown is over", async () => {
    const w = await settledRooms(9003000, 1);
    w.settings({ enabled: false, maxPageAgeHours: 72 });
    const offer = await w.offerOf(9003000);
    const before = (await w.offerOf(9003000)).recheck;
    w.site.failNext.push({ match: /\.9003000\.html$/, status: 429 });
    const from = w.clock.now;
    await w.json("POST", `/offers/${offer.id}/recheck`);
    await w.crawlUntil(from + HOUR);
    expect(w.rechecksOf(9003000, from)).toHaveLength(1);
    expect((await w.json("GET", "/crawl")).body.state).toBe("cooling-down");

    expect((await w.offerOf(9003000)).recheck).toMatchObject({ state: "queued", manual: true });

    await w.crawlUntil(from + 2 * DAY);
    expect(w.rechecksOf(9003000, from)).toHaveLength(2);
    const after = (await w.offerOf(9003000)).recheck;
    expect(after.state).toBe("idle");
    expect(Date.parse(after.pageFetchedAt)).toBeGreaterThan(Date.parse(before.pageFetchedAt));
  });

  it("takes the place of an automatic Recheck that waits, due when that one was", async () => {
    const w = await settledRooms(9003000, 1);
    w.runtime.db
      .update(offerAds)
      .set({ lastBumpAt: new Date(w.clock.now), pageCardKey: null })
      .where(eq(offerAds.adId, "9003000"))
      .run();
    w.runtime.rechecks.sync();
    const [automatic] = recheckJobs(w);
    expect(automatic).toMatchObject({ payload: { reason: "automatic" } });
    expect(automatic?.dueAt.getTime()).toBeLessThan(w.clock.now);

    const offer = await w.offerOf(9003000);
    const res = await w.json("POST", `/offers/${offer.id}/recheck`);
    expect(res.body.alreadyQueued).toBe(true);
    expect(recheckJobs(w)).toMatchObject([
      { priority: LAST, dueAt: automatic?.dueAt, payload: { reason: "manual" } },
    ]);
  });

  it("stays manual when the page is also due for an automatic Recheck", async () => {
    const w = await settledRooms(9003000, 1);
    w.runtime.db
      .update(offerAds)
      .set({ lastBumpAt: new Date(w.clock.now), pageCardKey: null })
      .where(eq(offerAds.adId, "9003000"))
      .run();
    const offer = await w.offerOf(9003000);
    await w.json("POST", `/offers/${offer.id}/recheck`);
    w.site.failNext.push({ match: /\.9003000\.html$/, status: 429 });
    await w.crawlUntil(w.clock.now + HOUR);
    expect((await w.json("GET", "/crawl")).body.state).toBe("cooling-down");

    expect((await w.offerOf(9003000)).recheck).toMatchObject({ state: "queued", manual: true });
    expect(recheckJobs(w)).toMatchObject([{ priority: LAST, payload: { reason: "manual" } }]);
  });
});

describe("a Recheck whose Offers step fails", () => {
  it("leaves the new page to be adopted at the next boot instead of losing it", async () => {
    const w = await settledRooms(9003000, 1);
    const offer = await w.offerOf(9003000);
    w.site.pages.set(9003000, (await import("./fixtures/search-pages.js")).offerPageWith(NEW_PAGE));
    const ingest = w.runtime.offers.ingest;
    w.runtime.offers.ingest = () => {
      throw new Error("broken Offers step");
    };
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await w.json("POST", `/offers/${offer.id}/recheck`);
    await w.crawlUntil(w.clock.now + HOUR);
    quiet.mockRestore();
    w.runtime.offers.ingest = ingest;
    expect((await w.offerOf(9003000)).title).toBe(ORIGINAL_TITLE);
    const seen = w.runtime.db.select().from(seenAds).where(eq(seenAds.adId, "9003000")).get();
    expect(seen?.ingestedAt).toBeNull();

    await w.runtime.offers.adoptStoredPages();
    expect((await w.offerOf(9003000)).title).toBe(NEW_PAGE.title);
  });

  it("does not stand the old page in for a deleted one: the Recheck is tried again instead", async () => {
    const w = await settledRooms(9003000, 1);
    const offer = await w.offerOf(9003000);
    w.site.pages.set(
      9003000,
      (await import("./fixtures/search-pages.js")).adapterFixture("deleted"),
    );
    const ingest = w.runtime.offers.ingest;
    w.runtime.offers.ingest = () => {
      throw new Error("broken Offers step");
    };
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await w.json("POST", `/offers/${offer.id}/recheck`);
    await w.crawlUntil(w.clock.now + HOUR);
    quiet.mockRestore();
    w.runtime.offers.ingest = ingest;

    await w.runtime.offers.adoptStoredPages();
    const after = await w.offerOf(9003000);
    expect(after.recheck).toMatchObject({ state: "failed" });

    w.clock.now = Date.parse(after.recheck.retryAfter) + 1;
    await w.json("POST", `/offers/${offer.id}/recheck`);
    await w.crawlUntil(w.clock.now + HOUR);
    expect((await w.offerOf(9003000)).pageStatus).toBe("deleted");
  });
});
