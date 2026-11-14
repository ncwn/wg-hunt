import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { jobPriority } from "../src/crawl/constants.js";
import { type CrawlEngine, createCrawlEngine } from "../src/crawl/engine.js";
import type { SourceFetcher } from "../src/crawl/fetcher.js";
import { listRequests } from "../src/crawl/request-log.js";
import {
  type CrawlSettings,
  defaultCrawlSettings,
  saveCrawlSettings,
} from "../src/crawl/settings.js";
import { type Db, openDatabase } from "../src/db/index.js";
import { crawlJobs, crawlRequests, settings as settingsTable } from "../src/db/schema.js";
import { tempDataDir } from "./helpers.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

// Mid-June, so Berlin is on summer time (UTC+2).
const MORNING = Date.parse("2026-06-10T06:00:00Z"); // 08:00 Berlin

function berlin(ms: number) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    hourCycle: "h23",
  }).formatToParts(ms);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { day: get("day"), minuteOfDay: get("hour") * 60 + get("minute") };
}

function seeded(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Sent = { at: number; path: string };

function harness(options: { start?: number; random?: () => number; db?: Db } = {}) {
  const clock = { now: options.start ?? MORNING };
  const sent: Sent[] = [];
  const inFlight = { current: 0, max: 0 };
  const behaviour: { fetch: (path: string) => Promise<{ status: number; body: string }> } = {
    fetch: async () => ({ status: 200, body: "" }),
  };
  const fetcher: SourceFetcher = {
    async fetch(path) {
      inFlight.current++;
      inFlight.max = Math.max(inFlight.max, inFlight.current);
      sent.push({ at: clock.now, path });
      try {
        return await behaviour.fetch(path);
      } finally {
        inFlight.current--;
      }
    },
  };
  const db = options.db ?? openDatabase(join(tempDataDir(), "test.sqlite"));
  const engine: CrawlEngine = createCrawlEngine({
    db,
    fetcher,
    clock: () => clock.now,
    random: options.random ?? seeded(1),
  });

  async function driveUntil(stopAt: number) {
    for (let i = 0; i < 100_000; i++) {
      const result = await engine.step();
      if (result.state === "requested" || result.state === "skipped") continue;
      if (result.state === "busy") throw new Error("engine is busy");
      if (result.until === undefined || !Number.isFinite(result.until) || result.until > stopAt)
        return result;
      clock.now = result.until;
    }
    throw new Error("engine did not settle");
  }
  const drive = () => driveUntil(Number.POSITIVE_INFINITY);

  return { clock, sent, inFlight, behaviour, db, engine, drive, driveUntil };
}

function queue(h: ReturnType<typeof harness>, count: number, kind: "poll" | "recheck" = "poll") {
  for (let i = 0; i < count; i++) h.engine.enqueue({ kind, path: `/${kind}-${i}.html` });
}

function configure(db: Db, change: (s: CrawlSettings) => CrawlSettings, now = MORNING) {
  saveCrawlSettings(db, change(defaultCrawlSettings()), now);
}

const gaps = (sent: Sent[]) => sent.slice(1).map((s, i) => s.at - (sent[i] as Sent).at);

describe("queue order", () => {
  it("serves the highest-priority due job first, in `JOB_KINDS` order", async () => {
    const h = harness();
    for (const kind of [
      "recheck",
      "stale-confirmation",
      "deeper-page",
      "new-offer",
      "poll",
    ] as const) {
      h.engine.enqueue({ kind, path: `/${kind}.html` });
    }
    await h.drive();
    expect(h.sent.map((s) => s.path)).toEqual([
      "/poll.html",
      "/new-offer.html",
      "/deeper-page.html",
      "/stale-confirmation.html",
      "/recheck.html",
    ]);
  });

  it("serves a job queued at another kind's priority in that kind's place, under its own kind", async () => {
    const h = harness();
    h.engine.enqueue({ kind: "recheck", path: "/last.html" });
    h.engine.enqueue({ kind: "deeper-page", path: "/deeper.html" });
    const ahead = h.engine.enqueue({
      kind: "recheck",
      path: "/ahead.html",
      priority: jobPriority("new-offer"),
    });
    expect(ahead).toMatchObject({ kind: "recheck", priority: jobPriority("new-offer") });
    expect(h.engine.status().nextJobs.map((j) => `${j.kind} ${j.path}`)).toEqual([
      "recheck /ahead.html",
      "deeper-page /deeper.html",
      "recheck /last.html",
    ]);
    await h.drive();
    expect(h.sent.map((s) => s.path)).toEqual(["/ahead.html", "/deeper.html", "/last.html"]);
    expect(listRequests(h.db, { limit: 10 }).items.map((r) => r.kind)).toEqual([
      "recheck",
      "deeper-page",
      "recheck",
    ]);
  });

  it("lets a job queued later jump ahead of lower priorities, and keeps first-in order within a kind", async () => {
    const h = harness();
    h.engine.enqueue({ kind: "recheck", path: "/r1.html" });
    h.engine.enqueue({ kind: "recheck", path: "/r2.html" });
    await h.engine.step();
    h.engine.enqueue({ kind: "poll", path: "/p.html" });
    await h.drive();
    expect(h.sent.map((s) => s.path)).toEqual(["/r1.html", "/p.html", "/r2.html"]);
  });

  it("does not let a high-priority job that is not yet due block a due one", async () => {
    const h = harness();
    h.engine.enqueue({ kind: "poll", path: "/later.html", dueAt: MORNING + 2 * HOUR });
    h.engine.enqueue({ kind: "recheck", path: "/now.html" });
    await h.drive();
    expect(h.sent.map((s) => s.path)).toEqual(["/now.html", "/later.html"]);
    expect((h.sent[1] as Sent).at).toBeGreaterThanOrEqual(MORNING + 2 * HOUR);
  });

  it("queues the same kind and path once", () => {
    const h = harness();
    expect(h.engine.enqueue({ kind: "poll", path: "/a.html" })).not.toBeNull();
    expect(h.engine.enqueue({ kind: "poll", path: "/a.html" })).toBeNull();
    expect(h.engine.enqueue({ kind: "recheck", path: "/a.html" })).not.toBeNull();
  });

  it("refuses to queue a path the fetcher would refuse", () => {
    const h = harness();
    expect(() => h.engine.enqueue({ kind: "poll", path: "/api/v1/x" })).toThrow();
  });
});

describe("one request in flight", () => {
  it("answers busy to a second step while a request is out, and never overlaps", async () => {
    const h = harness();
    queue(h, 3);
    let release: () => void = () => {};
    h.behaviour.fetch = () =>
      new Promise((resolve) => {
        release = () => resolve({ status: 200, body: "" });
      });

    const first = h.engine.step();
    const second = await h.engine.step();
    expect(second.state).toBe("busy");
    release();
    expect((await first).state).toBe("requested");

    h.behaviour.fetch = async () => ({ status: 200, body: "" });
    await h.drive();
    expect(h.inFlight.max).toBe(1);
    expect(h.sent).toHaveLength(3);
  });
});

describe("gaps", () => {
  it("waits a uniform 20 to 60 s between requests, drawn from the random source", async () => {
    const draws = [0, 1, 0.5];
    const h = harness({ random: () => draws.shift() ?? 0 });
    configure(h.db, (s) => ({ ...s, pacing: { ...s.pacing, sessionSize: 100 } }));
    queue(h, 4);
    await h.drive();
    expect(gaps(h.sent)).toEqual([20 * SECOND, 60 * SECOND, 40 * SECOND]);
  });

  it("keeps every gap within range over many requests", async () => {
    const h = harness({ random: seeded(7) });
    configure(h.db, (s) => ({
      ...s,
      pacing: { ...s.pacing, sessionSize: 1000, hourlyCap: 600, dailyCap: 600 },
    }));
    queue(h, 120);
    await h.drive();
    expect(h.sent).toHaveLength(120);
    for (const gap of gaps(h.sent)) {
      expect(gap).toBeGreaterThanOrEqual(20 * SECOND);
      expect(gap).toBeLessThanOrEqual(60 * SECOND);
    }
  });

  it("takes the default gaps when the stored ones break a constant", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness({ random: () => 0 });
    h.db
      .insert(settingsTable)
      .values({
        key: "crawl.settings",
        value: JSON.stringify({
          ...defaultCrawlSettings(),
          pacing: { ...defaultCrawlSettings().pacing, gapMinSeconds: 1, gapMaxSeconds: 2 },
        }),
        updatedAt: new Date(MORNING),
      })
      .run();
    queue(h, 3);
    await h.drive();
    expect(gaps(h.sent)).toEqual([20 * SECOND, 20 * SECOND]);
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it("applies settings changed between requests to the next gap", async () => {
    const h = harness({ random: () => 0 });
    queue(h, 3);
    await h.engine.step();
    configure(h.db, (s) => ({
      ...s,
      pacing: { ...s.pacing, gapMinSeconds: 30, gapMaxSeconds: 30 },
    }));
    const wait = await h.engine.step();
    expect(wait).toMatchObject({ state: "waiting", reason: "gap", until: MORNING + 20 * SECOND });
    h.clock.now = MORNING + 20 * SECOND;
    await h.engine.step();
    expect(await h.engine.step()).toMatchObject({ until: MORNING + 50 * SECOND });
  });
});

describe("sessions", () => {
  it("takes a 10 to 30 minute break after 15 requests", async () => {
    const h = harness({ random: seeded(3) });
    queue(h, 32);
    await h.drive();
    const g = gaps(h.sent);
    expect(g).toHaveLength(31);
    g.forEach((gap, i) => {
      if ((i + 1) % 15 === 0) {
        expect(gap).toBeGreaterThanOrEqual(10 * MINUTE);
        expect(gap).toBeLessThanOrEqual(30 * MINUTE);
      } else {
        expect(gap).toBeGreaterThanOrEqual(20 * SECOND);
        expect(gap).toBeLessThanOrEqual(60 * SECOND);
      }
    });
  });

  it("honours a smaller session size from the settings", async () => {
    const h = harness({ random: () => 0 });
    configure(h.db, (s) => ({
      ...s,
      pacing: { ...s.pacing, sessionSize: 2, breakMinMinutes: 10, breakMaxMinutes: 10 },
    }));
    queue(h, 5);
    await h.drive();
    expect(gaps(h.sent)).toEqual([20 * SECOND, 10 * MINUTE, 20 * SECOND, 10 * MINUTE]);
  });
});

describe("active hours", () => {
  it("makes no request outside 07:00 to 23:30 Europe/Berlin, and resumes at 07:00", async () => {
    const h = harness({ start: Date.parse("2026-06-10T21:00:00Z"), random: seeded(5) }); // 23:00
    configure(h.db, (s) => ({ ...s, pacing: { ...s.pacing, sessionSize: 100 } }), h.clock.now);
    queue(h, 40);
    await h.drive();
    expect(h.sent).toHaveLength(40);
    for (const { at } of h.sent) {
      const { minuteOfDay } = berlin(at);
      expect(minuteOfDay).toBeGreaterThanOrEqual(7 * 60);
      expect(minuteOfDay).toBeLessThan(23 * 60 + 30);
    }
    const nextMorning = h.sent.find((s) => berlin(s.at).day === 11);
    expect(nextMorning?.at).toBe(Date.parse("2026-06-11T05:00:00Z")); // 07:00 Berlin
  });

  it("starts at 07:00 sharp when asked in the small hours, and follows winter time", async () => {
    const h = harness({ start: Date.parse("2026-12-10T03:00:00Z") }); // 04:00 Berlin (UTC+1)
    queue(h, 1);
    const wait = await h.engine.step();
    expect(wait).toMatchObject({
      state: "waiting",
      reason: "active-hours",
      until: Date.parse("2026-12-10T06:00:00Z"),
    });
  });

  it("uses the active hours from the settings", async () => {
    const h = harness();
    configure(h.db, (s) => ({
      ...s,
      pacing: { ...s.pacing, activeHours: { start: "10:00", end: "11:00" } },
    }));
    queue(h, 1);
    expect(await h.engine.step()).toMatchObject({ state: "waiting", reason: "active-hours" });
    expect(h.sent).toHaveLength(0);
  });
});

describe("caps", () => {
  const fast = (s: CrawlSettings, pacing: Partial<CrawlSettings["pacing"]>): CrawlSettings => ({
    ...s,
    pacing: {
      ...s.pacing,
      gapMinSeconds: 15,
      gapMaxSeconds: 15,
      sessionSize: 10_000,
      ...pacing,
    },
  });

  it("never sends more than the hourly cap in any rolling hour", async () => {
    const h = harness();
    configure(h.db, (s) => fast(s, { hourlyCap: 30, dailyCap: 600 }));
    queue(h, 100);
    await h.drive();
    expect(h.sent).toHaveLength(100);
    h.sent.forEach((r, i) => {
      const inWindow = h.sent.filter((o) => o.at <= r.at && o.at > r.at - HOUR).length;
      expect(inWindow, `request ${i}`).toBeLessThanOrEqual(30);
    });
    expect((h.sent[30] as Sent).at - (h.sent[0] as Sent).at).toBeGreaterThanOrEqual(HOUR);
  });

  it("reports the hourly cap as the reason for the wait", async () => {
    const h = harness();
    configure(h.db, (s) => fast(s, { hourlyCap: 2, dailyCap: 600 }));
    queue(h, 3);
    await h.engine.step();
    h.clock.now += 15 * SECOND;
    await h.engine.step();
    h.clock.now += 15 * SECOND;
    expect(await h.engine.step()).toMatchObject({
      state: "waiting",
      reason: "hourly-cap",
      until: MORNING + HOUR,
    });
  });

  it("stops for the Berlin day at the daily cap and carries on at 07:00", async () => {
    const h = harness();
    configure(h.db, (s) => fast(s, { hourlyCap: 600, dailyCap: 50 }));
    queue(h, 60);
    await h.drive();
    const day10 = h.sent.filter((s) => berlin(s.at).day === 10);
    expect(day10).toHaveLength(50);
    expect((h.sent[50] as Sent).at).toBe(Date.parse("2026-06-11T05:00:00Z"));
    expect(h.sent).toHaveLength(60);
  });

  it("holds to the 600/day ceiling at the largest allowed settings", async () => {
    // The caps count the request log, so the day's first 590 requests are written straight into
    // it, as sent from 07:00 at the fastest pace. Driving all 600 through the engine proves nothing
    // more and takes seconds on a busy machine.
    const opened = Date.parse("2026-06-10T05:00:00Z"); // 07:00 Berlin
    const earlier = Array.from({ length: 590 }, (_, i) => ({
      at: new Date(opened + i * 15 * SECOND),
      kind: "poll" as const,
      path: `/earlier-${i}.html`,
      status: 200,
      outcome: "ok" as const,
    }));
    const h = harness({ start: Date.parse("2026-06-10T07:30:00Z") }); // after the last of them
    h.db.insert(crawlRequests).values(earlier).run();
    configure(h.db, (s) => fast(s, { hourlyCap: 600, dailyCap: 600 }));
    queue(h, 60);
    await h.driveUntil(Date.parse("2026-06-10T21:30:00Z")); // 23:30 Berlin
    expect(h.sent).toHaveLength(10);
    await h.drive();
    expect(h.sent.filter((s) => berlin(s.at).day === 10)).toHaveLength(10);
    expect((h.sent[10] as Sent).at).toBe(Date.parse("2026-06-11T05:00:00Z"));
    expect(h.sent).toHaveLength(60);
  });
});

describe("restart", () => {
  it("keeps the queue, the counts and the gap across a restart", async () => {
    const dir = join(tempDataDir(), "restart.sqlite");
    const first = harness({ db: openDatabase(dir), random: () => 0 });
    configure(first.db, (s) => ({
      ...s,
      pacing: { ...s.pacing, gapMinSeconds: 15, gapMaxSeconds: 15, sessionSize: 100, dailyCap: 6 },
    }));
    queue(first, 10);
    await first.engine.step();
    first.clock.now += 15 * SECOND;
    await first.engine.step();
    first.db.$client.close();

    const second = harness({ db: openDatabase(dir), start: first.clock.now, random: () => 0 });
    expect(await second.engine.step()).toMatchObject({ state: "waiting", reason: "gap" });
    await second.driveUntil(Date.parse("2026-06-10T21:30:00Z")); // 23:30 Berlin

    expect(first.sent.map((s) => s.path)).toEqual(["/poll-0.html", "/poll-1.html"]);
    expect(second.sent.map((s) => s.path)).toEqual([
      "/poll-2.html",
      "/poll-3.html",
      "/poll-4.html",
      "/poll-5.html",
    ]);
    expect(await second.engine.step()).toMatchObject({ state: "waiting", reason: "daily-cap" });
  });

  it("re-sends the job that was in flight when the server stopped", async () => {
    const dir = join(tempDataDir(), "inflight.sqlite");
    const first = harness({ db: openDatabase(dir) });
    queue(first, 1);
    first.behaviour.fetch = () => new Promise(() => {});
    void first.engine.step();
    await new Promise((r) => setTimeout(r, 0));
    first.db.$client.close();

    const second = harness({ db: openDatabase(dir), start: MORNING + HOUR });
    await second.drive();
    expect(second.sent.map((s) => s.path)).toEqual(["/poll-0.html"]);
    const log = listRequests(second.db, { limit: 10 }).items;
    expect(log.map((r) => r.outcome).sort()).toEqual(["interrupted", "ok"]);
  });
});

describe("a crash after a request starts", () => {
  it("still owes the gap and the session break on restart", async () => {
    const file = join(tempDataDir(), "crash.sqlite");
    const first = harness({ db: openDatabase(file), random: () => 0 });
    configure(first.db, (s) => ({
      ...s,
      pacing: { ...s.pacing, sessionSize: 2, breakMinMinutes: 10, breakMaxMinutes: 10 },
    }));
    queue(first, 4);
    await first.engine.step(); // first of the session
    first.clock.now += 20 * SECOND;
    first.behaviour.fetch = () => new Promise(() => {}); // second request: the process dies mid-flight
    void first.engine.step();
    first.db.$client.close();

    const second = harness({
      db: openDatabase(file),
      start: first.clock.now + 30 * SECOND,
      random: () => 0,
    });
    expect(await second.engine.step()).toMatchObject({
      state: "waiting",
      reason: "gap",
      until: first.clock.now + 10 * MINUTE,
    });
    expect(second.sent).toHaveLength(0);
  });
});

describe("handlers", () => {
  it("can queue its own job again, kind and path included", async () => {
    const h = harness();
    let runs = 0;
    h.engine.on("poll", () => {
      if (++runs < 3) h.engine.enqueue({ kind: "poll", path: "/p.html" });
      return undefined;
    });
    h.engine.enqueue({ kind: "poll", path: "/p.html" });
    await h.drive();
    expect(h.sent.map((s) => s.path)).toEqual(["/p.html", "/p.html", "/p.html"]);
  });

  it("that throws is logged as handler-error and pauses the crawl (it fails closed)", async () => {
    const h = harness();
    h.engine.on("poll", () => {
      throw new Error("parser exploded");
    });
    h.engine.enqueue({ kind: "poll", path: "/bad.html" });
    h.engine.enqueue({ kind: "recheck", path: "/next.html" });
    await h.drive();
    expect(h.sent.map((s) => s.path)).toEqual(["/bad.html"]);
    const log = listRequests(h.db, { limit: 10 }).items;
    expect(log.map((r) => r.outcome)).toEqual(["handler-error"]);
    expect(h.engine.status()).toMatchObject({
      state: "layout-changed",
      paused: { reason: "layout-changed", cause: "handler-error" },
    });
  });
});

describe("queueing a job that is already queued", () => {
  it("moves its due time earlier, never later", async () => {
    const h = harness();
    h.engine.enqueue({ kind: "poll", path: "/p.html", dueAt: MORNING + 2 * HOUR });
    h.engine.enqueue({ kind: "poll", path: "/p.html", dueAt: MORNING + HOUR });
    await h.drive();
    expect(h.sent).toEqual([{ at: MORNING + HOUR, path: "/p.html" }]);

    h.engine.enqueue({ kind: "poll", path: "/q.html", dueAt: MORNING + 2 * HOUR });
    h.engine.enqueue({ kind: "poll", path: "/q.html", dueAt: MORNING + 4 * HOUR });
    await h.drive();
    expect((h.sent[1] as Sent).at).toBe(MORNING + 2 * HOUR);
  });
});

describe("a queued path that is not allowed", () => {
  it("is skipped without a request, a log row or a gap", async () => {
    const h = harness();
    h.db
      .insert(crawlJobs)
      .values({
        kind: "poll",
        priority: 0,
        path: "/api/v1/x",
        dueAt: new Date(MORNING),
      })
      .run();
    h.engine.enqueue({ kind: "recheck", path: "/ok.html" });
    expect(await h.engine.step()).toMatchObject({ state: "skipped" });
    expect(await h.engine.step()).toMatchObject({ state: "requested" });
    expect(h.sent.map((s) => s.path)).toEqual(["/ok.html"]);
    expect(h.sent[0]?.at).toBe(MORNING);
    expect(listRequests(h.db, { limit: 10 }).items).toHaveLength(1);
  });
});

describe("two processes on one database", () => {
  it("never both send within one gap", async () => {
    const file = join(tempDataDir(), "shared.sqlite");
    const a = harness({ db: openDatabase(file) });
    const b = harness({ db: openDatabase(file) });
    queue(a, 2);
    await Promise.all([a.engine.step(), b.engine.step()]);
    expect(a.sent.length + b.sent.length).toBe(1);
  });
});

describe("Berlin changeover days", () => {
  it("opens at 07:00 summer time after the clocks go forward", async () => {
    const h = harness({ start: Date.parse("2026-03-28T22:30:00Z") }); // 23:30 CET, closed
    queue(h, 1);
    expect(await h.engine.step()).toMatchObject({
      reason: "active-hours",
      until: Date.parse("2026-03-29T05:00:00Z"), // 07:00 CEST
    });
  });

  it("opens at 07:00 winter time after the clocks go back", async () => {
    const h = harness({ start: Date.parse("2026-10-24T22:00:00Z") }); // 00:00 CEST on the 25th
    queue(h, 1);
    expect(await h.engine.step()).toMatchObject({
      reason: "active-hours",
      until: Date.parse("2026-10-25T06:00:00Z"), // 07:00 CET
    });
  });

  it("ends the daily count at Berlin midnight on a 23-hour day", async () => {
    const h = harness({ start: Date.parse("2026-03-29T05:00:00Z") });
    configure(
      h.db,
      (s) => ({
        ...s,
        pacing: {
          ...s.pacing,
          gapMinSeconds: 15,
          gapMaxSeconds: 15,
          sessionSize: 100,
          dailyCap: 3,
        },
      }),
      h.clock.now,
    );
    queue(h, 5);
    await h.drive();
    expect(h.sent.map((s) => s.at).slice(3)).toEqual([
      Date.parse("2026-03-30T05:00:00Z"), // 07:00 CEST the next day
      Date.parse("2026-03-30T05:00:15Z"),
    ]);
  });

  it("ends the daily count at Berlin midnight on a 25-hour day", async () => {
    const h = harness({ start: Date.parse("2026-10-25T06:00:00Z") });
    configure(
      h.db,
      (s) => ({
        ...s,
        pacing: {
          ...s.pacing,
          gapMinSeconds: 15,
          gapMaxSeconds: 15,
          sessionSize: 100,
          dailyCap: 3,
        },
      }),
      h.clock.now,
    );
    queue(h, 4);
    await h.drive();
    expect((h.sent[3] as Sent).at).toBe(Date.parse("2026-10-26T06:00:00Z")); // 07:00 CET
  });
});

describe("request log", () => {
  it("records time, kind, path, status and outcome for every request", async () => {
    const h = harness();
    h.behaviour.fetch = async (path) => ({ status: path.includes("gone") ? 404 : 200, body: "" });
    h.engine.enqueue({ kind: "poll", path: "/wg-zimmer-in-Berlin.8.0.1.0.html?sin=2" });
    h.engine.enqueue({ kind: "new-offer", path: "/gone.html" });
    await h.drive();
    const log = listRequests(h.db, { limit: 10 }).items;
    expect(log).toEqual([
      expect.objectContaining({
        at: new Date(h.sent[1]?.at ?? 0).toISOString(),
        kind: "new-offer",
        path: "/gone.html",
        status: 404,
        outcome: "http-error",
        marker: null,
      }),
      expect.objectContaining({
        at: new Date(MORNING).toISOString(),
        kind: "poll",
        path: "/wg-zimmer-in-Berlin.8.0.1.0.html?sin=2",
        status: 200,
        outcome: "ok",
      }),
    ]);
  });

  it("logs a network failure with no status and still spends the gap", async () => {
    const h = harness();
    h.behaviour.fetch = async () => {
      throw new Error("socket hang up");
    };
    queue(h, 2);
    await h.drive();
    const log = listRequests(h.db, { limit: 10 }).items;
    expect(log).toHaveLength(2);
    expect(log.every((r) => r.outcome === "network-error" && r.status === null)).toBe(true);
    expect(gaps(h.sent)[0]).toBeGreaterThanOrEqual(15 * SECOND);
  });

  it("passes the job's handler the response, and logs what the Source answered", async () => {
    const h = harness();
    h.behaviour.fetch = async () => ({ status: 200, body: "<h1>Zimmer</h1>" });
    const seen: string[] = [];
    h.engine.on("poll", (job, response) => {
      seen.push(`${job.path}|${response?.body}`);
      return undefined;
    });
    h.engine.enqueue({ kind: "poll", path: "/p.html" });
    await h.drive();
    expect(seen).toEqual(["/p.html|<h1>Zimmer</h1>"]);
    expect(listRequests(h.db, { limit: 1 }).items[0]).toMatchObject({
      outcome: "ok",
      marker: null,
    });
  });

  it("lets a handler queue follow-up jobs", async () => {
    const h = harness();
    h.engine.on("poll", () => {
      h.engine.enqueue({ kind: "new-offer", path: "/123.html" });
    });
    h.engine.enqueue({ kind: "poll", path: "/p.html" });
    await h.drive();
    expect(h.sent.map((s) => s.path)).toEqual(["/p.html", "/123.html"]);
  });

  it("logs no query parameters that could carry a location, street or person", async () => {
    const h = harness();
    h.engine.enqueue({
      kind: "poll",
      path: "/wg-zimmer-in-Berlin.8.0.1.0.html?sin=2&lat=52.5200&lng=13.4050&street=Musterstr&name=Max#frag",
    });
    await h.drive();
    const [row] = listRequests(h.db, { limit: 1 }).items;
    expect(row?.path).toBe("/wg-zimmer-in-Berlin.8.0.1.0.html?sin=2");
    expect(JSON.stringify(row)).not.toMatch(/lat|lng|street|Max|52\.5/i);
  });

  it("pages the log newest first with an opaque cursor", async () => {
    const h = harness();
    queue(h, 5);
    await h.drive();
    const page1 = listRequests(h.db, { limit: 2 });
    expect(page1.items.map((r) => r.path)).toEqual(["/poll-4.html", "/poll-3.html"]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = listRequests(h.db, { limit: 2, cursor: page1.nextCursor ?? undefined });
    expect(page2.items.map((r) => r.path)).toEqual(["/poll-2.html", "/poll-1.html"]);
    const page3 = listRequests(h.db, { limit: 2, cursor: page2.nextCursor ?? undefined });
    expect(page3.items.map((r) => r.path)).toEqual(["/poll-0.html"]);
    expect(page3.nextCursor).toBeNull();
  });
});

describe("start and stop", () => {
  it("runs the loop on the injected sleep until stopped", async () => {
    const clock = { now: MORNING };
    const sent: string[] = [];
    const db = openDatabase(join(tempDataDir(), "loop.sqlite"));
    const engine = createCrawlEngine({
      db,
      fetcher: {
        async fetch(path) {
          sent.push(path);
          return { status: 200, body: "" };
        },
      },
      clock: () => clock.now,
      random: () => 0,
      sleep: async (ms) => {
        clock.now += ms;
        if (sent.length >= 3) await engine.stop();
      },
    });
    for (let i = 0; i < 5; i++) engine.enqueue({ kind: "poll", path: `/p${i}.html` });
    await engine.start();
    expect(sent).toEqual(["/p0.html", "/p1.html", "/p2.html"]);
    expect(
      db.select().from(settingsTable).where(eq(settingsTable.key, "crawl.engine")).all(),
    ).toHaveLength(1);
  });

  it("keeps one loop when started again while a stopped one still sleeps", async () => {
    const db = openDatabase(join(tempDataDir(), "restart.sqlite"));
    let sleeping = 0;
    let mostAsleep = 0;
    const wake: (() => void)[] = [];
    const engine = createCrawlEngine({
      db,
      fetcher: {
        async fetch() {
          return { status: 200, body: "" };
        },
      },
      clock: () => MORNING,
      random: () => 0,
      sleep: async () => {
        sleeping++;
        mostAsleep = Math.max(mostAsleep, sleeping);
        await new Promise<void>((resolve) => wake.push(resolve));
        sleeping--;
      },
    });
    const ticks = async () => {
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    };

    const first = engine.start();
    await ticks();
    expect(sleeping).toBe(1);
    await engine.stop();
    const second = engine.start();
    await ticks();
    expect(mostAsleep).toBe(1);

    await engine.stop();
    for (const resolve of wake.splice(0)) resolve();
    await Promise.all([first, second]);
  });
});
