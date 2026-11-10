import { describe, expect, it } from "vitest";
import { sinceInstant } from "../src/commands/args.js";

const NOW = Date.parse("2026-11-10T12:00:00Z");

describe("--since", () => {
  it("takes a span back from now", () => {
    expect(sinceInstant("90m", NOW)).toBe("2026-11-10T10:30:00.000Z");
    expect(sinceInstant("7d", NOW)).toBe("2026-11-03T12:00:00.000Z");
  });

  it.each([
    ["winter, CET", "2026-01-15", "2026-01-14T23:00:00.000Z"],
    ["summer, CEST", "2026-07-15", "2026-07-14T22:00:00.000Z"],
    [
      "the day the clocks go forward, still CET at midnight",
      "2026-03-29",
      "2026-03-28T23:00:00.000Z",
    ],
    [
      "the day the clocks go back, still CEST at midnight",
      "2026-10-25",
      "2026-10-24T22:00:00.000Z",
    ],
  ])("reads a bare date as midnight in Berlin: %s", (_name, date, instant) => {
    expect(sinceInstant(date, NOW)).toBe(instant);
  });

  it("reads a time without an offset as Berlin time too", () => {
    expect(sinceInstant("2026-01-15T08:30", NOW)).toBe("2026-01-15T07:30:00.000Z");
    expect(sinceInstant("2026-07-15T08:30:00", NOW)).toBe("2026-07-15T06:30:00.000Z");
  });

  it("keeps an explicit offset", () => {
    expect(sinceInstant("2026-07-15T08:30:00Z", NOW)).toBe("2026-07-15T08:30:00.000Z");
    expect(sinceInstant("2026-07-15T08:30:00+05:00", NOW)).toBe("2026-07-15T03:30:00.000Z");
  });

  it.each(["yesterday", "15.07.2026", "2026-13-45"])("refuses %s", (value) => {
    expect(() => sinceInstant(value, NOW)).toThrow(/--since takes/);
  });
});
