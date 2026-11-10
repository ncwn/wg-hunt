import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { fakeProviders } from "@wg-hunt/core/analysis/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_QUEUED_EVENTS, type QueuedEvent, queueEvent } from "../src/api/events.js";
import type { SourceFetcher, SourceResponse } from "../src/crawl/fetcher.js";
import type { ServerEvent } from "../src/events.js";
import { type Runtime, startRuntime } from "../src/runtime.js";
import { cubaPage, searchPage } from "./fixtures/pages.js";
import { tempDataDir } from "./helpers.js";

const HOUR = 3_600_000;
const MORNING = Date.parse("2026-06-10T06:00:00Z"); // 08:00 Berlin

const runtimes: Runtime[] = [];
afterEach(() => {
  for (const r of runtimes.splice(0)) r.close();
});

function boot(answers: SourceResponse[] = [], dataDir = tempDataDir()) {
  const clock = { now: MORNING };
  const sent: string[] = [];
  const fetcher: SourceFetcher = {
    async fetch(path) {
      sent.push(path);
      return answers.shift() ?? { status: 200, body: searchPage() };
    },
  };
  const runtime = startRuntime(
    { dataDir, port: 0, host: "127.0.0.1" },
    process.cwd(),
    [],
    fetcher,
    () => clock.now,
    undefined,
    fakeProviders(),
  );
  runtimes.push(runtime);
  const call = (path: string, init: { method?: string } = {}) =>
    runtime.app.request(`/api/v1${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${runtime.token}` },
    });
  return { runtime, clock, sent, call, dataDir };
}

describe("GET /crawl", () => {
  it("needs the access token", async () => {
    const { runtime } = boot();
    expect((await runtime.app.request("/api/v1/crawl")).status).toBe(401);
  });

  it("returns the state, today's and this hour's counts and the next due jobs", async () => {
    const { runtime, call } = boot();
    runtime.crawl.enqueue({ kind: "poll", path: "/wg-zimmer-in-Berlin.8.0.1.0.html" });
    await runtime.crawl.step();
    runtime.crawl.enqueue({ kind: "recheck", path: "/123.html", dueAt: MORNING + HOUR });
    const res = await call("/crawl");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      state: "running",
      cooldown: null,
      paused: null,
      holds: [],
      // The gap holds the next request back, but the only queued job is due later still.
      nextRequest: { at: new Date(MORNING + HOUR).toISOString(), waitingFor: "gap" },
      actions: { pause: true, resume: false },
      halfBudgetUntil: null,
      counts: { hour: { used: 1, cap: 30 }, day: { used: 1, cap: 300 } },
      nextJobs: [
        { kind: "recheck", path: "/123.html", dueAt: new Date(MORNING + HOUR).toISOString() },
      ],
      lastBotCheck: null,
      settings: { source: "default", unreadable: [] },
    });
  });
});

describe("POST /crawl/pause and /crawl/resume", () => {
  it("pauses and resumes", async () => {
    const { call } = boot();
    const paused = await call("/crawl/pause", { method: "POST" });
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({ state: "paused", paused: { reason: "user" } });
    expect(await (await call("/crawl")).json()).toMatchObject({ state: "paused" });

    const resumed = await call("/crawl/resume", { method: "POST" });
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ state: "running", paused: null });
  });

  it("refuses to Resume during a Cooldown with the bot-check-cooldown problem", async () => {
    const { runtime, call, clock } = boot([{ status: 200, body: cubaPage() }]);
    runtime.crawl.enqueue({ kind: "poll", path: "/wg-zimmer-in-Berlin.8.0.1.0.html" });
    await runtime.crawl.step();
    clock.now += HOUR;

    const res = await call("/crawl/resume", { method: "POST" });
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(await res.json()).toMatchObject({
      type: "bot-check-cooldown",
      status: 409,
      detail: expect.stringContaining(new Date(MORNING + 2 * HOUR).toISOString()),
    });
    expect(await (await call("/crawl")).json()).toMatchObject({
      state: "cooling-down",
      cooldown: { until: new Date(MORNING + 2 * HOUR).toISOString(), level: 1, needsResume: false },
      lastBotCheck: { marker: "checkform", hourCount: 1, dayCount: 1 },
    });
  });

  it("need the access token", async () => {
    const { runtime } = boot();
    for (const path of ["/crawl/pause", "/crawl/resume"]) {
      expect((await runtime.app.request(`/api/v1${path}`, { method: "POST" })).status).toBe(401);
    }
  });
});

function eventReader(res: Response) {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next() {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          // Comment-only blocks (keep-alives) carry no event.
          if (event !== undefined && data !== undefined) return { event, data: JSON.parse(data) };
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("the stream ended");
        buffer += decoder.decode(value, { stream: true });
      }
    },
    close: () => reader.cancel(),
  };
}

describe("GET /events", () => {
  it("is refused without the access token", async () => {
    const { runtime } = boot();
    expect((await runtime.app.request("/api/v1/events")).status).toBe(401);
  });

  it("streams typed crawl events to an authenticated client, starting with the current status", async () => {
    const { runtime, call, clock } = boot([{ status: 200, body: cubaPage() }]);
    const res = await call("/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const stream = eventReader(res);
    const events = [await stream.next()];
    await call("/crawl/pause", { method: "POST" });
    await call("/crawl/resume", { method: "POST" });
    runtime.crawl.enqueue({ kind: "poll", path: "/wg-zimmer-in-Berlin.8.0.1.0.html" });
    await runtime.crawl.step();
    clock.now += 1;
    for (let i = 0; i < 3; i++) events.push(await stream.next());
    await stream.close();

    expect(events.map((e) => e.event)).toEqual([
      "crawl-status-changed",
      "crawl-status-changed",
      "crawl-status-changed",
      "bot-check-cooldown",
    ]);
    expect(events.map((e) => (e.data as { state?: string }).state)).toEqual([
      "running",
      "paused",
      "running",
      undefined,
    ]);
    expect(events[3]?.data).toMatchObject({
      marker: "checkform",
      path: "/wg-zimmer-in-Berlin.8.0.1.0.html",
      level: 1,
      needsResume: false,
      cooldownUntil: new Date(MORNING + 2 * HOUR).toISOString(),
    });
  });

  it("stops listening when the client goes away", async () => {
    const { runtime, call } = boot();
    let listening = 0;
    const subscribe = runtime.events.subscribe;
    runtime.events.subscribe = (listener) => {
      listening++;
      const stop = subscribe(listener);
      return () => {
        listening--;
        stop();
      };
    };
    const stream = eventReader(await call("/events"));
    await stream.next();
    expect(listening).toBe(1);
    await stream.close();
    await vi.waitFor(() => expect(listening).toBe(0));
  });

  it("accepts the dashboard's session cookie", async () => {
    const { runtime } = boot();
    const login = await runtime.app.request("/api/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({ token: runtime.token }),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const res = await runtime.app.request("/api/v1/events", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });

  it("is never compressed, so each event arrives as it happens", async () => {
    const { runtime } = boot();
    const res = await runtime.app.request("/api/v1/events", {
      headers: { Authorization: `Bearer ${runtime.token}`, "Accept-Encoding": "gzip" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    await res.body?.cancel();
  });

  it("tells a client that fell behind what it missed, then sends the newest", async () => {
    const { runtime, call } = boot();
    const stream = eventReader(await call("/events"));
    await stream.next();
    for (let offerId = 1; offerId <= 300; offerId++) {
      runtime.events.publish("analysis-progress", { offerId } as never);
    }
    expect(await stream.next()).toEqual({ event: "events-missed", data: { missed: 201 } });
    expect(await stream.next()).toMatchObject({
      event: "analysis-progress",
      data: { offerId: 202 },
    });
    await stream.close();
  });
});

describe("a slow event client's queue", () => {
  const status = (n: number): ServerEvent => ({
    type: "crawl-status-changed",
    data: { n } as never,
  });
  const botCheck = (n: number): ServerEvent => ({
    type: "bot-check-cooldown",
    data: { n } as never,
  });
  const dataOf = (queue: QueuedEvent[]) => queue.map((e) => (e.data as unknown as { n: number }).n);

  it("keeps only the newest status, since each one replaces the last", () => {
    const queue: QueuedEvent[] = [];
    for (const event of [status(1), botCheck(2), status(3), status(4)]) {
      queueEvent(queue, event);
    }
    expect(dataOf(queue)).toEqual([2, 4]);
  });

  it("keeps only the newest analysis status, and neither status replaces the other", () => {
    const analysisStatus = (n: number): ServerEvent => ({
      type: "analysis-status-changed",
      data: { n } as never,
    });
    const queue: QueuedEvent[] = [];
    for (const event of [analysisStatus(1), status(2), botCheck(3), analysisStatus(4)]) {
      queueEvent(queue, event);
    }
    expect(dataOf(queue)).toEqual([2, 3, 4]);
    queueEvent(queue, status(5));
    expect(dataOf(queue)).toEqual([3, 4, 5]);
  });

  it("never grows past its limit, putting one marker in place of the oldest", () => {
    const queue: QueuedEvent[] = [];
    for (let n = 0; n < MAX_QUEUED_EVENTS + 20; n++) queueEvent(queue, botCheck(n));
    expect(queue).toHaveLength(MAX_QUEUED_EVENTS);
    expect(queue[0]).toEqual({ type: "events-missed", data: { missed: 21 } });
    expect(dataOf(queue.slice(1))[0]).toBe(21);
  });

  const progress = (offerId: number, n = offerId): ServerEvent => ({
    type: "analysis-progress",
    data: { offerId, n } as never,
  });

  it("keeps only the newest analysis progress of each Offer", () => {
    const queue: QueuedEvent[] = [];
    for (let n = 1; n <= 300; n++) queueEvent(queue, progress(7, n));
    expect(dataOf(queue)).toEqual([300]);

    const interleaved: QueuedEvent[] = [];
    for (let n = 1; n <= 6; n++) queueEvent(interleaved, progress(n % 2 === 0 ? 8 : 9, n));
    expect(dataOf(interleaved)).toEqual([5, 6]);
  });

  it("stands one marker for every event it dropped, before the newest", () => {
    const queue: QueuedEvent[] = [];
    for (let id = 1; id <= 300; id++) queueEvent(queue, progress(id));
    expect(queue).toHaveLength(MAX_QUEUED_EVENTS);
    expect(queue[0]).toEqual({ type: "events-missed", data: { missed: 201 } });
    expect(dataOf(queue.slice(1))).toEqual(Array.from({ length: 99 }, (_, i) => 202 + i));

    for (let id = 301; id <= 350; id++) queueEvent(queue, progress(id));
    expect(queue.filter((e) => e.type === "events-missed")).toHaveLength(1);
    expect(queue[0]).toEqual({ type: "events-missed", data: { missed: 251 } });

    queue.shift();
    queueEvent(queue, progress(351));
    expect(queue.filter((e) => e.type === "events-missed")).toHaveLength(0);
    expect(queue).toHaveLength(MAX_QUEUED_EVENTS);
  });

  it("keeps a waiting settled analysis of an Offer when a new reading of it starts", () => {
    const step = (n: number, status: string): ServerEvent => ({
      type: "analysis-progress",
      data: { offerId: 7, n, status: { status } } as never,
    });
    const queue: QueuedEvent[] = [];
    for (const event of [step(1, "reading"), step(2, "analysed"), step(3, "reading")]) {
      queueEvent(queue, event);
    }
    expect(dataOf(queue)).toEqual([2, 3]);

    queueEvent(queue, step(4, "reading"));
    expect(dataOf(queue)).toEqual([2, 4]);
    queueEvent(queue, step(5, "analysed"));
    expect(dataOf(queue)).toEqual([5]);
  });

  it("never drops the waiting status", () => {
    const queue: QueuedEvent[] = [];
    queueEvent(queue, status(0));
    for (let id = 1; id <= 150; id++) queueEvent(queue, progress(id));
    expect(queue).toHaveLength(MAX_QUEUED_EVENTS);
    expect(queue[0]).toEqual({ type: "events-missed", data: { missed: 52 } });
    expect(queue[1]).toEqual(status(0));
    expect(dataOf(queue.slice(2))).toEqual(Array.from({ length: 98 }, (_, i) => 53 + i));
  });
});

describe("an unexpected page", () => {
  it("is kept in the data folder, never in the repository, and pauses the crawl", async () => {
    const { runtime, call, dataDir } = boot([{ status: 200, body: "<html>neues Layout</html>" }]);
    runtime.crawl.on("poll", () => ({ unexpectedPage: true }));
    runtime.crawl.enqueue({ kind: "poll", path: "/wg-zimmer-in-Berlin.8.0.1.0.html" });
    await runtime.crawl.step();

    const status = await (await call("/crawl")).json();
    expect(status).toMatchObject({
      state: "layout-changed",
      cooldown: null,
      paused: { reason: "layout-changed", cause: "unexpected-page" },
    });
    const savedAs = status.paused.savedAs as string;
    expect(savedAs).toMatch(/^unexpected-pages\/.+\.html\.gz$/);
    const file = resolve(dataDir, savedAs);
    expect(relative(dataDir, file).startsWith("..")).toBe(false);
    expect(file.startsWith(resolve(process.cwd()))).toBe(false);
    expect(existsSync(file)).toBe(true);
    expect(gunzipSync(readFileSync(file)).toString()).toBe("<html>neues Layout</html>");
    expect(status.paused.path).toBe("/wg-zimmer-in-Berlin.8.0.1.0.html");
    // The data folder is where wg-hunt keeps everything private; it is ignored by git.
    expect(readFileSync(join(process.cwd(), ".gitignore"), "utf8")).toMatch(/^\.data$/m);
  });
});

describe("restart", () => {
  it("keeps the Cooldown and the pause state in the data folder", async () => {
    const dataDir = tempDataDir();
    const first = boot([{ status: 429, body: "" }], dataDir);
    first.runtime.crawl.enqueue({ kind: "poll", path: "/wg-zimmer-in-Berlin.8.0.1.0.html" });
    await first.runtime.crawl.step();
    await first.call("/crawl/pause", { method: "POST" });
    first.runtime.close();

    const second = boot([], dataDir);
    expect(await (await second.call("/crawl")).json()).toMatchObject({
      state: "cooling-down",
      cooldown: { level: 1 },
      paused: { reason: "user" },
      lastBotCheck: { marker: "http-429" },
    });
  });
});
