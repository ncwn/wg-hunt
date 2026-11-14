import { describe, expect, it } from "vitest";
import {
  IllegalSweepTransition,
  isComplete,
  readSweep,
  type Sweep,
  sweepRowValues,
  transition,
} from "../src/crawl/sweep-state.js";

const categories = ["flatshare-room", "flat"] as const;
const scheduled: Sweep = {
  specKey: "k",
  generation: 3,
  lastFinishedAt: 100,
  state: { status: "scheduled", mode: "daily", startAt: 500 },
};

const read = (sweep: Sweep, category: (typeof categories)[number], page: number, more: boolean) =>
  transition(sweep, { type: "page-read", categories, category, page, cards: 20, more, now: 900 });

describe("the Sweep transition", () => {
  it("starts running on the first page, with a cursor per category, and counts pages and cards", () => {
    const after = read(scheduled, "flatshare-room", 0, true);
    expect(after).toEqual({
      specKey: "k",
      generation: 3,
      lastFinishedAt: 100,
      state: {
        status: "running",
        mode: "daily",
        startedAt: 900,
        cursors: { "flatshare-room": 1, flat: 0 },
        pagesRead: 1,
        cardCount: 20,
      },
    });
    const done = read(read(after, "flatshare-room", 1, false), "flat", 0, false);
    expect(isComplete(done.state, categories)).toBe(true);
    expect(done.state).toMatchObject({ pagesRead: 3, cardCount: 60, startedAt: 900 });
  });

  it("finishes into a daily Sweep with a new generation", () => {
    const running = read(scheduled, "flatshare-room", 0, false);
    expect(transition(running, { type: "finish", now: 1000, startAt: 2000 })).toEqual({
      specKey: "k",
      generation: 4,
      lastFinishedAt: 1000,
      state: { status: "scheduled", mode: "daily", startAt: 2000 },
    });
  });

  it("keeps the mode when a Sweep is given up", () => {
    const backfill = transition(scheduled, {
      type: "start",
      specKey: "k2",
      mode: "backfill",
      startAt: 600,
    });
    const running = read(backfill, "flat", 0, true);
    expect(transition(running, { type: "give-up", startAt: 3000 }).state).toEqual({
      status: "scheduled",
      mode: "backfill",
      startAt: 3000,
    });
  });

  it("refuses to read, give up or finish when there is no live Sweep", () => {
    const idle = transition(scheduled, { type: "stop", specKey: "k" });
    expect(idle).toMatchObject({ generation: 4, state: { status: "idle" } });
    expect(() => read(idle, "flat", 0, true)).toThrow(IllegalSweepTransition);
    expect(() => transition(idle, { type: "give-up", startAt: 1 })).toThrow(IllegalSweepTransition);
    expect(() => transition(scheduled, { type: "finish", now: 1, startAt: 2 })).toThrow(
      IllegalSweepTransition,
    );
    expect(() => transition(undefined, { type: "finish", now: 1, startAt: 2 })).toThrow(
      IllegalSweepTransition,
    );
  });
});

describe("a stored Sweep row", () => {
  const row = (values: Partial<ReturnType<typeof sweepRowValues>>) => ({
    ...sweepRowValues(1, read(scheduled, "flatshare-room", 0, true)),
    ...values,
  });

  it("round-trips every state", () => {
    const running = read(scheduled, "flatshare-room", 0, true);
    for (const sweep of [scheduled, running, transition(running, { type: "stop", specKey: "k" })]) {
      expect(readSweep(sweepRowValues(1, sweep), categories)).toEqual(sweep);
    }
  });

  it.each([
    ["running with no start time", { startedAt: null }],
    ["running with no cursors", { cursors: null }],
    ["running with a category missing its cursor", { cursors: { "flatshare-room": 1 } }],
    ["running with no mode", { mode: null }],
    ["scheduled with no start", { status: "scheduled" as const, startAt: null }],
  ])("is invalid when %s", (_name, values) => {
    expect(readSweep(row(values), categories)).toEqual({
      invalid: true,
      specKey: "k",
      generation: 3,
    });
  });
});
