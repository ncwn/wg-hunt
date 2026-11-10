import type { CardOnline } from "@wg-hunt/core";
import { describe, expect, it } from "vitest";
import { olderThan, publishWindow, wasBumped } from "../src/crawl/publish-window.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-04T09:00:00Z");

const relative = (minutes: number, unitMinutes: number): CardOnline => ({
  age: { kind: "relative", minutes },
  unitMinutes,
});

describe("publish window", () => {
  it("is one unit wide for a relative age, ending at the age itself", () => {
    expect(publishWindow(relative(480, 60), NOW)).toEqual({
      earliest: NOW - 9 * HOUR,
      latest: NOW - 8 * HOUR,
      unit: HOUR,
    });
  });

  it("is the Berlin calendar day for a date", () => {
    const window = publishWindow(
      { age: { kind: "date", date: "2026-10-29" }, unitMinutes: 1440 },
      NOW,
    );
    // Summer time ended on 25 October: Berlin is UTC+1.
    expect(window.earliest).toBe(Date.parse("2026-10-28T23:00:00Z"));
    expect(window.latest).toBe(Date.parse("2026-10-29T23:00:00Z") - 1);
    expect(window.unit).toBe(DAY);
  });
});

describe("Bumped", () => {
  it("is not claimed for an Ad ID whose age only moved on with the clock", () => {
    const before = publishWindow(relative(15, 1), NOW);
    const later = publishWindow(relative(45, 1), NOW + 30 * MINUTE);
    expect(wasBumped(before, later)).toBe(false);
    // Hours round down, so "1 Std." read half an hour later is still the same publish.
    const hours = publishWindow(relative(60, 60), NOW);
    expect(wasBumped(hours, publishWindow(relative(60, 60), NOW + 30 * MINUTE))).toBe(false);
  });

  it("is not claimed when the age rounds the other way or the clocks differ by a minute", () => {
    const before = publishWindow(relative(15, 1), NOW);
    expect(wasBumped(before, publishWindow(relative(15, 1), NOW + MINUTE))).toBe(false);
    expect(wasBumped(before, publishWindow(relative(16, 1), NOW + MINUTE))).toBe(false);
  });

  it("is claimed for an Ad ID that came back to the top", () => {
    const before = publishWindow(relative(8 * 60, 60), NOW);
    const after = publishWindow(relative(3, 1), NOW + 20 * MINUTE);
    expect(wasBumped(before, after)).toBe(true);
  });
});

describe("older than 7 days", () => {
  it("holds only when the newest possible publish is more than 7 days back", () => {
    const dated = (date: string): CardOnline => ({
      age: { kind: "date", date },
      unitMinutes: 1440,
    });
    expect(olderThan(publishWindow(dated("2026-10-27"), NOW), 7, NOW)).toBe(true);
    // 28 October may be exactly 7 days ago in places: not certain, so not old.
    expect(olderThan(publishWindow(dated("2026-10-28"), NOW), 7, NOW)).toBe(false);
    expect(olderThan(publishWindow(relative(4 * 1440, 1440), NOW), 7, NOW)).toBe(false);
    expect(olderThan(publishWindow(relative(DAY / MINUTE, 1), NOW), 7, NOW)).toBe(false);
  });
});
