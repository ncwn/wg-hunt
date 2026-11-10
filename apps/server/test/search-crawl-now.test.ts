import { fakeProviders } from "@wg-hunt/core/analysis/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceFetcher, SourceResponse } from "../src/crawl/fetcher.js";
import { type Runtime, startRuntime } from "../src/runtime.js";
import { cubaPage } from "./fixtures/pages.js";
import { resultsPage } from "./fixtures/search-pages.js";
import { tempDataDir } from "./helpers.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** 10:00 in Berlin (winter time). */
const MORNING = Date.parse("2026-11-04T09:00:00Z");
/** 03:00 in Berlin: before the active hours open at 07:00. */
const NIGHT = Date.parse("2026-11-04T02:00:00Z");

const runtimes: Runtime[] = [];
afterEach(() => {
  for (const r of runtimes.splice(0)) r.close();
});

function boot(start = MORNING, answers: SourceResponse[] = []) {
  const clock = { now: start };
  const sent: string[] = [];
  const fetcher: SourceFetcher = {
    async fetch(path) {
      sent.push(path);
      return answers.shift() ?? { status: 200, body: resultsPage([]) };
    },
  };
  const runtime = startRuntime(
    { dataDir: tempDataDir(), port: 0, host: "127.0.0.1" },
    process.cwd(),
    [],
    fetcher,
    () => clock.now,
    () => 0.5,
    fakeProviders(),
  );
  runtimes.push(runtime);
  const call = (method: string, path: string, body?: unknown) =>
    runtime.app.request(`/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${runtime.token}`,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const createSearch = async (body: object = {}) => {
    const res = await call("POST", "/searches", {
      city: "Berlin",
      categories: ["flatshare-room"],
      ...body,
    });
    expect(res.status).toBe(201);
    return res.json() as Promise<{
      id: number;
      poll: { nextAt: string | null; problem: string | null };
    }>;
  };
  // The polls only: a Sweep queues its own page jobs, tested with the Sweeps.
  const queue = async () =>
    (await (await call("GET", "/crawl")).json()).nextJobs.filter(
      (job: { kind: string }) => job.kind === "poll",
    );
  return { runtime, clock, sent, call, createSearch, queue };
}

describe("Searches and the poll queue", () => {
  it("queues a poll for a new Search, due now, and shows when", async () => {
    const { createSearch, queue, clock } = boot();
    const search = await createSearch();

    expect(search.poll.nextAt).toBe(new Date(clock.now).toISOString());
    expect(await queue()).toEqual([
      expect.objectContaining({ kind: "poll", dueAt: new Date(clock.now).toISOString() }),
    ]);
  });

  it("queues one poll per category", async () => {
    const { createSearch, queue } = boot();
    await createSearch({ categories: ["flatshare-room", "one-room-flat", "house"] });
    expect(await queue()).toHaveLength(3);
  });

  it("queues nothing for a city the adapter doesn't know, and says why", async () => {
    const { createSearch, queue, call } = boot();
    const search = await createSearch({ city: "Potsdam" });

    expect(search.poll).toEqual({ nextAt: null, problem: "unknown-city" });
    expect(await queue()).toEqual([]);
    const crawlNow = await call("POST", `/searches/${search.id}/crawl-now`);
    expect(crawlNow.status).toBe(409);
    expect((await crawlNow.json()).type).toBe("unknown-city");
  });

  it("polls a city the adapter doesn't know once the Search gives its id", async () => {
    const { createSearch, queue, sent, runtime } = boot();
    const search = await createSearch({ city: "Hamburg", cityId: "55" });
    expect(search.poll.problem).toBeNull();

    await runtime.crawl.step();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^\/wg-zimmer-in-Hamburg\.55\.0\.1\.0\.html\?/);
    expect(await queue()).toHaveLength(1);
  });

  it("refuses a city id that is not a number", async () => {
    const { call } = boot();
    const res = await call("POST", "/searches", {
      city: "Hamburg",
      cityId: "55/../x",
      categories: ["flat"],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).errors[0].path).toBe("cityId");
  });

  it("drops the poll when the Search is disabled or deleted, and brings it back when enabled", async () => {
    const { createSearch, queue, call } = boot();
    const search = await createSearch();

    await call("PATCH", `/searches/${search.id}`, { enabled: false });
    expect(await queue()).toEqual([]);
    await call("PATCH", `/searches/${search.id}`, { enabled: true });
    expect(await queue()).toHaveLength(1);

    await call("DELETE", `/searches/${search.id}`);
    expect(await queue()).toEqual([]);
  });

  it("replaces the poll when the Search's URL changes", async () => {
    const { createSearch, queue, call } = boot();
    const search = await createSearch();
    const [before] = await queue();

    await call("PATCH", `/searches/${search.id}`, { recencyDays: 3 });

    const jobs = await queue();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].path).not.toBe(before.path);
  });
});

describe("POST /searches/{id}/crawl-now", () => {
  it("pulls a waiting poll forward to now, and says when it will run", async () => {
    const { createSearch, queue, call, runtime, clock } = boot();
    const search = await createSearch();
    await runtime.crawl.step(); // the first poll runs; the next is 30-60 min away
    const [waiting] = await queue();
    expect(Date.parse(waiting.dueAt)).toBeGreaterThanOrEqual(MORNING + 30 * MINUTE);

    const res = await call("POST", `/searches/${search.id}/crawl-now`);

    expect(res.status).toBe(202);
    const body = await res.json();
    // The gap between requests still applies: 20-60 s after the poll that just ran.
    expect(body).toMatchObject({ queued: 1, waiting: "gap" });
    expect(Date.parse(body.runsAt)).toBeGreaterThanOrEqual(clock.now + 15_000);
    expect(Date.parse(body.runsAt)).toBeLessThanOrEqual(clock.now + 60_000);
    expect(body.message).toMatch(
      /^Queued for \d\d:\d\d \(Europe\/Berlin\): the pause between requests\.$/,
    );
    const [pulled] = await queue();
    expect(pulled.dueAt).toBe(new Date(clock.now).toISOString());
  });

  it("obeys the gap: nothing goes out before runsAt", async () => {
    const { createSearch, call, runtime, clock, sent } = boot();
    const search = await createSearch();
    await runtime.crawl.step();
    const body = await (await call("POST", `/searches/${search.id}/crawl-now`)).json();

    expect((await runtime.crawl.step()).state).toBe("waiting");
    expect(sent).toHaveLength(1);
    clock.now = Date.parse(body.runsAt);
    expect((await runtime.crawl.step()).state).toBe("requested");
    expect(sent).toHaveLength(2);
  });

  it("says 'queued for 07:00' outside the active hours, and sends nothing before", async () => {
    const { createSearch, call, runtime, clock, sent } = boot(NIGHT);
    const search = await createSearch();

    const body = await (await call("POST", `/searches/${search.id}/crawl-now`)).json();

    expect(body).toMatchObject({
      queued: 1,
      waiting: "active-hours",
      runsAt: "2026-11-04T06:00:00.000Z",
      message: "Queued for 07:00 (Europe/Berlin): outside active hours.",
    });
    expect((await runtime.crawl.step()).state).toBe("waiting");
    expect(sent).toEqual([]);
    clock.now = Date.parse(body.runsAt);
    expect((await runtime.crawl.step()).state).toBe("requested");
  });

  it("says 'tomorrow' when the next opening is not today", async () => {
    // 23:45 in Berlin: after the active hours close at 23:30.
    const { createSearch, call } = boot(Date.parse("2026-11-04T22:45:00Z"));
    const search = await createSearch();

    const body = await (await call("POST", `/searches/${search.id}/crawl-now`)).json();

    expect(body.message).toBe("Queued for tomorrow 07:00 (Europe/Berlin): outside active hours.");
  });

  it("waits out a Cooldown without cutting it short", async () => {
    const { createSearch, call, runtime, clock, sent } = boot(MORNING, [
      { status: 200, body: cubaPage() },
    ]);
    const search = await createSearch();
    await runtime.crawl.step(); // the poll meets a Bot check
    const until = Date.parse((await (await call("GET", "/crawl")).json()).cooldown.until);
    clock.now += 5 * MINUTE;

    const body = await (await call("POST", `/searches/${search.id}/crawl-now`)).json();

    expect(body).toMatchObject({ waiting: "cooldown", runsAt: new Date(until).toISOString() });
    expect(body.message).toContain("cooling down after a Bot check");
    expect((await runtime.crawl.step()).state).toBe("waiting");
    expect(sent).toHaveLength(1);
    expect((await call("POST", "/crawl/resume")).status).toBe(409);
    expect(until).toBeGreaterThanOrEqual(MORNING + 2 * HOUR);
  });

  it("has no time to give during a Cooldown that a Resume has to follow", async () => {
    const { createSearch, call, runtime, clock } = boot(MORNING, [
      { status: 200, body: cubaPage() },
      { status: 200, body: cubaPage() },
    ]);
    const search = await createSearch();
    await runtime.crawl.step(); // the poll meets a Bot check; the poll comes back for the probe
    clock.now += 2 * HOUR;
    await runtime.crawl.step(); // the probe meets a second one: a Resume is owed after this one
    clock.now += 5 * MINUTE;
    expect(await (await call("GET", "/crawl")).json()).toMatchObject({
      state: "cooling-down",
      holds: ["needs-resume"],
    });

    const body = await (await call("POST", `/searches/${search.id}/crawl-now`)).json();

    expect(body).toMatchObject({ queued: 1, waiting: "cooldown", runsAt: null });
    expect(body.message).toBe(
      "Queued, but nothing is sent until the break is over and you press Resume: cooling down after a Bot check.",
    );
  });

  it("queues while paused and has no time to give", async () => {
    const { createSearch, call, runtime, sent } = boot();
    const search = await createSearch();
    runtime.crawl.pause();

    const body = await (await call("POST", `/searches/${search.id}/crawl-now`)).json();

    expect(body).toMatchObject({ queued: 1, waiting: "paused", runsAt: null });
    expect(body.message).toMatch(/^Queued, but nothing is sent until you press Resume/);
    expect((await runtime.crawl.step()).state).toBe("waiting");
    expect(sent).toEqual([]);
  });

  it("words the wait by what paused the crawl: a page it could not read, or a failure while handling one", async () => {
    const { createSearch, call, runtime, clock } = boot();
    const search = await createSearch();
    const crawlNow = async () => (await call("POST", `/searches/${search.id}/crawl-now`)).json();

    runtime.crawl.on("poll", () => ({ unexpectedPage: true }));
    await runtime.crawl.step();
    expect(await crawlNow()).toMatchObject({
      waiting: "layout-changed",
      runsAt: null,
      message:
        "Queued, but nothing is sent until you press Resume: a page the crawler didn't understand paused it.",
    });

    await call("POST", "/crawl/resume");
    runtime.crawl.on("poll", () => {
      throw new Error("database is locked");
    });
    clock.now += HOUR;
    await runtime.crawl.step();
    expect(await crawlNow()).toMatchObject({
      waiting: "layout-changed",
      runsAt: null,
      message:
        "Queued, but nothing is sent until you press Resume: wg-hunt failed while handling a page, which paused the crawl.",
    });
  });

  it("makes one poll due per category", async () => {
    const { createSearch, call } = boot();
    const search = await createSearch({ categories: ["flatshare-room", "flat"] });
    const body = await (await call("POST", `/searches/${search.id}/crawl-now`)).json();
    expect(body.queued).toBe(2);
  });

  it("answers 409 for a disabled Search and 404 for one that doesn't exist", async () => {
    const { createSearch, call } = boot();
    const search = await createSearch({ enabled: false });

    const disabled = await call("POST", `/searches/${search.id}/crawl-now`);
    expect(disabled.status).toBe(409);
    expect((await disabled.json()).type).toBe("search-disabled");

    const missing = await call("POST", "/searches/999/crawl-now");
    expect(missing.status).toBe(404);
  });

  it("needs the access token", async () => {
    const { runtime } = boot();
    expect(
      (await runtime.app.request("/api/v1/searches/1/crawl-now", { method: "POST" })).status,
    ).toBe(401);
  });
});
