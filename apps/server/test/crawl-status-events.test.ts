import { join } from "node:path";
import { fakeProviders } from "@wg-hunt/core/analysis/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCrawlEngine, type JobHandler } from "../src/crawl/engine.js";
import { removeJob } from "../src/crawl/queue.js";
import { type CrawlSettings, defaultCrawlSettings } from "../src/crawl/settings.js";
import type { CrawlStatus } from "../src/crawl/status.js";
import { type Db, openDatabase } from "../src/db/index.js";
import { createEventBus } from "../src/events.js";
import { type Runtime, startRuntime } from "../src/runtime.js";
import { tempDataDir } from "./helpers.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

// Mid-June, so Berlin is on summer time (UTC+2).
const MORNING = Date.parse("2026-06-10T06:00:00Z"); // 08:00 Berlin
const LATE = Date.parse("2026-06-10T21:58:00Z"); // 23:58 Berlin, after the active hours
const MIDNIGHT = Date.parse("2026-06-10T22:00:00Z");

/** Lets the publish that follows queued jobs go out: it waits for the current turn to end. */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(options: { start?: number } = {}) {
  const clock = { now: options.start ?? MORNING };
  const statuses: CrawlStatus[] = [];
  const db: Db = openDatabase(join(tempDataDir(), "status-events.sqlite"));
  const bus = createEventBus();
  bus.subscribe((e) => {
    if (e.type === "crawl-status-changed") statuses.push(e.data);
  });
  const loop = { until: 0 };
  const engine = createCrawlEngine({
    db,
    fetcher: { fetch: async () => ({ status: 200, body: "" }) },
    clock: () => clock.now,
    random: () => 0,
    events: bus,
    sleep: async (ms) => {
      clock.now += ms;
      if (clock.now > loop.until) await engine.stop();
    },
  });
  async function runUntil(until: number) {
    loop.until = until;
    await engine.start();
  }
  const paths = (status: CrawlStatus | undefined) => status?.nextJobs.map((j) => j.path);
  return { clock, statuses, db, engine, runUntil, paths };
}

describe("queuing a job", () => {
  it("publishes the status with the job among the next jobs, while paused too", async () => {
    const h = harness();
    h.engine.pause();
    h.statuses.length = 0;

    h.engine.enqueue({ kind: "poll", path: "/now.html" });
    await turn();

    expect(h.statuses).toHaveLength(1);
    expect(h.statuses[0]).toMatchObject({ state: "paused" });
    expect(h.paths(h.statuses[0])).toEqual(["/now.html"]);
  });

  it("publishes once for every job queued in one go", async () => {
    const h = harness();
    for (let i = 0; i < 25; i++) h.engine.enqueue({ kind: "new-offer", path: `/${i}.html` });
    await turn();

    expect(h.statuses).toHaveLength(1);
    expect(h.statuses[0]?.nextJobs).toHaveLength(10);
  });

  it("publishes a queued job's earlier due time, though no job was added", async () => {
    const h = harness();
    h.engine.enqueue({ kind: "poll", path: "/poll.html", dueAt: MORNING + HOUR });
    await turn();
    h.statuses.length = 0;

    expect(h.engine.enqueue({ kind: "poll", path: "/poll.html" })).toBeNull();
    await turn();

    expect(h.statuses.map((s) => s.nextJobs[0]?.dueAt)).toEqual([new Date(MORNING).toISOString()]);
  });

  it("publishes nothing when the queued job changes nothing the status shows", async () => {
    const h = harness();
    h.engine.pause();
    for (let i = 0; i < 10; i++) h.engine.enqueue({ kind: "poll", path: `/${i}.html` });
    await turn();
    h.statuses.length = 0;

    // One behind the ten jobs the status lists, and one that is queued already.
    h.engine.enqueue({ kind: "recheck", path: "/behind.html" });
    h.engine.enqueue({ kind: "poll", path: "/0.html" });
    await turn();
    expect(h.statuses).toEqual([]);

    h.engine.enqueue({ kind: "poll", path: "/ahead.html", dueAt: MORNING - MINUTE });
    await turn();
    expect(h.statuses.map((s) => s.nextJobs[0]?.path)).toEqual(["/ahead.html"]);
  });

  it("never publishes a job that its caller's transaction took back", async () => {
    const h = harness();
    h.engine.pause();
    h.statuses.length = 0;
    expect(() =>
      h.db.$client.transaction(() => {
        h.engine.enqueue({ kind: "poll", path: "/taken-back.html" });
        throw new Error("the caller changed its mind");
      })(),
    ).toThrow("changed its mind");
    await turn();

    expect(h.statuses).toEqual([]);
  });

  it("leaves the jobs a page's handler queued to the status published after that request", async () => {
    const h = harness();
    const queueCards: JobHandler = () => {
      for (let i = 0; i < 3; i++) h.engine.enqueue({ kind: "new-offer", path: `/${i}.html` });
      return undefined;
    };
    h.engine.on("poll", queueCards);
    h.engine.enqueue({ kind: "poll", path: "/poll.html" });
    await turn();
    h.statuses.length = 0;

    await h.engine.step();
    await turn();

    expect(h.statuses).toHaveLength(1);
    expect(h.paths(h.statuses[0])).toEqual(["/0.html", "/1.html", "/2.html"]);
    expect(h.statuses[0]?.counts.day.used).toBe(1);
  });

  it("neither publishes nor fails once the database is closed", async () => {
    const h = harness();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.engine.enqueue({ kind: "poll", path: "/a.html" });
      await turn();
      expect(h.statuses).toHaveLength(1);

      // A shutdown before the queued job's publish is due.
      h.engine.enqueue({ kind: "poll", path: "/b.html" });
      h.db.$client.close();
      await turn();

      expect(h.statuses).toHaveLength(1);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});

describe("the loop, with no request going out", () => {
  async function twoRequests(h: ReturnType<typeof harness>) {
    h.engine.enqueue({ kind: "poll", path: "/a.html" });
    h.engine.enqueue({ kind: "poll", path: "/b.html" });
    await h.engine.step();
    h.clock.now += 20 * SECOND;
    await h.engine.step();
    expect(h.engine.status().counts).toMatchObject({ hour: { used: 2 }, day: { used: 2 } });
  }

  it("publishes today's count starting again when the Berlin day rolls over", async () => {
    const h = harness();
    await twoRequests(h);
    h.clock.now = LATE;
    h.statuses.length = 0;

    await h.runUntil(MIDNIGHT + MINUTE);

    expect(h.statuses.map((s) => [s.state, s.counts.day.used])).toEqual([
      ["outside-hours", 2],
      ["outside-hours", 0],
    ]);
  });

  it("publishes the hour's count as requests leave the rolling hour", async () => {
    const h = harness();
    await twoRequests(h);
    h.engine.pause();
    h.statuses.length = 0;

    await h.runUntil(MORNING + HOUR + MINUTE);

    expect(h.statuses.map((s) => [s.counts.hour.used, s.counts.day.used])).toEqual([
      [1, 2],
      [0, 2],
    ]);
  });

  it("publishes a job that left the queue without a request", async () => {
    const h = harness();
    h.engine.pause();
    const job = h.engine.enqueue({ kind: "poll", path: "/dropped.html" });
    await turn();
    h.statuses.length = 0;

    if (job !== null) removeJob(h.db, job.id);
    await h.runUntil(MORNING + MINUTE);

    expect(h.statuses.map(h.paths)).toEqual([[]]);
  });

  it("publishes nothing while nothing the status serves changes", async () => {
    const h = harness();
    h.engine.enqueue({ kind: "poll", path: "/later.html", dueAt: MORNING + 2 * HOUR });
    await turn();
    h.statuses.length = 0;

    await h.runUntil(MORNING + HOUR);

    expect(h.statuses).toEqual([]);
  });
});

describe("saving the crawl settings", () => {
  const runtimes: Runtime[] = [];
  afterEach(() => {
    for (const r of runtimes.splice(0)) r.close();
  });

  function boot(start = MORNING) {
    const clock = { now: start };
    const runtime = startRuntime(
      { dataDir: tempDataDir(), port: 0, host: "127.0.0.1" },
      process.cwd(),
      [],
      { fetch: async () => ({ status: 200, body: "" }) },
      () => clock.now,
      undefined,
      fakeProviders(),
    );
    runtimes.push(runtime);
    const statuses: CrawlStatus[] = [];
    runtime.events.subscribe((e) => {
      if (e.type === "crawl-status-changed") statuses.push(e.data);
    });
    const save = (change: (s: CrawlSettings) => CrawlSettings) =>
      runtime.app.request("/api/v1/settings/crawl", {
        method: "PUT",
        headers: { Authorization: `Bearer ${runtime.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(change(defaultCrawlSettings())),
      });
    return { runtime, clock, statuses, save };
  }

  it("publishes the status with the new daily cap", async () => {
    const h = boot();
    const res = await h.save((s) => ({ ...s, pacing: { ...s.pacing, dailyCap: 200 } }));
    expect(res.status).toBe(200);

    expect(h.statuses.map((s) => s.counts.day)).toEqual([{ used: 0, cap: 200 }]);
  });

  it("publishes when the crawl carries on, once the active hours were moved while it rests", async () => {
    const h = boot(LATE);
    h.runtime.crawl.enqueue({ kind: "poll", path: "/wg-zimmer-in-Berlin.8.0.1.0.html" });
    await turn();
    expect(h.statuses.at(-1)).toMatchObject({
      state: "outside-hours",
      nextRequest: { at: "2026-06-11T05:00:00.000Z", waitingFor: "active-hours" },
    });
    h.statuses.length = 0;

    await h.save((s) => ({
      ...s,
      pacing: { ...s.pacing, activeHours: { start: "06:00", end: "23:30" } },
    }));

    expect(h.statuses.map((s) => s.nextRequest.at)).toEqual(["2026-06-11T04:00:00.000Z"]);
  });

  it("publishes nothing when the save is refused", async () => {
    const h = boot();
    const res = await h.save((s) => ({ ...s, pacing: { ...s.pacing, dailyCap: 601 } }));
    expect(res.status).toBe(400);
    await turn();

    expect(h.statuses).toEqual([]);
  });
});
