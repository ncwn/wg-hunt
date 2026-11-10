import { join } from "node:path";
import { fakeProviders } from "@wg-hunt/core/analysis/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createCrawlEngine } from "../src/crawl/engine.js";
import { type Db, openDatabase } from "../src/db/index.js";
import { createEventBus, type ServerEvent } from "../src/events.js";
import { LOW_DISK_BYTES } from "../src/retention/constants.js";
import { type Runtime, startRuntime } from "../src/runtime.js";
import { searchPage } from "./fixtures/pages.js";
import { tempDataDir } from "./helpers.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// 08:00 Berlin in summer, inside the active hours.
const MORNING = Date.parse("2026-06-10T06:00:00Z");

function harness() {
  const clock = { now: MORNING };
  const sent: string[] = [];
  const disk = { free: (50 * LOW_DISK_BYTES) as number | undefined };
  const events: ServerEvent[] = [];
  const db: Db = openDatabase(join(tempDataDir(), "disk.sqlite"));
  const bus = createEventBus();
  bus.subscribe((e) => events.push(e));
  const engine = createCrawlEngine({
    db,
    fetcher: {
      async fetch(path) {
        sent.push(path);
        return { status: 200, body: searchPage() };
      },
    },
    clock: () => clock.now,
    random: () => 0,
    events: bus,
    freeBytes: () => disk.free,
  });
  const queue = (path: string) => engine.enqueue({ kind: "poll", path, dueAt: clock.now });
  return { clock, sent, disk, events, engine, queue };
}

describe("the low-disk guard", () => {
  it("crawls normally while there is a gigabyte or more free", async () => {
    const h = harness();
    h.disk.free = LOW_DISK_BYTES;
    h.queue("/wg-zimmer-in-Berlin.8.0.1.0.html");
    expect((await h.engine.step()).state).toBe("requested");
    expect(h.engine.status().state).toBe("running");
  });

  it("pauses with 'disk nearly full' under a gigabyte, before sending anything", async () => {
    const h = harness();
    h.disk.free = LOW_DISK_BYTES - 1;
    h.queue("/wg-zimmer-in-Berlin.8.0.1.0.html");

    const result = await h.engine.step();
    expect(result).toMatchObject({ state: "waiting", reason: "disk-full" });
    expect(h.sent).toEqual([]);
    const status = h.engine.status();
    expect(status.state).toBe("disk-full");
    expect(status.paused).toMatchObject({ reason: "disk-full", cause: null });
    expect(h.events.some((e) => e.type === "crawl-status-changed")).toBe(true);
  });

  it("stays paused when space comes back, until a manual Resume", async () => {
    const h = harness();
    h.disk.free = 100;
    h.queue("/wg-zimmer-in-Berlin.8.0.1.0.html");
    await h.engine.step();

    h.disk.free = 50 * LOW_DISK_BYTES;
    h.clock.now += 3 * HOUR;
    expect((await h.engine.step()).state).toBe("waiting");
    expect(h.engine.status().state).toBe("disk-full");

    expect(h.engine.resume()).toEqual({ ok: true });
    expect(h.engine.status().state).toBe("running");
    expect((await h.engine.step()).state).toBe("requested");
  });

  it("pauses again after a Resume if the disk is still nearly full", async () => {
    const h = harness();
    h.disk.free = 100;
    h.queue("/wg-zimmer-in-Berlin.8.0.1.0.html");
    await h.engine.step();
    h.engine.resume();
    expect((await h.engine.step()).state).toBe("waiting");
    expect(h.engine.status().state).toBe("disk-full");
    expect(h.sent).toEqual([]);
  });

  it("does not escalate the Cooldown or leave one behind", async () => {
    const h = harness();
    h.disk.free = 100;
    h.queue("/wg-zimmer-in-Berlin.8.0.1.0.html");
    await h.engine.step();
    h.engine.resume();
    await h.engine.step();
    const status = h.engine.status();
    expect(status.cooldown).toBeNull();
    expect(status.lastBotCheck).toBeNull();
    expect(status.halfBudgetUntil).toBeNull();
  });

  it("keeps a Pause the seeker chose, and a disk that can't be read does not pause", async () => {
    const h = harness();
    h.queue("/wg-zimmer-in-Berlin.8.0.1.0.html");
    h.engine.pause();
    h.disk.free = 100;
    await h.engine.step();
    expect(h.engine.status().paused?.reason).toBe("user");

    h.engine.resume();
    h.disk.free = undefined;
    expect((await h.engine.step()).state).toBe("requested");
  });
});

describe("the low-disk guard in the running server", () => {
  const runtimes: Runtime[] = [];
  afterEach(() => {
    for (const r of runtimes.splice(0)) r.close();
  });

  it("shows 'disk-full' on GET /crawl and in the storage readout, and Resume lifts it", async () => {
    const free = { bytes: LOW_DISK_BYTES - 1 };
    const sent: string[] = [];
    const runtime = startRuntime(
      { dataDir: tempDataDir(), port: 0, host: "127.0.0.1" },
      process.cwd(),
      [],
      {
        async fetch(path) {
          sent.push(path);
          return { status: 200, body: searchPage() };
        },
      },
      () => MORNING,
      () => 0.5,
      fakeProviders(),
      () => free.bytes,
    );
    runtimes.push(runtime);
    const call = (method: string, path: string, body?: unknown) =>
      runtime.app.request(`/api/v1${path}`, {
        method,
        headers: { Authorization: `Bearer ${runtime.token}`, "Content-Type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    expect(
      (await call("POST", "/searches", { city: "Berlin", categories: ["flatshare-room"] })).status,
    ).toBe(201);

    await runtime.crawl.step();
    expect(sent).toEqual([]);
    expect(await (await call("GET", "/crawl")).json()).toMatchObject({
      state: "disk-full",
      paused: { reason: "disk-full" },
    });
    expect((await (await call("GET", "/storage")).json()).freeBytes).toBe(LOW_DISK_BYTES - 1);

    free.bytes = 10 * LOW_DISK_BYTES;
    expect((await call("POST", "/crawl/resume")).status).toBe(200);
    expect((await runtime.crawl.step()).state).toBe("requested");
    expect(sent).toHaveLength(1);
  });
});
