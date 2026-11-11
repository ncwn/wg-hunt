import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { JOB_KINDS, type JobKind } from "../src/crawl/constants.js";
import { createCrawlEngine } from "../src/crawl/engine.js";
import type { SourceResponse } from "../src/crawl/fetcher.js";
import { readJson, writeJson } from "../src/crawl/kv.js";
import { listRequests } from "../src/crawl/request-log.js";
import { defaultCrawlSettings, saveCrawlSettings } from "../src/crawl/settings.js";
import { type Db, openDatabase } from "../src/db/index.js";
import { createEventBus, type ServerEvent } from "../src/events.js";
import { cubaPage, offerPage, searchPage } from "./fixtures/pages.js";
import { tempDataDir } from "./helpers.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Mid-June, so Berlin is on summer time (UTC+2).
const MORNING = Date.parse("2026-06-10T06:00:00Z"); // 08:00 Berlin

const NORMAL: SourceResponse = { status: 200, body: searchPage() };
const BOT: SourceResponse = { status: 200, body: cubaPage() };

function harness(options: { start?: number; file?: string } = {}) {
  const clock = { now: options.start ?? MORNING };
  const sent: { at: number; path: string }[] = [];
  const answers: (SourceResponse | "network-error")[] = [];
  const saved: { kind: string; path: string; body: string }[] = [];
  const events: ServerEvent[] = [];
  const behaviour = {
    fetch: async (): Promise<SourceResponse> => {
      const next = answers.shift() ?? NORMAL;
      if (next === "network-error") throw new Error("socket hang up");
      return next;
    },
  };
  const db: Db = openDatabase(options.file ?? join(tempDataDir(), "stops.sqlite"));
  const bus = createEventBus();
  bus.subscribe((e) => events.push(e));
  const engine = createCrawlEngine({
    db,
    fetcher: {
      async fetch(path) {
        sent.push({ at: clock.now, path });
        return behaviour.fetch();
      },
    },
    clock: () => clock.now,
    random: () => 0,
    events: bus,
    saveRawPage: (page) => {
      saved.push({ kind: page.kind, path: page.path, body: page.body });
      return "unexpected-pages/page.html.gz";
    },
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
  const queue = (path: string, dueAt = clock.now) => engine.enqueue({ kind: "poll", path, dueAt });
  return { clock, sent, answers, saved, events, db, engine, drive, driveUntil, queue, behaviour };
}
type Harness = ReturnType<typeof harness>;

const cooldownMs = (h: Harness) => {
  const cooldown = h.engine.status().cooldown;
  if (cooldown === null) throw new Error("no Cooldown");
  return Date.parse(cooldown.until);
};

describe("a Bot check", () => {
  it("stops everything, records the request and keeps the page out of the handler", async () => {
    const h = harness();
    const parsed: string[] = [];
    h.engine.on("poll", (job) => {
      parsed.push(job.path);
    });
    h.answers.push(NORMAL, BOT);
    for (const n of [1, 2, 3, 4]) h.queue(`/p${n}.html`);
    await h.driveUntil(MORNING + HOUR);

    expect(h.sent.map((s) => s.path)).toEqual(["/p1.html", "/p2.html"]);
    expect(parsed).toEqual(["/p1.html"]);
    const [hit] = listRequests(h.db, { limit: 1 }).items;
    expect(hit).toMatchObject({
      path: "/p2.html",
      status: 200,
      outcome: "bot-check",
      marker: "checkform",
    });
    const hitAt = h.sent[1]?.at ?? 0;
    expect(await h.engine.step()).toMatchObject({
      state: "waiting",
      reason: "cooldown",
      until: hitAt + 2 * HOUR,
    });
  });

  it("is recognised for every kind of job, from the central send path", async () => {
    for (const kind of JOB_KINDS) {
      const h = harness();
      h.answers.push(BOT);
      h.engine.enqueue({ kind, path: `/${kind}.html` });
      await h.driveUntil(MORNING + HOUR);
      expect(h.engine.status().state, kind).toBe("cooling-down");
    }
  });

  it.each([403, 429])("is HTTP %i, even with a normal body", async (status) => {
    const h = harness();
    h.answers.push({ status, body: offerPage() });
    h.queue("/p.html");
    await h.drive();
    expect(h.engine.status().lastBotCheck?.marker).toBe(`http-${status}`);
  });

  it("is a redirect to /cuba.html", async () => {
    const h = harness();
    h.answers.push({ status: 302, body: "", location: "/cuba.html?page=/p.html" });
    h.queue("/p.html");
    await h.drive();
    expect(h.engine.status().lastBotCheck?.marker).toBe("redirect-cuba");
  });

  it("records the path, the marker and the hour and day counts", async () => {
    const h = harness();
    for (let i = 0; i < 4; i++) h.queue(`/p${i}.html`);
    h.answers.push(NORMAL, NORMAL, NORMAL, BOT);
    await h.drive();
    expect(h.engine.status().lastBotCheck).toEqual({
      at: new Date(h.sent[3]?.at ?? 0).toISOString(),
      path: "/p3.html",
      marker: "checkform",
      hourCount: 4,
      dayCount: 4,
    });
  });

  it("does not log a query that could carry personal data", async () => {
    const h = harness();
    h.answers.push(BOT);
    h.queue("/wg-zimmer-in-Berlin.8.0.1.0.html?sin=2&street=Musterstr&lat=52.5");
    await h.drive();
    expect(JSON.stringify(h.engine.status().lastBotCheck)).not.toMatch(/street|lat=|52\.5/);
  });

  it("tells the drop listeners about the job it dropped, and only that one", async () => {
    const h = harness();
    const dropped: string[] = [];
    h.engine.onDropped((job) => dropped.push(job.path));
    h.answers.push(NORMAL, BOT);
    h.queue("/a.html");
    h.queue("/b.html");
    await h.driveUntil(MORNING + HOUR);
    expect(h.sent.map((s) => s.path)).toEqual(["/a.html", "/b.html"]);
    expect(dropped).toEqual(["/b.html"]);
  });

  it("is not retried: the job is dropped and nothing else is asked of the Source", async () => {
    const h = harness();
    h.answers.push(BOT);
    h.queue("/p.html");
    await h.drive();
    expect(h.engine.status().nextJobs).toEqual([]);
  });
});

describe("the Cooldown ladder", () => {
  /** Returns the Cooldown it started, in hours. */
  async function hitAt(h: Harness, offset: number) {
    h.answers.push(BOT);
    h.queue(`/hit-${offset}.html`, MORNING + offset);
    await h.drive();
    const hitTime = h.sent.at(-1)?.at ?? 0;
    expect(hitTime, "the hit was sent when due").toBe(MORNING + offset);
    return (cooldownMs(h) - hitTime) / HOUR;
  }

  it("is 2 h, 4 h, 8 h, then 24 h for each further hit within 7 days, capped at 24 h", async () => {
    const h = harness();
    const levels = [];
    // 36 h apart (so never two within 24 h), all inside active hours.
    for (const offset of [0, 36, 72, 108, 144]) levels.push(await hitAt(h, offset * HOUR));
    expect(levels).toEqual([2, 4, 8, 24, 24]);
    expect(h.engine.status().cooldown?.level).toBe(4);
  });

  it("starts again at 2 h after a quiet week", async () => {
    const h = harness();
    expect(await hitAt(h, 0)).toBe(2);
    expect(await hitAt(h, 7 * DAY + HOUR)).toBe(2);
  });

  it("counts a hit exactly 7 days earlier as still within the week", async () => {
    const h = harness();
    expect(await hitAt(h, 0)).toBe(2);
    expect(await hitAt(h, 7 * DAY)).toBe(4);
  });

  it("only counts Bot checks: an unexpected page does not climb the ladder", async () => {
    const h = harness();
    h.engine.on("poll", () => ({ unexpectedPage: true }));
    h.queue("/layout.html");
    await h.drive();
    h.engine.resume();
    h.engine.on("poll", () => undefined);
    expect(await hitAt(h, HOUR)).toBe(2);
  });

  it("honours a longer Retry-After, up to 24 h", async () => {
    const h = harness();
    h.answers.push({ status: 429, body: "", retryAfterSeconds: 5 * 3600 });
    h.queue("/a.html");
    await h.drive();
    expect((cooldownMs(h) - MORNING) / HOUR).toBe(5);

    const long = harness();
    long.answers.push({ status: 429, body: "", retryAfterSeconds: 90 * 3600 });
    long.queue("/a.html");
    await long.drive();
    expect((cooldownMs(long) - MORNING) / HOUR).toBe(24);

    const short = harness();
    short.answers.push({ status: 429, body: "", retryAfterSeconds: 60 });
    short.queue("/a.html");
    await short.drive();
    expect((cooldownMs(short) - MORNING) / HOUR).toBe(2);
  });
});

describe("two Bot checks within 24 h", () => {
  async function twoHits() {
    const h = harness();
    h.answers.push(BOT, BOT);
    h.queue("/a.html");
    h.queue("/b.html");
    await h.drive();
    return h;
  }

  it("need a manual Resume once the 4 h Cooldown is over, however long we wait", async () => {
    const h = await twoHits();
    expect(h.sent.map((s) => s.path)).toEqual(["/a.html", "/b.html"]);
    expect(h.sent[1]?.at).toBe(MORNING + 2 * HOUR); // the probe after the first Cooldown
    expect(h.engine.status().cooldown).toMatchObject({ level: 2, needsResume: true });

    h.queue("/c.html");
    h.clock.now = MORNING + 6 * HOUR;
    expect(await h.engine.step()).toMatchObject({ state: "waiting", reason: "needs-resume" });
    expect(h.engine.status().state).toBe("needs-resume");
    h.clock.now = MORNING + 3 * DAY;
    expect(await h.engine.step()).toMatchObject({ state: "waiting", reason: "needs-resume" });
    expect(h.sent).toHaveLength(2);
  });

  it("go on after Resume, with a probe and then half budget", async () => {
    const h = await twoHits();
    h.queue("/c.html");
    h.clock.now = MORNING + 6 * HOUR;
    expect(h.engine.resume()).toEqual({ ok: true });
    expect(h.engine.status()).toMatchObject({ state: "running" });
    expect(h.engine.probing()).toBe(true);
    await h.drive();
    expect(h.sent.map((s) => s.path)).toEqual(["/a.html", "/b.html", "/c.html"]);
    expect(h.engine.status().halfBudgetUntil).toBe(
      new Date(MORNING + 6 * HOUR + 24 * HOUR).toISOString(),
    );
  });

  it("do not let Resume cut the Cooldown short", async () => {
    const h = await twoHits();
    h.queue("/c.html");
    h.clock.now = MORNING + 3 * HOUR; // second Cooldown runs to +6 h
    expect(h.engine.resume()).toEqual({
      ok: false,
      reason: "bot-check-cooldown",
      until: MORNING + 6 * HOUR,
    });
    expect(await h.engine.step()).toMatchObject({ state: "waiting", reason: "cooldown" });
    expect(h.sent).toHaveLength(2);
  });

  it("a hit 24 h or more after the last one does not need one", async () => {
    const h = harness();
    h.answers.push(BOT, BOT);
    h.queue("/a.html");
    h.queue("/b.html", MORNING + 24 * HOUR + 1);
    await h.drive();
    expect(h.sent).toHaveLength(2);
    expect(h.engine.status().cooldown?.needsResume).toBe(false);
  });
});

describe("after a Cooldown", () => {
  it("carries on by itself with one probe request, then half budget for 24 h", async () => {
    const h = harness();
    saveCrawlSettings(
      h.db,
      {
        ...defaultCrawlSettings(),
        pacing: {
          ...defaultCrawlSettings().pacing,
          gapMinSeconds: 15,
          gapMaxSeconds: 15,
          sessionSize: 10_000,
          // Small, so the simulated 26 hours stay a few dozen requests.
          hourlyCap: 8,
          dailyCap: 600,
        },
      },
      MORNING,
    );
    h.answers.push(BOT);
    for (let i = 0; i < 120; i++) h.queue(`/p${i}.html`);
    await h.driveUntil(MORNING + HOUR);
    expect(h.sent).toHaveLength(1);
    expect(h.engine.status().state).toBe("cooling-down");

    await h.driveUntil(MORNING + 2 * HOUR + MINUTE);
    const probeAt = MORNING + 2 * HOUR;
    expect(h.sent[1]?.at).toBe(probeAt);

    await h.driveUntil(probeAt + 24 * HOUR - 1);
    const during = h.sent.filter((s) => s.at >= probeAt && s.at < probeAt + 24 * HOUR);
    for (const r of during) {
      const inHour = h.sent.filter((o) => o.at <= r.at && o.at > r.at - HOUR).length;
      expect(inHour).toBeLessThanOrEqual(4);
    }
    expect(during.length).toBeGreaterThan(50);

    await h.driveUntil(probeAt + 24 * HOUR + 2 * HOUR);
    const after = h.sent.filter((s) => s.at >= probeAt + 24 * HOUR);
    const busiestHour = Math.max(
      ...after.map((r) => after.filter((o) => o.at >= r.at && o.at < r.at + HOUR).length),
    );
    expect(busiestHour).toBeGreaterThan(4);
    expect(busiestHour).toBeLessThanOrEqual(8);
  });

  it("halves the daily cap too", async () => {
    const h = harness();
    saveCrawlSettings(
      h.db,
      {
        ...defaultCrawlSettings(),
        pacing: {
          ...defaultCrawlSettings().pacing,
          gapMinSeconds: 15,
          gapMaxSeconds: 15,
          sessionSize: 10_000,
          hourlyCap: 600,
          dailyCap: 20,
        },
      },
      MORNING,
    );
    h.answers.push(BOT);
    for (let i = 0; i < 40; i++) h.queue(`/p${i}.html`);
    // Hit at 08:00 of day 10, probe 10:00, half budget (10/day) until 10:00 on day 11.
    await h.driveUntil(MORNING + 12 * HOUR);
    expect(h.sent.filter((s) => s.at >= MORNING + 2 * HOUR)).toHaveLength(9); // 1 hit + 9 = 10 today
    expect(await h.engine.step()).toMatchObject({ state: "waiting", reason: "daily-cap" });
  });

  it("does not count a failed probe: a network error leaves it pending", async () => {
    const h = harness();
    h.answers.push(BOT, "network-error");
    h.queue("/a.html");
    h.queue("/b.html");
    await h.driveUntil(MORNING + 3 * HOUR);
    expect(h.sent.map((s) => s.path)).toEqual(["/a.html", "/b.html"]);
    expect(h.engine.status()).toMatchObject({ halfBudgetUntil: null });
    expect(h.engine.probing()).toBe(true);

    h.queue("/c.html");
    await h.driveUntil(MORNING + 3 * HOUR);
    expect(h.engine.status()).toMatchObject({ cooldown: null });
    expect(h.engine.probing()).toBe(false);
    expect(h.engine.status().halfBudgetUntil).not.toBeNull();
  });

  it("starts a new Cooldown, not half budget, when the probe is itself a Bot check", async () => {
    const h = harness();
    h.answers.push(BOT, BOT);
    h.queue("/a.html");
    h.queue("/b.html");
    await h.drive();
    expect(h.engine.status()).toMatchObject({ halfBudgetUntil: null });
    expect(h.engine.probing()).toBe(false);
  });
});

describe("an unexpected page", () => {
  it("pauses with a reason, keeps the raw page and does not touch the Cooldown ladder", async () => {
    const h = harness();
    h.answers.push({ status: 200, body: "<html>new layout</html>" });
    h.engine.on("poll", () => ({ unexpectedPage: true }));
    h.queue("/p.html");
    h.queue("/q.html");
    await h.drive();

    expect(h.sent).toHaveLength(1);
    expect(h.saved).toEqual([{ kind: "poll", path: "/p.html", body: "<html>new layout</html>" }]);
    expect(h.engine.status()).toMatchObject({
      state: "layout-changed",
      cooldown: null,
      paused: {
        reason: "layout-changed",
        cause: "unexpected-page",
        path: "/p.html",
        savedAs: "unexpected-pages/page.html.gz",
      },
    });
    expect(listRequests(h.db, { limit: 1 }).items[0]).toMatchObject({
      outcome: "unexpected-page",
      marker: null,
    });
    expect(await h.engine.step()).toMatchObject({ state: "waiting", reason: "layout-changed" });
  });

  it("needs a manual Resume, which works at once and starts neither a probe nor half budget", async () => {
    const h = harness();
    h.engine.on("poll", () => ({ unexpectedPage: true }));
    h.queue("/p.html");
    h.queue("/q.html");
    await h.drive();
    h.clock.now += 2 * DAY;
    expect(await h.engine.step()).toMatchObject({ reason: "layout-changed" });
    expect(h.engine.resume()).toEqual({ ok: true });
    expect(h.engine.status()).toMatchObject({ state: "running", halfBudgetUntil: null });
    expect(h.engine.probing()).toBe(false);
    h.engine.on("poll", () => undefined);
    await h.drive();
    expect(h.sent.map((s) => s.path)).toEqual(["/p.html", "/q.html"]);
  });

  it("still pauses when the raw page cannot be saved", async () => {
    const h = harness();
    const engine = createCrawlEngine({
      db: h.db,
      fetcher: { fetch: async () => NORMAL },
      clock: () => h.clock.now,
      random: () => 0,
      saveRawPage: () => {
        throw new Error("disk full");
      },
    });
    engine.on("poll", () => ({ unexpectedPage: true }));
    engine.enqueue({ kind: "poll", path: "/p.html" });
    await engine.step();
    expect(engine.status()).toMatchObject({
      state: "layout-changed",
      paused: { cause: "unexpected-page", savedAs: null },
    });
  });
});

describe("Pause and Resume", () => {
  it("Pause stops after the request in flight and persists until Resume", async () => {
    const h = harness();
    for (const n of [1, 2, 3]) h.queue(`/p${n}.html`);
    let release: () => void = () => {};
    h.behaviour.fetch = () =>
      new Promise((resolve) => {
        release = () => resolve(NORMAL);
      });
    const first = h.engine.step();
    h.engine.pause();
    release();
    expect(await first).toMatchObject({ state: "requested" });

    h.clock.now += HOUR;
    expect(await h.engine.step()).toMatchObject({ state: "waiting", reason: "paused" });
    expect(h.engine.status()).toMatchObject({
      state: "paused",
      paused: { reason: "user", cause: null },
    });
    h.clock.now += 2 * DAY;
    expect(await h.engine.step()).toMatchObject({ state: "waiting", reason: "paused" });

    h.behaviour.fetch = async () => NORMAL;
    expect(h.engine.resume()).toEqual({ ok: true });
    await h.drive();
    expect(h.sent.map((s) => s.path)).toEqual(["/p1.html", "/p2.html", "/p3.html"]);
  });

  it("neither cuts a Cooldown short: Resume is refused during it, and Pause outlasts it", async () => {
    const h = harness();
    h.answers.push(BOT);
    h.queue("/a.html");
    h.queue("/b.html");
    await h.driveUntil(MORNING + HOUR);
    h.engine.pause();
    h.clock.now = MORNING + HOUR;
    expect(h.engine.resume()).toMatchObject({ ok: false, reason: "bot-check-cooldown" });
    expect(h.engine.status().state).toBe("cooling-down");

    h.clock.now = MORNING + 3 * HOUR; // the Cooldown is over, the Pause is not
    expect(await h.engine.step()).toMatchObject({ reason: "paused" });
    expect(h.engine.resume()).toEqual({ ok: true });
    expect(h.engine.probing()).toBe(true);
    await h.drive();
    expect(h.sent.map((s) => s.path)).toEqual(["/a.html", "/b.html"]);
  });

  it("Pause during a Cooldown does not stop the Cooldown from counting", async () => {
    const h = harness();
    h.answers.push(BOT);
    h.queue("/a.html");
    await h.drive();
    h.engine.pause();
    expect(h.engine.status().cooldown?.until).toBe(new Date(MORNING + 2 * HOUR).toISOString());
  });

  it("Pause and Resume are harmless when repeated or when there is nothing to resume", () => {
    const h = harness();
    expect(h.engine.resume()).toEqual({ ok: true });
    h.engine.pause();
    h.engine.pause();
    expect(h.engine.resume()).toEqual({ ok: true });
    expect(h.engine.resume()).toEqual({ ok: true });
    expect(h.engine.status().state).toBe("running");
  });

  it("Pause does not hide a layout change", async () => {
    const h = harness();
    h.engine.on("poll", () => ({ unexpectedPage: true }));
    h.queue("/p.html");
    await h.drive();
    h.engine.pause();
    expect(h.engine.status().state).toBe("layout-changed");
  });
});

describe("what the status says about who acts next", () => {
  async function twoHits() {
    const h = harness();
    h.answers.push(BOT, BOT);
    h.queue("/a.html");
    h.queue("/b.html");
    await h.drive();
    h.queue("/c.html");
    return h;
  }

  it("gives a Cooldown's end as the next request when the crawl carries on by itself", async () => {
    const h = harness();
    h.answers.push(BOT);
    h.queue("/a.html");
    h.queue("/b.html");
    await h.driveUntil(MORNING + HOUR);
    expect(h.engine.status()).toMatchObject({
      state: "cooling-down",
      holds: [],
      nextRequest: { at: new Date(MORNING + 2 * HOUR).toISOString(), waitingFor: "cooldown" },
      actions: { pause: true, resume: false },
    });
  });

  it("promises no time during a Cooldown that a Resume has to follow, and names the stop", async () => {
    const h = await twoHits();
    h.clock.now = MORNING + 3 * HOUR; // the second Cooldown runs to +6 h
    expect(h.engine.status()).toMatchObject({
      state: "cooling-down",
      holds: ["needs-resume"],
      nextRequest: { at: null, waitingFor: "cooldown" },
      actions: { pause: true, resume: false },
    });
    expect(h.engine.nextRequest()).toEqual({ at: null, waitingFor: "cooldown" });

    h.clock.now = MORNING + 6 * HOUR;
    expect(h.engine.status()).toMatchObject({
      state: "needs-resume",
      holds: ["needs-resume"],
      nextRequest: { at: null, waitingFor: "needs-resume" },
      actions: { pause: false, resume: true },
    });

    h.engine.resume();
    expect(h.engine.status()).toMatchObject({
      state: "running",
      holds: [],
      nextRequest: { waitingFor: null },
      actions: { pause: true, resume: false },
    });
    expect(h.engine.status().nextRequest.at).not.toBeNull();
  });

  it("lists a Pause made during that Cooldown next to the stop it would also lift", async () => {
    const h = await twoHits();
    h.clock.now = MORNING + 3 * HOUR;
    h.engine.pause();
    expect(h.engine.status()).toMatchObject({
      state: "cooling-down",
      holds: ["paused", "needs-resume"],
      actions: { pause: false, resume: false },
    });

    h.clock.now = MORNING + 6 * HOUR;
    // `state` can only name one stop; `holds` says a Resume lifts both.
    expect(h.engine.status()).toMatchObject({
      state: "paused",
      holds: ["paused", "needs-resume"],
      actions: { pause: false, resume: true },
    });
    expect(h.engine.resume()).toEqual({ ok: true });
    expect(h.engine.status()).toMatchObject({ holds: [] });
    expect(h.engine.probing()).toBe(true);
  });

  it("promises no request while nothing is queued", () => {
    const h = harness();
    expect(h.engine.status()).toMatchObject({
      holds: [],
      nextRequest: { at: null, waitingFor: null },
    });
  });

  it("waits for the first queued job when the limits would let a request go sooner", () => {
    const h = harness();
    h.queue("/later.html", MORNING + HOUR);
    expect(h.engine.status().nextRequest).toEqual({
      at: new Date(MORNING + HOUR).toISOString(),
      waitingFor: null,
    });
  });

  it("names every stop that needs a Resume, with nothing to Pause", async () => {
    const h = harness();
    h.engine.on("poll", () => ({ unexpectedPage: true }));
    h.queue("/p.html");
    await h.drive();
    expect(h.engine.status()).toMatchObject({
      state: "layout-changed",
      holds: ["layout-changed"],
      nextRequest: { at: null, waitingFor: "layout-changed" },
      actions: { pause: false, resume: true },
    });
  });
});

describe("restart", () => {
  it("keeps the Cooldown level, the hit history and a Pause", async () => {
    const file = join(tempDataDir(), "restart.sqlite");
    const first = harness({ file });
    first.answers.push(BOT);
    first.queue("/a.html");
    await first.driveUntil(MORNING + HOUR);
    first.engine.pause();
    first.db.$client.close();

    const second = harness({ file, start: first.clock.now + 30 * MINUTE });
    expect(second.engine.status()).toMatchObject({
      state: "cooling-down",
      cooldown: { level: 1, needsResume: false },
      paused: { reason: "user" },
      lastBotCheck: { path: "/a.html", marker: "checkform" },
    });
    second.queue("/b.html");
    expect(await second.engine.step()).toMatchObject({ reason: "cooldown" });

    second.clock.now = MORNING + 3 * HOUR;
    expect(await second.engine.step()).toMatchObject({ reason: "paused" });
    second.engine.resume();
    second.answers.push(BOT);
    await second.drive();
    expect(second.engine.status().cooldown).toMatchObject({ level: 2, needsResume: true });
    second.db.$client.close();

    const third = harness({ file, start: MORNING + 4 * HOUR });
    expect(third.engine.status().cooldown).toMatchObject({ level: 2, needsResume: true });
  });

  it("keeps the cause of a layout-change pause", async () => {
    const file = join(tempDataDir(), "cause.sqlite");
    const first = harness({ file });
    first.engine.on("poll", () => {
      throw new Error("disk full");
    });
    first.queue("/p.html");
    await first.drive();
    first.db.$client.close();

    const second = harness({ file, start: first.clock.now + DAY });
    expect(second.engine.status()).toMatchObject({
      state: "layout-changed",
      paused: { reason: "layout-changed", cause: "handler-error", path: "/p.html" },
    });
  });

  it("has no cause for a layout-change pause stored before the cause was recorded", () => {
    const file = join(tempDataDir(), "before-cause.sqlite");
    const db = openDatabase(file);
    const paused = { reason: "layout-changed", at: MORNING, path: "/p.html" };
    writeJson(db, "crawl.engine", { paused }, MORNING);
    db.$client.close();

    const h = harness({ file, start: MORNING + HOUR });
    expect(h.engine.status()).toMatchObject({
      state: "layout-changed",
      paused: { reason: "layout-changed", cause: null, path: "/p.html" },
    });
  });

  it("reads a Cooldown it cannot read as one that needs a Resume, which then leads to the probe", async () => {
    const h = harness();
    writeJson(h.db, "crawl.engine", { cooldown: {} }, MORNING);
    expect(h.engine.status()).toMatchObject({ state: "needs-resume", holds: ["needs-resume"] });
    h.queue("/a.html");
    expect(await h.engine.step()).toMatchObject({ state: "waiting", reason: "needs-resume" });
    expect(h.engine.resume()).toEqual({ ok: true });
    expect(h.engine.probing()).toBe(true);
  });

  it.each([
    ["a reason from a newer version", { reason: "from-a-newer-version", at: MORNING - HOUR }],
    ["no object", "x"],
  ])("reads a Pause it cannot read (%s) as a Pause", async (_, paused) => {
    const h = harness();
    writeJson(h.db, "crawl.engine", { paused }, MORNING);
    expect(h.engine.status()).toMatchObject({
      state: "paused",
      paused: { reason: "user", cause: null, path: null, savedAs: null },
      holds: ["paused"],
    });
    h.queue("/a.html");
    expect(await h.engine.step()).toMatchObject({ state: "waiting", reason: "paused" });
    expect(h.sent).toEqual([]);
  });

  it.each([
    ["no object", ["x"]],
    ["unreadable Bot checks", { hits: [{ at: "yesterday" }], lastBotCheck: 3 }],
    ["hits that are no list", { hits: "x" }],
  ])("reads stored state it cannot read (%s) as running", async (_, stored) => {
    const h = harness();
    writeJson(h.db, "crawl.engine", stored, MORNING);
    expect(h.engine.status()).toMatchObject({ state: "running", holds: [], lastBotCheck: null });
    h.queue("/a.html");
    expect(await h.engine.step()).toMatchObject({ state: "requested" });
  });

  it("stores the stops under the flat keys an older version reads", async () => {
    const h = harness();
    h.answers.push(BOT);
    h.queue("/a.html");
    h.queue("/b.html");
    await h.driveUntil(MORNING + HOUR);
    const cooling = readJson(h.db, "crawl.engine") as Record<string, unknown>;
    expect(Object.keys(cooling).sort()).toEqual([
      "cooldown",
      "hits",
      "lastBotCheck",
      "nextRequestAt",
      "probe",
      "sessionCount",
    ]);
    expect(cooling).toMatchObject({
      cooldown: { until: MORNING + 2 * HOUR, level: 1, needsResume: false },
      probe: false,
    });

    await h.driveUntil(MORNING + 3 * HOUR);
    const probed = readJson(h.db, "crawl.engine") as Record<string, unknown>;
    expect(Object.keys(probed).sort()).toEqual([
      "halfBudgetUntil",
      "hits",
      "lastBotCheck",
      "nextRequestAt",
      "probe",
      "sessionCount",
    ]);
    expect(probed).toMatchObject({ probe: false, halfBudgetUntil: MORNING + 2 * HOUR + DAY });
  });

  it("remembers a pending probe and the half-budget period", async () => {
    const file = join(tempDataDir(), "probe.sqlite");
    const first = harness({ file });
    first.answers.push(BOT);
    first.queue("/a.html");
    first.queue("/b.html");
    await first.driveUntil(MORNING + 3 * HOUR);
    first.db.$client.close();

    const second = harness({ file, start: first.clock.now });
    expect(second.engine.status().halfBudgetUntil).toBe(
      new Date(MORNING + 2 * HOUR + 24 * HOUR).toISOString(),
    );
  });
});

describe("live events", () => {
  it("publishes the status after each request and a Bot check / Cooldown event on a hit", async () => {
    const h = harness();
    h.answers.push(NORMAL, BOT);
    h.queue("/a.html");
    h.queue("/b.html");
    await h.drive();
    const types = h.events.map((e) => e.type);
    expect(types).toContain("crawl-status-changed");
    const botCheck = h.events.find((e) => e.type === "bot-check-cooldown");
    expect(botCheck?.data).toMatchObject({
      path: "/b.html",
      marker: "checkform",
      hourCount: 2,
      dayCount: 2,
      level: 1,
      needsResume: false,
      cooldownUntil: new Date(MORNING + 20 * SECOND + 2 * HOUR).toISOString(),
    });
    const last = [...h.events].reverse().find((e) => e.type === "crawl-status-changed");
    expect(last?.data).toMatchObject({ state: "cooling-down" });
  });

  it("publishes the end of the half-budget period from the loop, though the state stays running", async () => {
    const clock = { now: MORNING };
    const db = openDatabase(join(tempDataDir(), "half-budget-loop.sqlite"));
    writeJson(db, "crawl.engine", { halfBudgetUntil: MORNING + MINUTE }, MORNING);
    const bus = createEventBus();
    const statuses: { state: string; halfBudgetUntil: string | null }[] = [];
    bus.subscribe((e) => {
      if (e.type === "crawl-status-changed") statuses.push(e.data);
    });
    const engine = createCrawlEngine({
      db,
      fetcher: { fetch: async () => NORMAL },
      clock: () => clock.now,
      random: () => 0,
      events: bus,
      sleep: async (ms) => {
        clock.now += ms;
        if (clock.now > MORNING + 3 * MINUTE) await engine.stop();
      },
    });
    await engine.start();
    expect(statuses.map((s) => [s.state, s.halfBudgetUntil])).toEqual([
      ["running", new Date(MORNING + MINUTE).toISOString()],
      ["running", null],
    ]);
  });

  it("publishes Pause and Resume", () => {
    const h = harness();
    h.engine.pause();
    h.engine.resume();
    expect(h.events.map((e) => (e.data as { state: string }).state)).toEqual(["paused", "running"]);
  });
});

describe("status", () => {
  it("counts the hour and the day against the caps, and lists the next jobs", () => {
    const h = harness();
    h.queue("/later.html", MORNING + HOUR);
    h.queue("/now.html");
    const status = h.engine.status();
    expect(status.counts).toEqual({
      hour: { used: 0, cap: 30 },
      day: { used: 0, cap: 300 },
    });
    expect(status.nextJobs.map((j) => j.path)).toEqual(["/now.html", "/later.html"]);
    expect(status.state).toBe("running");
  });

  it("says outside hours at night", () => {
    const h = harness({ start: Date.parse("2026-06-10T01:00:00Z") });
    expect(h.engine.status().state).toBe("outside-hours");
  });

  it("shows the halved caps during the half-budget period", async () => {
    const h = harness();
    h.answers.push(BOT);
    h.queue("/a.html");
    h.queue("/b.html");
    await h.driveUntil(MORNING + 3 * HOUR);
    expect(h.engine.status().counts).toMatchObject({ hour: { cap: 15 }, day: { cap: 150 } });
  });
});

describe("a handler that throws", () => {
  it("fails closed: the crawl pauses as a layout change whose cause is the handler, and the raw page is kept", async () => {
    const h = harness();
    h.answers.push({ status: 200, body: "<html>odd</html>" });
    h.engine.on("poll", () => {
      throw new Error("parser exploded");
    });
    h.queue("/p.html");
    h.queue("/q.html");
    await h.drive();

    expect(h.sent.map((s) => s.path)).toEqual(["/p.html"]);
    expect(h.saved).toEqual([{ kind: "poll", path: "/p.html", body: "<html>odd</html>" }]);
    expect(h.engine.status()).toMatchObject({
      state: "layout-changed",
      cooldown: null,
      paused: { reason: "layout-changed", cause: "handler-error", path: "/p.html" },
    });
    expect(listRequests(h.db, { limit: 1 }).items[0]).toMatchObject({ outcome: "handler-error" });
    expect(await h.engine.step()).toMatchObject({ state: "waiting", reason: "layout-changed" });
    expect(h.engine.resume()).toEqual({ ok: true });
  });

  it("logs the error's class and code with the job, never its message", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const h = harness();
      h.engine.on("poll", () => {
        const full = new Error("no space left on device, write 'Zimmer in der Musterstraße'");
        throw Object.assign(full, { code: "ENOSPC" });
      });
      h.queue("/p.html");
      await h.drive();
      expect(logged.mock.calls).toEqual([["Handling poll /p.html failed: Error (ENOSPC)"]]);
    } finally {
      logged.mockRestore();
    }
  });

  it("logs nothing for a page the handler could not read", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const h = harness();
      h.engine.on("poll", () => ({ unexpectedPage: true }));
      h.queue("/p.html");
      await h.drive();
      expect(logged.mock.calls).toEqual([]);
    } finally {
      logged.mockRestore();
    }
  });

  it("names the cause of the pause in force: after a Resume, the next pause has its own", async () => {
    const h = harness();
    h.engine.on("poll", () => {
      throw new Error("database is locked");
    });
    h.queue("/p.html");
    h.queue("/q.html");
    await h.drive();
    expect(h.engine.status().paused).toMatchObject({ cause: "handler-error", path: "/p.html" });

    h.engine.resume();
    h.engine.on("poll", () => ({ unexpectedPage: true }));
    await h.drive();
    expect(h.engine.status().paused).toMatchObject({ cause: "unexpected-page", path: "/q.html" });
  });

  it("pauses even when there was no page to keep", async () => {
    const h = harness();
    h.answers.push("network-error");
    h.engine.on("poll", () => {
      throw new Error("cannot cope with nothing");
    });
    h.queue("/p.html");
    await h.drive();
    expect(h.saved).toEqual([]);
    expect(h.engine.status()).toMatchObject({
      state: "layout-changed",
      paused: { reason: "layout-changed", cause: "handler-error", savedAs: null },
    });
  });
});

describe("the probe", () => {
  async function afterCooldown(h: Harness, ...probeAnswers: (SourceResponse | "network-error")[]) {
    h.answers.push(BOT, ...probeAnswers);
    h.queue("/a.html");
    await h.driveUntil(MORNING + HOUR);
    h.queue("/probe.html");
    await h.driveUntil(MORNING + 2 * HOUR + MINUTE);
    expect(h.sent.at(-1)?.path).toBe("/probe.html");
  }

  it.each([
    ["a 500", { status: 500, body: "" }],
    ["a 404", { status: 404, body: "" }],
    ["a redirect off the Source", { status: 302, body: "", location: "https://example.org/" }],
    ["a network error", "network-error" as const],
  ])("is not passed by %s", async (_name, answer) => {
    const h = harness();
    await afterCooldown(h, answer);
    expect(h.engine.status()).toMatchObject({ halfBudgetUntil: null });
    expect(h.engine.probing()).toBe(true);
    expect(h.engine.status().cooldown).not.toBeNull();
  });

  it("is passed by a 2xx page without a marker", async () => {
    const h = harness();
    await afterCooldown(h, NORMAL);
    expect(h.engine.status()).toMatchObject({ cooldown: null });
    expect(h.engine.probing()).toBe(false);
    expect(h.engine.status().halfBudgetUntil).not.toBeNull();
  });

  it("waits a session-break-length delay after a failed probe, not the normal gap", async () => {
    const h = harness();
    await afterCooldown(h, { status: 503, body: "" });
    h.queue("/again.html");
    const probeAt = h.sent.at(-1)?.at ?? 0;
    h.clock.now = probeAt + 5 * MINUTE;
    expect(await h.engine.step()).toMatchObject({
      state: "waiting",
      reason: "gap",
      until: probeAt + 10 * MINUTE, // the default break is 10 to 30 min; the fake random draws 10
    });
    h.clock.now = probeAt + 10 * MINUTE;
    expect(await h.engine.step()).toMatchObject({ state: "requested" });
  });

  it("goes to a search page when one is queued, whatever else is due", async () => {
    async function probeFor(...jobs: { kind: JobKind; path: string }[]) {
      const h = harness();
      h.answers.push(BOT);
      h.queue("/a.html");
      await h.driveUntil(MORNING + HOUR);
      for (const job of jobs) h.engine.enqueue(job);
      await h.driveUntil(MORNING + 2 * HOUR + 1);
      return h.sent[1]?.path;
    }
    const recheck = { kind: "recheck", path: "/recheck.html" } as const;
    const offer = { kind: "new-offer", path: "/offer.html" } as const;
    const deeper = { kind: "deeper-page", path: "/deeper.html" } as const;
    const poll = { kind: "poll", path: "/search.html" } as const;

    expect(await probeFor(offer, recheck, deeper, poll)).toBe("/search.html");
    expect(await probeFor(recheck, offer, deeper)).toBe("/deeper.html");
    expect(await probeFor(recheck, offer)).toBe("/offer.html");
  });
});
