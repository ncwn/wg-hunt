import { afterEach, describe, expect, it, vi } from "vitest";
import { readAnalysisSettings } from "../src/analysis-settings.js";
import { readCrawlSettings } from "../src/crawl/settings.js";
import { getSetting, putSetting } from "../src/db/settings.js";
import { bootTestApp } from "./helpers.js";

/** A literal on purpose: it must not follow the code. */
const ANALYSIS_SAVED = {
  model: "claude-sonnet-5-5",
  effort: "low",
  escalation: { model: "claude-sonnet-5-5", effort: "high" },
  batchOnly: true,
  monthlySpendCapUsd: 1,
  prices: [
    {
      model: "claude-haiku-5-5",
      inputUsdPerMTok: 0.1,
      outputUsdPerMTok: 0.5,
      efforts: ["low", "medium", "high", "xhigh", "max"],
      longPrompt: { aboveTokens: 100000, inputUsdPerMTok: 0.5, outputUsdPerMTok: 2.5 },
    },
    { model: "claude-haiku-4-5", inputUsdPerMTok: 1, outputUsdPerMTok: 5, efforts: [] },
    {
      model: "claude-sonnet-5-5",
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 10,
      efforts: ["low", "medium", "high", "xhigh", "max"],
    },
  ],
};

const CRAWL_SAVED = {
  pacing: {
    gapMinSeconds: 30,
    gapMaxSeconds: 90,
    sessionSize: 10,
    breakMinMinutes: 15,
    breakMaxMinutes: 40,
    hourlyCap: 20,
    dailyCap: 120,
    activeHours: { start: "08:00", end: "22:00" },
  },
  recheck: { enabled: false, maxPageAgeHours: 48 },
};

const CRAWL_FIELDS = [
  "pacing.gapMinSeconds",
  "pacing.gapMaxSeconds",
  "pacing.sessionSize",
  "pacing.breakMinMinutes",
  "pacing.breakMaxMinutes",
  "pacing.hourlyCap",
  "pacing.dailyCap",
  "pacing.activeHours",
  "recheck.enabled",
  "recheck.maxPageAgeHours",
];

afterEach(() => {
  vi.restoreAllMocks();
});

const ANALYSIS_TIED = ["model", "effort", "escalation", "prices"];
const ANALYSIS_FIELDS = [
  "model",
  "effort",
  "escalation",
  "batchOnly",
  "monthlySpendCapUsd",
  "prices",
];

describe("readAnalysisSettings", () => {
  it("keeps every saved field that still parses and names the one that does not", () => {
    const { db } = bootTestApp();
    const stored = JSON.stringify({ ...ANALYSIS_SAVED, batchOnly: "yes" });
    putSetting(db, "analysis", stored);

    const read = readAnalysisSettings(db);

    expect(read.settings.monthlySpendCapUsd).toBe(1);
    expect(read.settings.model).toBe("claude-sonnet-5-5");
    expect(read.settings.batchOnly).toBe(false);
    expect(read.source).toBe("partly-unreadable");
    expect(read.unreadable).toEqual(["batchOnly"]);
    expect(getSetting(db, "analysis")?.value).toBe(stored);
  });

  it("takes back only the field that no longer parses when its default breaks no rule", () => {
    const { db } = bootTestApp();
    putSetting(db, "analysis", JSON.stringify({ ...ANALYSIS_SAVED, effort: "extreme" }));

    const read = readAnalysisSettings(db);

    expect(read.settings).toEqual({ ...ANALYSIS_SAVED, effort: "medium" });
    expect(read.source).toBe("partly-unreadable");
    expect(read.unreadable).toEqual(["effort"]);
  });

  it("takes the model settings back together when a default breaks a rule between them", () => {
    const { db } = bootTestApp();
    putSetting(
      db,
      "analysis",
      JSON.stringify({ ...ANALYSIS_SAVED, model: "claude-haiku-4-5", effort: "extreme" }),
    );

    const read = readAnalysisSettings(db);

    expect(read.settings.monthlySpendCapUsd).toBe(1);
    expect(read.settings.batchOnly).toBe(true);
    expect(read.settings.model).toBe("claude-haiku-5-5");
    expect(read.settings.effort).toBe("medium");
    expect(read.unreadable).toEqual(ANALYSIS_TIED);
  });

  it("takes the model settings back together when they break a rule between them", () => {
    const { db } = bootTestApp();
    putSetting(db, "analysis", JSON.stringify({ ...ANALYSIS_SAVED, model: "claude-unknown-9" }));

    const read = readAnalysisSettings(db);

    expect(read.settings.monthlySpendCapUsd).toBe(1);
    expect(read.settings.model).toBe("claude-haiku-5-5");
    expect(read.unreadable).toEqual(ANALYSIS_TIED);
  });

  it("names the four model settings for a price table that is not a list", () => {
    const { db } = bootTestApp();
    putSetting(
      db,
      "analysis",
      JSON.stringify({ ...ANALYSIS_SAVED, prices: 3, model: "claude-unknown-9" }),
    );

    const read = readAnalysisSettings(db);

    expect(read.settings.monthlySpendCapUsd).toBe(1);
    expect(read.unreadable).toEqual(ANALYSIS_TIED);
  });

  it("says the defaults are in use when nothing is stored", () => {
    const { db } = bootTestApp();
    const read = readAnalysisSettings(db);
    expect(read.source).toBe("default");
    expect(read.unreadable).toEqual([]);
    expect(read.settings.monthlySpendCapUsd).toBe(5);
  });

  it("reads a saved document as saved", () => {
    const { db } = bootTestApp();
    putSetting(db, "analysis", JSON.stringify(ANALYSIS_SAVED));

    const read = readAnalysisSettings(db);

    expect(read.source).toBe("saved");
    expect(read.unreadable).toEqual([]);
    expect(read.settings).toEqual(ANALYSIS_SAVED);
  });

  it("names every field for a stored row that is not a JSON object", () => {
    const { db } = bootTestApp();
    putSetting(db, "analysis", "{");

    const read = readAnalysisSettings(db);

    expect(read.source).toBe("partly-unreadable");
    expect(read.unreadable).toEqual(ANALYSIS_FIELDS);
    expect(read.settings.monthlySpendCapUsd).toBe(5);
    expect(getSetting(db, "analysis")?.value).toBe("{");
  });
});

describe("readCrawlSettings", () => {
  it("keeps a saved daily cap when an unrelated field no longer parses", () => {
    const { db } = bootTestApp();
    const stored = JSON.stringify({
      ...CRAWL_SAVED,
      recheck: { ...CRAWL_SAVED.recheck, maxPageAgeHours: 0 },
    });
    putSetting(db, "crawl.settings", stored);

    const read = readCrawlSettings(db);

    expect(read.settings.pacing.dailyCap).toBe(120);
    expect(read.settings.recheck).toEqual({ enabled: false, maxPageAgeHours: 72 });
    expect(read.source).toBe("partly-unreadable");
    expect(read.unreadable).toEqual(["recheck.maxPageAgeHours"]);
    expect(getSetting(db, "crawl.settings")?.value).toBe(stored);
  });

  it("takes back only the gap that no longer parses when its default fits the other", () => {
    const { db } = bootTestApp();
    putSetting(
      db,
      "crawl.settings",
      JSON.stringify({
        ...CRAWL_SAVED,
        pacing: { ...CRAWL_SAVED.pacing, gapMinSeconds: 30, gapMaxSeconds: "x" },
      }),
    );

    const read = readCrawlSettings(db);

    expect(read.settings.pacing).toMatchObject({ gapMinSeconds: 30, gapMaxSeconds: 60 });
    expect(read.unreadable).toEqual(["pacing.gapMaxSeconds"]);
  });

  it("takes both gaps back together when the default for one breaks the rule between them", () => {
    const { db } = bootTestApp();
    putSetting(
      db,
      "crawl.settings",
      JSON.stringify({
        ...CRAWL_SAVED,
        pacing: { ...CRAWL_SAVED.pacing, gapMinSeconds: 90, gapMaxSeconds: "x" },
      }),
    );

    const read = readCrawlSettings(db);

    expect(read.settings.pacing).toMatchObject({ gapMinSeconds: 20, gapMaxSeconds: 60 });
    expect(read.settings.pacing.dailyCap).toBe(120);
    expect(read.unreadable).toEqual(["pacing.gapMinSeconds", "pacing.gapMaxSeconds"]);
  });

  it("takes both breaks back together when they break the rule between them", () => {
    const { db } = bootTestApp();
    putSetting(
      db,
      "crawl.settings",
      JSON.stringify({
        ...CRAWL_SAVED,
        pacing: { ...CRAWL_SAVED.pacing, breakMinMinutes: 50, breakMaxMinutes: 40 },
      }),
    );

    const read = readCrawlSettings(db);

    expect(read.settings.pacing).toMatchObject({ breakMinMinutes: 10, breakMaxMinutes: 30 });
    expect(read.unreadable).toEqual(["pacing.breakMinMinutes", "pacing.breakMaxMinutes"]);
  });

  it("says the defaults are in use when nothing is stored", () => {
    const { db } = bootTestApp();
    expect(readCrawlSettings(db)).toMatchObject({ source: "default", unreadable: [] });
  });

  it("reads a saved document as saved", () => {
    const { db } = bootTestApp();
    putSetting(db, "crawl.settings", JSON.stringify(CRAWL_SAVED));

    const read = readCrawlSettings(db);

    expect(read.source).toBe("saved");
    expect(read.settings).toEqual(CRAWL_SAVED);
  });

  it("names every field for a stored row that is not JSON", () => {
    const { db } = bootTestApp();
    putSetting(db, "crawl.settings", "{");

    const read = readCrawlSettings(db);

    expect(read.source).toBe("partly-unreadable");
    expect(read.unreadable).toEqual(CRAWL_FIELDS);
    expect(read.settings.pacing.dailyCap).toBe(300);
  });
});

describe("logging unreadable settings", () => {
  it("logs one line per field, by name and without its value, once until it changes", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, db, token } = bootTestApp();
    putSetting(db, "analysis", JSON.stringify({ ...ANALYSIS_SAVED, monthlySpendCapUsd: 987654 }));

    readAnalysisSettings(db);
    readAnalysisSettings(db);
    readAnalysisSettings(db);

    const lines = error.mock.calls.map((call) => String(call[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("monthlySpendCapUsd");
    expect(lines[0]).not.toContain("987654");

    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const got = await app.request("/api/v1/settings/analysis", { headers });
    const put = await app.request("/api/v1/settings/analysis", {
      method: "PUT",
      headers: { ...headers, "If-Match": got.headers.get("ETag") ?? "" },
      body: JSON.stringify(await got.json()),
    });
    expect(put.status).toBe(200);
    expect(error).toHaveBeenCalledTimes(1);

    putSetting(db, "analysis", JSON.stringify({ ...ANALYSIS_SAVED, monthlySpendCapUsd: -4 }));
    readAnalysisSettings(db);
    expect(error).toHaveBeenCalledTimes(2);
  });
});

function api(runtime: ReturnType<typeof bootTestApp>) {
  const headers = () => ({
    Authorization: `Bearer ${runtime.token}`,
    "Content-Type": "application/json",
  });
  return {
    get: (path: string) => runtime.app.request(`/api/v1${path}`, { headers: headers() }),
    put: (path: string, body: unknown, etag: string | null) =>
      runtime.app.request(`/api/v1${path}`, {
        method: "PUT",
        headers: { ...headers(), "If-Match": etag ?? "" },
        body: JSON.stringify(body),
      }),
  };
}

describe("GET /analysis", () => {
  it("serves where the settings came from until a save of them as read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = bootTestApp();
    const call = api(runtime);
    putSetting(runtime.db, "analysis", JSON.stringify({ ...ANALYSIS_SAVED, batchOnly: "yes" }));

    const status = await (await call.get("/analysis")).json();
    expect(status.settings).toEqual({ source: "partly-unreadable", unreadable: ["batchOnly"] });

    const got = await call.get("/settings/analysis");
    const body = await got.json();
    expect(body).not.toHaveProperty("source");
    expect(body.monthlySpendCapUsd).toBe(1);
    const put = await call.put("/settings/analysis", body, got.headers.get("ETag"));
    expect(put.status).toBe(200);
    expect(put.headers.get("ETag")).toBe(got.headers.get("ETag"));
    expect(await put.json()).toEqual(body);

    const after = await (await call.get("/analysis")).json();
    expect(after.settings).toEqual({ source: "saved", unreadable: [] });
  });

  it("says the defaults are in use when nothing is saved", async () => {
    const call = api(bootTestApp());
    const status = await (await call.get("/analysis")).json();
    expect(status.settings).toEqual({ source: "default", unreadable: [] });
  });
});

describe("GET /crawl", () => {
  it("serves where the settings came from, and a save of them as read publishes saved", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = bootTestApp();
    const call = api(runtime);
    putSetting(
      runtime.db,
      "crawl.settings",
      JSON.stringify({ ...CRAWL_SAVED, recheck: { ...CRAWL_SAVED.recheck, maxPageAgeHours: 0 } }),
    );

    const status = await (await call.get("/crawl")).json();
    expect(status.settings).toEqual({
      source: "partly-unreadable",
      unreadable: ["recheck.maxPageAgeHours"],
    });

    const events: { type: string; data: unknown }[] = [];
    runtime.events.subscribe((event) => events.push(event));
    const got = await call.get("/settings/crawl");
    const body = await got.json();
    expect(body).not.toHaveProperty("source");
    expect(body.pacing.dailyCap).toBe(120);
    const put = await call.put("/settings/crawl", body, got.headers.get("ETag"));
    expect(put.status).toBe(200);
    expect(put.headers.get("ETag")).toBe(got.headers.get("ETag"));
    expect(await put.json()).toEqual(body);

    const published = events.filter((event) => event.type === "crawl-status-changed").at(-1);
    expect(published?.data).toMatchObject({ settings: { source: "saved", unreadable: [] } });
    const after = await (await call.get("/crawl")).json();
    expect(after.settings).toEqual({ source: "saved", unreadable: [] });
  });
});
