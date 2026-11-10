import { describe, expect, it } from "vitest";
import { BOT_CHECK_MARKERS } from "../src/crawl/bot-check.js";
import { JOB_KINDS } from "../src/crawl/constants.js";
import { createCrawlEngine } from "../src/crawl/engine.js";
import { defaultCrawlSettings } from "../src/crawl/settings.js";
import { getSetting } from "../src/db/settings.js";
import { bootTestApp, tempDataDir } from "./helpers.js";
import { bootOffers } from "./offers-harness.js";

type App = ReturnType<typeof bootTestApp>;

function call(app: App, path: string, init: { method?: string; body?: unknown } = {}) {
  return app.app.request(`/api/v1${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${app.token}`,
      ...(init.body !== undefined && { "Content-Type": "application/json" }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
}

const withPacing = (change: Record<string, unknown>) => {
  const s = defaultCrawlSettings();
  return { ...s, pacing: { ...s.pacing, ...change } };
};

describe("GET /settings/crawl", () => {
  it("needs the access token", async () => {
    const { app } = bootTestApp();
    expect((await app.request("/api/v1/settings/crawl")).status).toBe(401);
  });

  it("returns the defaults with the constants beside them", async () => {
    const res = await call(bootTestApp(), "/settings/crawl");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      pacing: {
        gapMinSeconds: 20,
        gapMaxSeconds: 60,
        sessionSize: 15,
        breakMinMinutes: 10,
        breakMaxMinutes: 30,
        hourlyCap: 30,
        dailyCap: 300,
        activeHours: { start: "07:00", end: "23:30" },
      },
      recheck: { enabled: true, maxPageAgeHours: 72 },
      constants: {
        maxInFlight: 1,
        gapFloorSeconds: 15,
        dailyCeiling: 600,
        rotation: "none",
        forbidden: "nothing under /api/ and nothing behind a login",
        cooldownLadderHours: [2, 4, 8, 24],
        halfBudgetHours: 24,
      },
    });
  });
});

describe("PUT /settings/crawl", () => {
  it("stores valid settings and returns them on the next read", async () => {
    const app = bootTestApp();
    const body = withPacing({ gapMinSeconds: 30, gapMaxSeconds: 90, dailyCap: 450 });
    const put = await call(app, "/settings/crawl", { method: "PUT", body });
    expect(put.status).toBe(200);
    const read = await (await call(app, "/settings/crawl")).json();
    expect(read.pacing).toMatchObject({ gapMinSeconds: 30, gapMaxSeconds: 90, dailyCap: 450 });
  });

  it("stamps the save with the server's clock", async () => {
    const h = bootOffers();
    const res = await h.json("PUT", "/settings/crawl", defaultCrawlSettings());
    expect(res.status).toBe(200);
    expect(getSetting(h.runtime.db, "crawl.settings")?.updatedAt.getTime()).toBe(h.clock.now);
  });

  it("keeps the settings across a restart", async () => {
    const dataDir = tempDataDir();
    const first = bootTestApp(dataDir);
    await call(first, "/settings/crawl", {
      method: "PUT",
      body: { ...defaultCrawlSettings(), recheck: { enabled: false, maxPageAgeHours: 48 } },
    });
    first.close();
    const second = bootTestApp(dataDir);
    const read = await (await call(second, "/settings/crawl")).json();
    expect(read.recheck).toEqual({ enabled: false, maxPageAgeHours: 48 });
  });

  it.each([
    ["a gap under 15 s", withPacing({ gapMinSeconds: 14 })],
    ["a longest gap under 15 s", withPacing({ gapMinSeconds: 5, gapMaxSeconds: 10 })],
    ["more than 600 requests a day", withPacing({ dailyCap: 601 })],
    ["more than 600 requests an hour", withPacing({ hourlyCap: 601 })],
    ["a shortest gap above the longest", withPacing({ gapMinSeconds: 70, gapMaxSeconds: 60 })],
    [
      "a shortest break above the longest",
      withPacing({ breakMinMinutes: 40, breakMaxMinutes: 30 }),
    ],
    [
      "active hours that end before they start",
      withPacing({ activeHours: { start: "23:30", end: "07:00" } }),
    ],
    [
      "active hours that are not a time",
      withPacing({ activeHours: { start: "7am", end: "23:30" } }),
    ],
    ["no sessions", withPacing({ sessionSize: 0 })],
  ])("refuses %s with a problem+json error and stores nothing", async (_name, body) => {
    const app = bootTestApp();
    const put = await call(app, "/settings/crawl", { method: "PUT", body });
    expect(put.status).toBe(400);
    expect(put.headers.get("content-type")).toContain("application/problem+json");
    expect(await put.json()).toMatchObject({ type: "validation-error", status: 400 });
    const read = await (await call(app, "/settings/crawl")).json();
    expect(read.pacing).toEqual(defaultCrawlSettings().pacing);
  });

  it("names the constant that was broken", async () => {
    const put = await call(bootTestApp(), "/settings/crawl", {
      method: "PUT",
      body: withPacing({ gapMinSeconds: 10 }),
    });
    expect((await put.json()).detail).toMatch(/15 s/);
  });

  it("does not accept the constants as settings", async () => {
    const app = bootTestApp();
    const body = { ...defaultCrawlSettings(), constants: { gapFloorSeconds: 1 } };
    const put = await call(app, "/settings/crawl", { method: "PUT", body });
    expect(put.status).toBe(200);
    const read = await (await call(app, "/settings/crawl")).json();
    expect(read.constants.gapFloorSeconds).toBe(15);
  });
});

describe("GET /crawl/requests", () => {
  it("starts empty", async () => {
    const res = await call(bootTestApp(), "/crawl/requests");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], nextCursor: null });
  });

  it("pages the request log newest first", async () => {
    const app = bootTestApp();
    let now = Date.parse("2026-06-10T06:00:00Z");
    const engine = createCrawlEngine({
      db: app.db,
      fetcher: { fetch: async () => ({ status: 200, body: "" }) },
      clock: () => now,
      random: () => 0,
    });
    for (const id of [1, 2, 3]) engine.enqueue({ kind: "poll", path: `/p${id}.html` });
    for (let i = 0; i < 3; i++) {
      await engine.step();
      now += 60_000;
    }

    const first = await (await call(app, "/crawl/requests?limit=2")).json();
    expect(first.items.map((r: { path: string }) => r.path)).toEqual(["/p3.html", "/p2.html"]);
    expect(first.items[0]).toEqual({
      id: expect.any(Number),
      at: "2026-06-10T06:02:00.000Z",
      kind: "poll",
      path: "/p3.html",
      status: 200,
      outcome: "ok",
      marker: null,
    });
    const second = await (
      await call(app, `/crawl/requests?limit=2&cursor=${first.nextCursor}`)
    ).json();
    expect(second.items.map((r: { path: string }) => r.path)).toEqual(["/p1.html"]);
    expect(second.nextCursor).toBeNull();
  });

  it("refuses a malformed cursor", async () => {
    const res = await call(bootTestApp(), "/crawl/requests?cursor=%25%25");
    expect(res.status).toBe(400);
    expect((await res.json()).type).toBe("invalid-cursor");
  });

  it("answers rows an earlier version stored byte for byte, for every kind and every marker", async () => {
    const app = bootTestApp();
    // Written as SQL, the way a database from before the enums holds them.
    const store = app.db.$client.prepare(
      "INSERT INTO crawl_requests (at, kind, path, status, outcome, marker) VALUES (?, ?, '/p.html', ?, ?, ?)",
    );
    const at = Date.parse("2026-06-10T06:00:00Z");
    const stored = [
      ...JOB_KINDS.map((kind) => ({ kind, status: 200, outcome: "ok", marker: null })),
      ...BOT_CHECK_MARKERS.map((marker) => ({
        kind: "poll",
        status: 200,
        outcome: "bot-check",
        marker,
      })),
      { kind: "recheck", status: null, outcome: "network-error", marker: null },
    ];
    for (const row of stored) store.run(at, row.kind, row.status, row.outcome, row.marker);

    const text = (value: string | null) => (value === null ? "null" : `"${value}"`);
    const items = stored
      .map(
        (row, i) =>
          `{"id":${i + 1},"at":"2026-06-10T06:00:00.000Z","kind":"${row.kind}","path":"/p.html","status":${row.status},"outcome":"${row.outcome}","marker":${text(row.marker)}}`,
      )
      .reverse();
    const res = await call(app, "/crawl/requests?limit=100");
    expect(await res.text()).toBe(`{"items":[${items.join(",")}],"nextCursor":null}`);
  });
});

describe("the request log in the OpenAPI document", () => {
  const schemas = async () => {
    const doc = await (await bootTestApp().app.request("/api/v1/openapi.json")).json();
    return doc.components.schemas;
  };

  it("gives a request's kind as the job kinds, the same ones the next jobs have", async () => {
    const { CrawlRequest, CrawlStatus } = await schemas();
    expect(CrawlRequest.properties.kind.enum).toEqual([...JOB_KINDS]);
    expect(CrawlRequest.properties.kind.enum).toEqual(
      CrawlStatus.properties.nextJobs.items.properties.kind.enum,
    );
  });

  it("gives a request's marker as the detector's markers or null, like the last Bot check's", async () => {
    const { CrawlRequest, BotCheckRecord } = await schemas();
    expect(CrawlRequest.properties.marker.enum).toEqual([...BOT_CHECK_MARKERS, null]);
    expect(BotCheckRecord.properties.marker.enum).toEqual([...BOT_CHECK_MARKERS]);
  });
});
