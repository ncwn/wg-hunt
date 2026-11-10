import { describe, expect, it } from "vitest";
import { readJson, writeJson } from "../src/crawl/kv.js";
import { bootTestApp } from "./helpers.js";

type App = ReturnType<typeof bootTestApp>;

async function call(app: App, method: string, path: string, body?: unknown) {
  const res = await app.app.request(`/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${app.token}`,
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  // biome-ignore lint/suspicious/noExplicitAny: tests read the API's JSON loosely
  return { status: res.status, body: (await res.json()) as any };
}

const berlin = { city: "Berlin", categories: ["flatshare-room"] };

/** As a successful probe after a Cooldown leaves the crawl: the caps are halved until `until`. */
function startHalfBudget(app: App, until: number) {
  const engine = readJson(app.db, "crawl.engine") as object | undefined;
  writeJson(app.db, "crawl.engine", { ...engine, halfBudgetUntil: until }, Date.now());
}

describe("GET /crawl/forecast", () => {
  it("needs the access token", async () => {
    const { app } = bootTestApp();
    expect((await app.request("/api/v1/crawl/forecast")).status).toBe(401);
  });

  it("forecasts the day for the stored Searches and settings", async () => {
    const app = bootTestApp();
    await call(app, "POST", "/searches", berlin);
    await call(app, "POST", "/searches", { ...berlin, city: "Hamburg", cityId: "55" });

    const { status, body } = await call(app, "GET", "/crawl/forecast");
    expect(status).toBe(200);
    expect(body.requests).toEqual({
      polls: 55,
      sweeps: 30,
      newOffers: 100,
      confirmations: 20,
      rechecks: 95,
    });
    expect(body.dailyCap).toBe(300);
    expect(body.stretch.applied).toBe(false);
    expect(body.searches).toHaveLength(2);
  });

  it("shows an enabled Search for a city the Source cannot resolve at zero cost, with the reason", async () => {
    const app = bootTestApp();
    await call(app, "POST", "/searches", berlin);
    await call(app, "POST", "/searches", { ...berlin, city: "Hamburg", cityId: "55" });
    const { body: before } = await call(app, "GET", "/crawl/forecast");

    // All four categories, enabled, and never polled or swept: the adapter has no id for the city.
    const { body: unknown } = await call(app, "POST", "/searches", {
      city: "Teststadt",
      categories: ["flatshare-room", "one-room-flat", "flat", "house"],
    });
    expect(unknown.enabled).toBe(true);
    expect(unknown.poll.problem).toBe("unknown-city");

    const { body } = await call(app, "GET", "/crawl/forecast");
    expect(body.requests).toEqual(before.requests);
    expect(body.stretch).toEqual({ factor: 1, applied: false });
    expect(body.warnings).toEqual([]);
    expect(body.searches).toHaveLength(3);
    expect(body.searches[0]).toMatchObject({ problem: null, polls: 28, sweeps: 15 });
    expect(body.searches[2]).toMatchObject({
      id: unknown.id,
      enabled: true,
      problem: "unknown-city",
      polls: 0,
      sweeps: 0,
    });
  });

  it("is empty with no Searches: everything is left for Rechecks", async () => {
    const { body } = await call(bootTestApp(), "GET", "/crawl/forecast");
    expect(body.requests).toEqual({
      polls: 0,
      sweeps: 0,
      newOffers: 0,
      confirmations: 0,
      rechecks: 300,
    });
  });
});

describe("POST /crawl/forecast", () => {
  it("forecasts draft Searches without saving anything", async () => {
    const app = bootTestApp();
    const { body: saved } = await call(app, "POST", "/searches", berlin);

    const draft = {
      searches: [
        {
          id: saved.id,
          categories: ["flatshare-room"],
          recencyDays: 7,
          enabled: true,
          pollInterval: { minMinutes: 15, maxMinutes: 15 },
        },
      ],
    };
    const { status, body } = await call(app, "POST", "/crawl/forecast", draft);
    expect(status).toBe(200);
    // Every 15 min across 16.5 active hours is 66 polls, and a quarter more for page 2.
    expect(body.requests.polls).toBe(83);
    expect(body.searches[0].id).toBe(saved.id);

    const stored = await call(app, "GET", "/searches");
    expect(stored.body.items[0].pollInterval).toEqual({ minMinutes: 30, maxMinutes: 60 });
    expect((await call(app, "GET", "/crawl/forecast")).body.requests.polls).toBe(28);
  });

  describe("with a Search the Source cannot read", () => {
    const everything = ["flatshare-room", "one-room-flat", "flat", "house"];
    const draftOf = (search: {
      id: number;
      categories: string[];
      recencyDays: number;
      enabled: boolean;
      pollInterval: object;
    }) => ({
      id: search.id,
      categories: search.categories,
      recencyDays: search.recencyDays,
      enabled: search.enabled,
      pollInterval: search.pollInterval,
    });

    async function withUnknownCity() {
      const app = bootTestApp();
      const { body: first } = await call(app, "POST", "/searches", berlin);
      const { body: second } = await call(app, "POST", "/searches", {
        ...berlin,
        city: "Hamburg",
        cityId: "55",
      });
      const { body: unknown } = await call(app, "POST", "/searches", {
        city: "Teststadt",
        categories: everything,
      });
      return { app, working: [draftOf(first), draftOf(second)], unknown: draftOf(unknown) };
    }

    it("judges a draft Search that names a stored one by that Search's city", async () => {
      const { app, working, unknown } = await withUnknownCity();
      const { body: now } = await call(app, "GET", "/crawl/forecast");

      const { body } = await call(app, "POST", "/crawl/forecast", {
        searches: [...working, unknown],
      });
      expect(body.requests).toEqual(now.requests);
      expect(body.warnings).toEqual([]);
      expect(body.searches[2]).toMatchObject({
        id: unknown.id,
        problem: "unknown-city",
        polls: 0,
        sweeps: 0,
      });
    });

    it("charges for it once the draft gives the city an id", async () => {
      const { app, working, unknown } = await withUnknownCity();
      const { body } = await call(app, "POST", "/crawl/forecast", {
        searches: [...working, { ...unknown, cityId: "4711" }],
      });
      // Four more categories: polls plus Sweeps pass half the cap, and the day's total the cap.
      expect(body.searches[2]).toMatchObject({ id: unknown.id, problem: null, sweeps: 60 });
      expect(body.stretch.applied).toBe(true);
      expect(body.warnings.map((w: { type: string }) => w.type)).toContain("over-budget");
    });

    it("stops charging for a working Search the draft moves to a city it cannot resolve", async () => {
      const { app, working } = await withUnknownCity();
      const [first, second] = working;
      const { body } = await call(app, "POST", "/crawl/forecast", {
        searches: [
          { ...first, city: "Teststadt" },
          // Hamburg is known by name, so it reads on without the id it was stored with.
          { ...second, cityId: null },
        ],
      });
      expect(body.searches.map((s: { problem: string | null }) => s.problem)).toEqual([
        "unknown-city",
        null,
      ]);
      expect(body.requests).toMatchObject({ polls: 28, sweeps: 15, newOffers: 50 });
    });

    it("judges a new Search by the city the draft gives, and takes one without a city as readable", async () => {
      const app = bootTestApp();
      const draft = {
        categories: ["flatshare-room"],
        recencyDays: 7,
        enabled: true,
        pollInterval: { minMinutes: 30, maxMinutes: 60 },
      };
      const { status, body } = await call(app, "POST", "/crawl/forecast", {
        searches: [
          draft,
          { ...draft, city: "Berlin" },
          { ...draft, city: "Teststadt" },
          // A city still being typed is no error: it is a city the Source cannot resolve.
          { ...draft, city: "", cityId: "5a" },
        ],
      });
      expect(status).toBe(200);
      expect(body.searches.map((s: { problem: string | null }) => s.problem)).toEqual([
        null,
        null,
        "unknown-city",
        "unknown-city",
      ]);
      expect(body.requests).toMatchObject({ polls: 55, sweeps: 30, newOffers: 100 });
    });
  });

  it("forecasts draft settings", async () => {
    const app = bootTestApp();
    await call(app, "POST", "/searches", berlin);
    const { body: current } = await call(app, "GET", "/settings/crawl");
    const { constants: _constants, ...settings } = current;
    const draft = {
      settings: { ...settings, pacing: { ...settings.pacing, dailyCap: 100 } },
    };
    const { body } = await call(app, "POST", "/crawl/forecast", draft);
    expect(body.dailyCap).toBe(100);
    // 28 polls + 15 Sweep pages fit in half the cap, but 50 new Offers and 10 confirmations
    // on top make 103.
    expect(body.requests.rechecks).toBe(0);
    expect(body.warnings.map((w: { type: string }) => w.type)).toContain("over-budget");
  });

  it("uses the stored Searches and settings for what the draft leaves out", async () => {
    const app = bootTestApp();
    await call(app, "POST", "/searches", berlin);
    const { body } = await call(app, "POST", "/crawl/forecast", {});
    expect(body.requests.polls).toBe(28);
  });

  it("refuses a draft that breaks a constant", async () => {
    const app = bootTestApp();
    const { body: current } = await call(app, "GET", "/settings/crawl");
    const { constants: _constants, ...settings } = current;
    const { status, body } = await call(app, "POST", "/crawl/forecast", {
      settings: { ...settings, pacing: { ...settings.pacing, dailyCap: 601 } },
    });
    expect(status).toBe(400);
    expect(body.type).toMatch(/validation-error/);
  });

  it("warns when a draft would take polls below one per 2 h", async () => {
    const app = bootTestApp();
    const searches = Array.from({ length: 9 }, () => ({
      categories: ["flatshare-room"],
      recencyDays: 7,
      enabled: true,
      pollInterval: { minMinutes: 30, maxMinutes: 60 },
    }));
    const { body } = await call(app, "POST", "/crawl/forecast", { searches });
    expect(body.stretch.applied).toBe(true);
    expect(body.warnings.map((w: { type: string }) => w.type)).toContain("polls-below-one-per-2h");
  });
});

describe("the forecast during the half-budget period after a Cooldown", () => {
  it("works from the halved cap and says until when it applies", async () => {
    const app = bootTestApp();
    await call(app, "POST", "/searches", berlin);
    await call(app, "POST", "/searches", { ...berlin, city: "Hamburg", cityId: "55" });
    expect((await call(app, "GET", "/crawl/forecast")).body.halfBudget).toBeNull();

    const until = Date.now() + 20 * 3_600_000;
    startHalfBudget(app, until);
    const { body } = await call(app, "GET", "/crawl/forecast");
    expect(body.dailyCap).toBe(150);
    expect(body.halfBudget).toEqual({ until: new Date(until).toISOString(), fullDailyCap: 300 });
    // 55 polls + 30 Sweep pages pass half of 150, so polls stretch to the 45 left.
    expect(body.stretch).toEqual({ factor: 55 / 45, applied: true });
    expect(body.requests.polls).toBe(45);
    expect(body.requests.rechecks).toBe(0);
  });

  it("halves a draft's cap too, so a draft compares with what runs now", async () => {
    const app = bootTestApp();
    startHalfBudget(app, Date.now() + 3_600_000);
    const { body: current } = await call(app, "GET", "/settings/crawl");
    const { constants: _constants, ...settings } = current;
    const { body } = await call(app, "POST", "/crawl/forecast", {
      settings: { ...settings, pacing: { ...settings.pacing, dailyCap: 100 } },
    });
    expect(body.dailyCap).toBe(50);
    expect(body.halfBudget.fullDailyCap).toBe(100);
  });

  it("is back to the full cap once the period is over", async () => {
    const app = bootTestApp();
    startHalfBudget(app, Date.now() - 1);
    const { body } = await call(app, "GET", "/crawl/forecast");
    expect(body.dailyCap).toBe(300);
    expect(body.halfBudget).toBeNull();
  });
});
