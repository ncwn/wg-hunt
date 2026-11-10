import { CATEGORIES } from "@wg-hunt/core";
import { describe, expect, it } from "vitest";
import { type ForecastSearch, forecastDay, recheckRoom } from "../src/crawl/budget.js";
import { defaultCrawlSettings } from "../src/crawl/settings.js";

const search = (over: Partial<ForecastSearch> = {}): ForecastSearch => ({
  categories: ["flatshare-room"],
  recencyDays: 7,
  enabled: true,
  problem: null,
  pollInterval: { minMinutes: 30, maxMinutes: 60 },
  ...over,
});

const forecast = (searches: ForecastSearch[], settings = defaultCrawlSettings()) =>
  forecastDay({ searches, settings });

describe("the budget forecast", () => {
  it("gives two Searches at default settings about 55 polls, 30 Sweeps, 100 new Offers and 20 confirmations, leaving 95 for Rechecks", () => {
    const result = forecast([search(), search()]);
    expect(result.requests).toEqual({
      polls: 55,
      sweeps: 30,
      newOffers: 100,
      confirmations: 20,
      rechecks: 95,
    });
    expect(result.dailyCap).toBe(300);
    expect(result.stretch).toEqual({ factor: 1, applied: false });
    expect(result.warnings).toEqual([]);
  });

  it("counts a Search per category, and a shorter window as fewer Sweep pages", () => {
    const two = forecast([search({ categories: ["flatshare-room", "flat"] })]);
    expect(two.requests).toMatchObject({ polls: 55, sweeps: 30, newOffers: 100 });
    const oneDay = forecast([search({ recencyDays: 1 })]);
    expect(oneDay.requests.sweeps).toBe(3);
  });

  it("leaves out disabled Searches", () => {
    const result = forecast([search(), search({ enabled: false })]);
    expect(result.requests).toMatchObject({ polls: 28, sweeps: 15, newOffers: 50 });
  });

  it("follows the poll interval and the active hours", () => {
    // Every 90-150 min over 16.5 active hours is 8.25 polls a day, with a quarter more for page 2.
    const slow = forecast([search({ pollInterval: { minMinutes: 90, maxMinutes: 150 } })]);
    expect(slow.requests.polls).toBe(10);
    const settings = defaultCrawlSettings();
    const short = forecast([search()], {
      ...settings,
      pacing: { ...settings.pacing, activeHours: { start: "08:00", end: "12:00" } },
    });
    expect(short.requests.polls).toBe(7);
  });

  it("stretches every poll interval evenly when polls plus Sweeps pass half the daily cap", () => {
    // Four Searches: 110 polls + 60 Sweeps = 170 > 150, so polls shrink to 90.
    const result = forecast([search(), search(), search(), search()]);
    expect(result.requests.polls).toBe(90);
    expect(result.requests.sweeps).toBe(60);
    expect(result.requests.polls + result.requests.sweeps).toBeLessThanOrEqual(150);
    expect(result.stretch.applied).toBe(true);
    expect(result.stretch.factor).toBeCloseTo(110 / 90, 5);
    for (const each of result.searches) {
      expect(each.effectiveInterval.minMinutes).toBeCloseTo(30 * (110 / 90), 1);
      expect(each.effectiveInterval.maxMinutes).toBeCloseTo(60 * (110 / 90), 1);
    }
    expect(result.warnings.map((w) => w.type)).not.toContain("polls-below-one-per-2h");
  });

  it("warns when stretching takes polls below one per 2 h", () => {
    // Nine Searches: 247.5 polls + 135 Sweeps; only 15 requests are left for polls.
    const searches = Array.from({ length: 9 }, () => search());
    const result = forecast(searches);
    expect(result.requests.polls).toBe(15);
    const warning = result.warnings.find((w) => w.type === "polls-below-one-per-2h");
    expect(warning?.message).toMatch(/2 h/);
    expect(result.warnings.map((w) => w.type)).toContain("over-budget");
  });

  it("never reports negative budget for Rechecks", () => {
    const result = forecast(Array.from({ length: 9 }, () => search()));
    expect(result.requests.rechecks).toBe(0);
  });

  it("uses the draft settings it is given", () => {
    const settings = defaultCrawlSettings();
    const roomier = forecast([search(), search()], {
      ...settings,
      pacing: { ...settings.pacing, dailyCap: 400 },
    });
    expect(roomier.dailyCap).toBe(400);
    expect(roomier.requests.rechecks).toBe(195);

    // 205 requests do not fit in 200: nothing is left, and the forecast says so.
    const tight = forecast([search(), search()], {
      ...settings,
      pacing: { ...settings.pacing, dailyCap: 200 },
      recheck: { enabled: false, maxPageAgeHours: 72 },
    });
    expect(tight.requests.rechecks).toBe(0);
    expect(tight.recheck.enabled).toBe(false);
    expect(tight.warnings.map((w) => w.type)).toEqual(["over-budget"]);
  });
});

describe("the budget forecast with a Search the crawler does not read", () => {
  const unread = (over: Partial<ForecastSearch> = {}) =>
    search({ problem: "unknown-city", ...over });
  const working = [search(), search()];

  it("forecasts two working Searches the same with it as without it", () => {
    // Counted, its four categories would stretch every poll 2.75 times and pass the cap.
    const result = forecast([...working, unread({ categories: [...CATEGORIES] })]);
    expect(result.requests).toEqual(forecast(working).requests);
    expect(result.stretch).toEqual({ factor: 1, applied: false });
    expect(result.warnings).toEqual([]);
  });

  it("raises no over-budget warning on its account", () => {
    // Counted, one more category would make 308 requests against the cap of 300.
    expect(forecast([...working, unread()]).warnings).toEqual([]);
  });

  it("leaves automatic Rechecks the room they have without it", () => {
    const settings = defaultCrawlSettings();
    // 13:00 in Berlin (winter time): 10.5 of the 16.5 active hours are still ahead.
    const at = { usedToday: 60, now: Date.parse("2026-11-04T12:00:00Z") };
    const room = (searches: ForecastSearch[]) =>
      recheckRoom({
        forecast: forecast(searches, settings),
        activeHours: settings.pacing.activeHours,
        ...at,
      });
    expect(room(working)).toBeGreaterThan(0);
    expect(room([...working, unread({ categories: [...CATEGORIES] })])).toBe(room(working));
  });

  it("shows it at zero cost and says why", () => {
    const result = forecast([search({ id: 1 }), unread({ id: 2 })]);
    expect(result.searches).toEqual([
      expect.objectContaining({ id: 1, enabled: true, problem: null, polls: 28, sweeps: 15 }),
      expect.objectContaining({
        id: 2,
        enabled: true,
        problem: "unknown-city",
        polls: 0,
        sweeps: 0,
      }),
    ]);
  });

  it("does not count it as the slowest Search a stretch warning speaks of", () => {
    // Four working Searches stretch polls to about every 55 min, which is not worth that warning.
    const four = [search(), search(), search(), search()];
    const slow = unread({ pollInterval: { minMinutes: 240, maxMinutes: 300 } });
    expect(forecast([...four, slow]).warnings).toEqual(forecast(four).warnings);
    expect(forecast(four).warnings.map((w) => w.type)).not.toContain("polls-below-one-per-2h");
  });
});
