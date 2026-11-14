import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCrawlEngine, type JobHandler } from "../src/crawl/engine.js";
import type { SourceResponse } from "../src/crawl/fetcher.js";
import type { Job } from "../src/crawl/queue.js";
import { queuedJobs } from "../src/crawl/queue.js";
import { listRequests, REQUEST_OUTCOMES } from "../src/crawl/request-log.js";
import { type Db, openDatabase } from "../src/db/index.js";
import { WIPE_CONFIRMATION } from "../src/retention/constants.js";
import { tempDataDir } from "./helpers.js";
import { oneOffer } from "./retention-harness.js";

const HOUR = 3_600_000;
// Mid-June, so Berlin is on summer time (UTC+2).
const MORNING = Date.parse("2026-06-10T06:00:00Z"); // 08:00 Berlin

function harness(
  options: {
    db?: Db;
    start?: number;
    fetch?: (path: string) => Promise<SourceResponse>;
    rawPageExists?: (savedAs: string) => boolean;
  } = {},
) {
  const clock = { now: options.start ?? MORNING };
  const sent: string[] = [];
  const db = options.db ?? openDatabase(join(tempDataDir(), "outcomes.sqlite"));
  const engine = createCrawlEngine({
    db,
    fetcher: {
      async fetch(path) {
        sent.push(path);
        return (options.fetch ?? (async () => ({ status: 200, body: "<html></html>" })))(path);
      },
    },
    clock: () => clock.now,
    random: () => 0,
    saveRawPage: () => "unexpected-pages/page.html.gz",
    ...(options.rawPageExists && { rawPageExists: options.rawPageExists }),
  });
  async function drive() {
    for (let i = 0; i < 1000; i++) {
      const result = await engine.step();
      if (result.state === "requested" || result.state === "skipped") continue;
      if (result.state === "busy") throw new Error("engine is busy");
      if (result.until === undefined || !Number.isFinite(result.until)) return result;
      clock.now = result.until;
    }
    throw new Error("engine did not settle");
  }
  const outcomes = () =>
    listRequests(db, { limit: 50 })
      .items.map((r) => r.outcome)
      .reverse();
  return { clock, sent, db, engine, drive, outcomes };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the request log's outcomes", () => {
  it("is one closed list, every one a value the log can hold", () => {
    expect([...REQUEST_OUTCOMES].sort()).toEqual(
      [
        "pending",
        "received",
        "ok",
        "redirect",
        "http-error",
        "network-error",
        "bot-check",
        "unexpected-page",
        "handler-error",
        "interrupted",
        "handler-interrupted",
      ].sort(),
    );
  });

  it("shows `received` while the page's handler runs", async () => {
    const h = harness();
    let finish: () => void = () => {};
    h.engine.on("poll", () => new Promise<undefined>((r) => (finish = () => r(undefined))));
    h.engine.enqueue({ kind: "poll", path: "/p.html" });
    const step = h.engine.step();
    await tick();
    await tick();
    expect(h.outcomes()).toEqual(["received"]);
    finish();
    await step;
    expect(h.outcomes()).toEqual(["ok"]);
  });
});

describe("a restart while a request was out", () => {
  it("with no response yet: `interrupted`, and the job, still queued, goes out again", async () => {
    const dir = join(tempDataDir(), "no-response.sqlite");
    const first = harness({ db: openDatabase(dir), fetch: () => new Promise(() => {}) });
    first.engine.enqueue({ kind: "poll", path: "/p.html" });
    void first.engine.step();
    await tick();
    expect(first.outcomes()).toEqual(["pending"]);
    first.db.$client.close();

    const second = harness({ db: openDatabase(dir), start: MORNING + HOUR });
    expect(second.outcomes()).toEqual(["interrupted"]);
    await second.drive();
    expect(second.sent).toEqual(["/p.html"]);
    expect(second.outcomes()).toEqual(["interrupted", "ok"]);
  });

  it("with the response in but its handler unfinished: `handler-interrupted`, the job not resent", async () => {
    const dir = join(tempDataDir(), "mid-handler.sqlite");
    const first = harness({ db: openDatabase(dir) });
    first.engine.on("poll", () => new Promise(() => {})); // the process dies inside the handler
    first.engine.enqueue({ kind: "poll", path: "/p.html" });
    void first.engine.step();
    await tick();
    await tick();
    expect(first.outcomes()).toEqual(["received"]);
    first.db.$client.close();

    const second = harness({ db: openDatabase(dir), start: MORNING + HOUR });
    expect(second.outcomes()).toEqual(["handler-interrupted"]);
    expect(queuedJobs(second.db, "poll")).toEqual([]);
    await second.drive();
    expect(second.sent).toEqual([]);
  });
});

describe("a handler that throws", () => {
  it("settles the job as failed and tells the features, which decide what to queue again", async () => {
    const h = harness();
    const failed: Job[] = [];
    h.engine.onHandlerFailed((job) => failed.push(job));
    const explode: JobHandler = () => {
      throw new Error("parser exploded");
    };
    h.engine.on("poll", explode);
    h.engine.enqueue({ kind: "poll", path: "/p.html", payload: { n: 1 } });
    await h.drive();
    expect(failed).toMatchObject([{ kind: "poll", path: "/p.html", payload: { n: 1 } }]);
    expect(h.outcomes()).toEqual(["handler-error"]);
    expect(queuedJobs(h.db, "poll")).toEqual([]);
    expect(h.engine.status()).toMatchObject({
      state: "layout-changed",
      paused: { reason: "layout-changed", cause: "handler-error" },
    });
  });

  it("is not reported for a handler that returns", async () => {
    const h = harness();
    const failed: Job[] = [];
    h.engine.onHandlerFailed((job) => failed.push(job));
    h.engine.on("poll", () => ({ unexpectedPage: true }));
    h.engine.enqueue({ kind: "poll", path: "/p.html" });
    await h.drive();
    expect(failed).toEqual([]);
    expect(h.outcomes()).toEqual(["unexpected-page"]);
    expect(h.engine.status().paused).toMatchObject({ cause: "unexpected-page" });
  });
});

describe("the raw page of a layout-changed pause", () => {
  it("is named while its file is there and null once the file is gone", async () => {
    const files = new Set(["unexpected-pages/page.html.gz"]);
    const h = harness({ rawPageExists: (savedAs) => files.has(savedAs) });
    h.engine.on("poll", () => ({ unexpectedPage: true }));
    h.engine.enqueue({ kind: "poll", path: "/p.html" });
    await h.drive();
    expect(h.engine.status().paused).toMatchObject({ savedAs: "unexpected-pages/page.html.gz" });

    // A wipe or the 30-day prune deletes it.
    files.clear();
    expect(h.engine.status().paused).toMatchObject({
      reason: "layout-changed",
      cause: "unexpected-page",
      path: "/p.html",
      savedAs: null,
    });
  });
});

describe("a wipe during a layout-changed pause", () => {
  it("deletes the raw page, and the pause stops naming it", async () => {
    const { h } = await oneOffer();
    h.runtime.crawl.on("poll", () => ({ unexpectedPage: true }));
    h.runtime.crawl.enqueue({ kind: "poll", path: "/wg-zimmer-in-Berlin.8.0.1.0.html" });
    await h.crawl(HOUR);
    const before = (await h.json("GET", "/crawl")).body;
    expect(before).toMatchObject({ state: "layout-changed" });
    const savedAs = before.paused.savedAs as string;
    expect(existsSync(join(h.dataDir, savedAs))).toBe(true);

    await h.json("POST", "/storage/wipe", { confirm: WIPE_CONFIRMATION });
    expect(existsSync(join(h.dataDir, savedAs))).toBe(false);
    expect((await h.json("GET", "/crawl")).body.paused).toMatchObject({ savedAs: null });
  });
});
