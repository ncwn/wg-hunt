import { join } from "node:path";
import { ANALYSIS_PREFIX, MAX_OUTPUT_TOKENS } from "@wg-hunt/core";
import { describe, expect, it } from "vitest";
import { createSpendLedger } from "../src/analysis/spend.js";
import { defaultAnalysisSettings, saveAnalysisSettings } from "../src/analysis-settings.js";
import { openDatabase } from "../src/db/index.js";
import { analysisBatches } from "../src/db/schema.js";
import { createEventBus, type ServerEvent } from "../src/events.js";
import { tempDataDir } from "./helpers.js";

const NOV_10 = Date.parse("2026-11-10T12:00:00Z");

function ledger(options: { cap?: number; start?: number } = {}) {
  const db = openDatabase(join(tempDataDir(), "test.db"));
  const clock = { now: options.start ?? NOV_10 };
  const events: ServerEvent[] = [];
  const bus = createEventBus();
  bus.subscribe((event) => events.push(event));
  const settings = { ...defaultAnalysisSettings(), monthlySpendCapUsd: options.cap ?? 5 };
  saveAnalysisSettings(db, settings);
  return {
    db,
    clock,
    events,
    ledger: createSpendLedger({ db, clock: () => clock.now, events: bus }),
    setCap(cap: number) {
      saveAnalysisSettings(db, { ...settings, monthlySpendCapUsd: cap });
    },
    batchHolds(micros: number) {
      db.insert(analysisBatches)
        .values({
          state: "in_progress",
          reservedMicros: micros,
          requestCount: 1,
          createdAt: new Date(clock.now),
        })
        .run();
    },
  };
}

const usage = (over: Partial<Record<string, number>> = {}) => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...over,
});

const HAIKU = { model: "claude-haiku-5-5", effort: "medium" as const };

describe("recording what a call used", () => {
  it("adds up cost from every token type and the price table, in the month it happened", () => {
    const { ledger: l } = ledger();

    l.record({
      ...HAIKU,
      batch: false,
      usage: usage({
        inputTokens: 40_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 30_000,
        cacheWriteTokens: 20_000,
      }),
    });

    // Input $0.10, cache write $0.125, cache read $0.01 and output $0.50 per million tokens.
    expect(l.capState().spentUsd).toBeCloseTo(0.5068, 6);
  });

  it("charges a batch call half", () => {
    const { ledger: l } = ledger();

    l.record({
      ...HAIKU,
      batch: true,
      usage: usage({ inputTokens: 50_000, outputTokens: 1_000_000 }),
    });

    expect(l.capState().spentUsd).toBeCloseTo(0.2525, 6);
  });

  it("charges a long prompt at the model's long-prompt rate", () => {
    const { ledger: l } = ledger();

    l.record({
      ...HAIKU,
      batch: false,
      usage: usage({ inputTokens: 200_000, outputTokens: 10_000 }),
    });

    expect(l.capState().spentUsd).toBeCloseTo((200_000 * 0.5 + 10_000 * 2.5) / 1e6, 6);
  });

  it("rounds a call's cost up to a whole millionth of a dollar, never down", () => {
    const { ledger: l } = ledger();

    l.record({ ...HAIKU, batch: false, usage: usage({ inputTokens: 1 }) });

    // One input token is 0.1 micro-dollars; the ledger keeps 1.
    expect(l.spentUsd()).toBe(0.000001);
  });

  it("does not drift on a cost that is an exact number of millionths", () => {
    const { ledger: l } = ledger();

    l.record({ ...HAIKU, batch: false, usage: usage({ inputTokens: 1000, outputTokens: 200 }) });

    expect(l.spentUsd()).toBe(0.0002);
  });
});

describe("the month", () => {
  it("starts a new count on the first of the month in Berlin", () => {
    const { ledger: l, clock } = ledger({ start: Date.parse("2026-11-30T22:30:00Z") });
    l.record({ ...HAIKU, batch: false, usage: usage({ inputTokens: 50_000 }) });
    expect(l.capState()).toMatchObject({ month: "2026-11", spentUsd: 0.005 });

    // 23:30 UTC on the 30th is 00:30 on 1 December in Berlin.
    clock.now = Date.parse("2026-11-30T23:30:00Z");

    expect(l.capState()).toMatchObject({ month: "2026-12", spentUsd: 0 });
  });

  it("counts the winter-time evening of the last day in the old month", () => {
    const { ledger: l, clock } = ledger({ start: Date.parse("2026-11-30T22:59:00Z") });
    expect(l.capState().month).toBe("2026-11");
    clock.now = Date.parse("2026-11-30T23:00:00Z");
    expect(l.capState().month).toBe("2026-12");
  });
});

describe("the cap", () => {
  it("is reached when what is left cannot pay for one more call", () => {
    const { ledger: l } = ledger({ cap: 1 });
    expect(l.capState().state).toBe("ok");

    l.record({ ...HAIKU, batch: false, usage: usage({ outputTokens: 2_000_000 }) });

    expect(l.capState()).toMatchObject({
      state: "reached",
      spentUsd: 1,
      capUsd: 1,
      headroomUsd: 0,
    });
  });

  it("is always reached with a cap of zero", () => {
    expect(ledger({ cap: 0 }).ledger.capState().state).toBe("reached");
  });

  it("is waiting for what is in flight when only a batch's reservation holds it", () => {
    const { ledger: l, batchHolds } = ledger({ cap: 0.01 });
    batchHolds(9_000);

    expect(l.capState()).toMatchObject({ state: "waiting-for-in-flight", reservedUsd: 0.009 });
  });

  it("stays ok while a realtime call in flight holds what a batch call would need", () => {
    const { ledger: l } = ledger({ cap: 0.01 });
    const hold = l.reserve(9_000);

    expect(l.capState()).toMatchObject({ state: "ok", reservedUsd: 0.009, headroomUsd: 0.001 });
    expect(l.reserve(9_000)).toBeUndefined();
    hold?.release();
    expect(l.capState()).toMatchObject({ state: "ok", reservedUsd: 0, headroomUsd: 0.01 });
  });

  it("says when the month starts over, in Berlin time", () => {
    expect(ledger().ledger.capState().resetsAt).toBe("2026-11-30T23:00:00.000Z");
    // Summer time: Berlin midnight on 1 April is 22:00 UTC.
    expect(ledger({ start: Date.parse("2026-03-31T21:59:00Z") }).ledger.capState()).toMatchObject({
      month: "2026-03",
      resetsAt: "2026-03-31T22:00:00.000Z",
    });
  });

  it("is read without side effects: only sync() announces", () => {
    const { ledger: l, events } = ledger({ cap: 1 });
    l.record({ ...HAIKU, batch: false, usage: usage({ outputTokens: 2_000_000 }) });

    l.capState();
    l.capState();
    expect(events).toHaveLength(0);

    l.sync();
    l.sync();
    expect(events.map((event) => event.type)).toEqual(["spend-cap-reached"]);
    expect(events[0]?.data).toMatchObject({ month: "2026-11", capUsd: 1, state: "reached" });
  });

  it("announces cleared in a later month, and reached again after the cap is raised and lowered", () => {
    const { ledger: l, events, clock, setCap } = ledger({ cap: 0.5 });
    l.record({ ...HAIKU, batch: false, usage: usage({ outputTokens: 1_000_000 }) });
    l.sync();

    clock.now = Date.parse("2026-12-02T12:00:00Z");
    l.sync();
    l.record({ ...HAIKU, batch: false, usage: usage({ outputTokens: 1_000_000 }) });
    l.sync();

    setCap(5);
    l.sync();
    setCap(0.5);
    l.sync();

    expect(events.map((event) => [event.type, (event.data as { month: string }).month])).toEqual([
      ["spend-cap-reached", "2026-11"],
      ["spend-cap-cleared", "2026-12"],
      ["spend-cap-reached", "2026-12"],
      ["spend-cap-cleared", "2026-12"],
      ["spend-cap-reached", "2026-12"],
    ]);
  });

  it("does not flash held and cleared around each realtime call that leaves less than a batch call", () => {
    const { ledger: l, events } = ledger({ cap: 0.01 });
    const hold = l.reserve(9_000);
    l.record({ ...HAIKU, batch: false, usage: usage({ outputTokens: 10 }) });
    hold?.release();

    expect(events).toHaveLength(0);
  });

  it("announces a change when a realtime call's reservation is released", () => {
    const { ledger: l, events } = ledger({ cap: 0.01 });
    const hold = l.reserve(9_000);
    l.record({ ...HAIKU, batch: false, usage: usage({ outputTokens: 20_000 }) });

    hold?.release();

    expect(events.map((event) => [event.type, (event.data as { state: string }).state])).toEqual([
      ["spend-cap-reached", "reached"],
    ]);
  });
});

describe("reserving before a call", () => {
  const request = {
    ...HAIKU,
    prefix: ANALYSIS_PREFIX,
    userTurn: "x".repeat(4000),
  };

  it("estimates the worst a request can cost: its input written to the cache and the most output", () => {
    const { ledger: l } = ledger();

    const worst = l.estimateMicros(request, { batch: false });

    const inputTokens = Math.ceil((request.prefix.length + request.userTurn.length) / 2);
    // Each estimated input token at 1.25 times 0.10 per million, the output at 0.50 per million.
    const floor = (inputTokens * 0.125 + MAX_OUTPUT_TOKENS * 0.5) as number;
    expect(worst).toBeGreaterThanOrEqual(Math.floor(floor));
    expect(worst).toBeLessThan(floor * 1.2);
  });

  it("halves the estimate for a batch", () => {
    const { ledger: l } = ledger();
    const standard = l.estimateMicros(request, { batch: false }) ?? 0;
    const batch = l.estimateMicros(request, { batch: true }) ?? 0;
    expect(Math.abs(batch * 2 - standard)).toBeLessThanOrEqual(2);
  });

  it("has no estimate for a model that is not in the price table", () => {
    const { ledger: l } = ledger();
    expect(l.estimateMicros({ ...request, model: "claude-unknown-9" }, { batch: false })).toBe(
      undefined,
    );
  });

  it("refuses a call the rest of the cap could not pay for in the worst case, and lets a smaller one in", () => {
    const { ledger: l } = ledger({ cap: 0.005 });
    const worst = l.estimateMicros(request, { batch: false }) ?? 0;
    expect(worst).toBeGreaterThan(5000);

    expect(l.reserve(worst)).toBeUndefined();
    expect(l.reserve(4000)).toBeDefined();
  });

  it("holds a reservation against the cap until it is released", () => {
    const { ledger: l } = ledger({ cap: 0.01 });

    const first = l.reserve(6000);
    expect(l.reserve(6000)).toBeUndefined();
    first?.release();

    expect(l.reserve(6000)).toBeDefined();
  });

  it("counts what was spent this month against the reservation", () => {
    const { ledger: l } = ledger({ cap: 0.01 });
    l.record({ ...HAIKU, batch: false, usage: usage({ outputTokens: 12_000 }) });

    expect(l.reserve(4001)).toBeUndefined();
    expect(l.reserve(4000)).toBeDefined();
  });
});
