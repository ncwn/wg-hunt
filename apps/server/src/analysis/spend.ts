import {
  ANALYSIS_PREFIX,
  type AnalysisRequest,
  MAX_OUTPUT_TOKENS,
  type ModelChoice,
  type ModelPrice,
  type TokenUsage,
  usageCostUsd,
} from "@wg-hunt/core";
import { eq, ne, sql } from "drizzle-orm";
import { type AnalysisSettings, loadAnalysisSettings } from "../analysis-settings.js";
import { ACTIVE_HOURS_ZONE } from "../crawl/constants.js";
import type { Db } from "../db/index.js";
import { analysisBatches, analysisUsage } from "../db/schema.js";
import type { EventBus } from "../events.js";

const MICROS = 1_000_000;

/** Rounded up, after dropping float noise below a nano-dollar. */
export function usdToMicros(usd: number): number {
  return Math.ceil(Math.round(usd * 1e9) / 1e3);
}

const monthFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: ACTIVE_HOURS_ZONE,
  year: "numeric",
  month: "2-digit",
});

/** The Berlin calendar month, such as `2026-11`. */
function monthOf(ms: number): string {
  const parts = monthFormat.formatToParts(ms);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}`;
}

function estimateInputTokens(request: AnalysisRequest): number {
  // The rest is the structured-output instructions the API adds to every request.
  return Math.ceil((request.prefix.length + request.userTurn.length) / 2) + 500;
}

/** Berlin midnight on the 1st is 22:00 or 23:00 UTC the day before, depending on summer time. */
function nextMonthStart(ms: number): string {
  const [year, month] = monthOf(ms).split("-").map(Number) as [number, number];
  const next = monthOf(Date.UTC(year, month, 1, 12));
  const base = Date.UTC(year, month, 1);
  const start = [base - 2 * 3_600_000, base - 3_600_000, base].find((at) => monthOf(at) === next);
  return new Date(start ?? base).toISOString();
}

const NOMINAL_OFFER_CHARS = 8_000;

/**
 * A realtime call in flight is not counted: it lasts seconds, and counting it would flip the state
 * around every call. Every hold is still checked against the full headroom.
 */
export type CapState = "ok" | "waiting-for-in-flight" | "reached";

export type SpendState = {
  month: string;
  spentUsd: number;
  capUsd: number;
  reservedUsd: number;
  /** Negative after the cap is lowered under spend and reservations. */
  headroomUsd: number;
  state: CapState;
  resetsAt: string;
};

export type SpendLedger = ReturnType<typeof createSpendLedger>;

/**
 * Each call (or batch) is reserved at its worst case before it is sent, so the cap holds before
 * any money goes out; its actual cost then replaces it.
 */
export function createSpendLedger(deps: {
  db: Db;
  clock: () => number;
  events: EventBus;
  onChange?: () => void;
}) {
  const { db, clock, events } = deps;
  let realtimeReserved = 0;

  const settings = (): AnalysisSettings => loadAnalysisSettings(db);

  function priceOf(model: string, table: AnalysisSettings["prices"]): ModelPrice | undefined {
    return table.find((price) => price.model === model);
  }

  /**
   * What an unpriced model is billed at when a result for it comes back: the dearest entry in the
   * table, so an unknown model can only make the cap stricter.
   */
  function dearest(table: AnalysisSettings["prices"]): ModelPrice {
    return table.reduce<ModelPrice>(
      (top, price) =>
        price.outputUsdPerMTok + price.inputUsdPerMTok > top.outputUsdPerMTok + top.inputUsdPerMTok
          ? price
          : top,
      { inputUsdPerMTok: 0, outputUsdPerMTok: 0 },
    );
  }

  const spentMicros = (month: string = monthOf(clock())): number =>
    db
      .select({ total: sql<number>`coalesce(sum(${analysisUsage.costMicros}), 0)` })
      .from(analysisUsage)
      .where(eq(analysisUsage.month, month))
      .get()?.total ?? 0;

  const batchReservedMicros = (): number =>
    db
      .select({ total: sql<number>`coalesce(sum(${analysisBatches.reservedMicros}), 0)` })
      .from(analysisBatches)
      .where(ne(analysisBatches.state, "ended"))
      .get()?.total ?? 0;

  const capMicros = (): number => usdToMicros(settings().monthlySpendCapUsd);

  const headroomMicros = (): number =>
    capMicros() - spentMicros() - realtimeReserved - batchReservedMicros();

  /** The hold itself is always checked against `headroomMicros`. */
  const headroomBetweenCallsMicros = (): number => headroomMicros() + realtimeReserved;

  /** Worst case: all input as cache writes plus the maximum output. Nothing unpriced is sent. */
  function estimateMicros(
    request: AnalysisRequest,
    options: { batch: boolean },
  ): number | undefined {
    const price = priceOf(request.model, settings().prices);
    if (price === undefined) return undefined;
    const worst: TokenUsage = {
      inputTokens: 0,
      outputTokens: MAX_OUTPUT_TOKENS,
      cacheReadTokens: 0,
      cacheWriteTokens: estimateInputTokens(request),
    };
    return usdToMicros(usageCostUsd(worst, price, options));
  }

  function nominalCallMicros(current: AnalysisSettings, options: { batch: boolean }): number {
    const request: AnalysisRequest = {
      model: current.model,
      effort: current.effort,
      prefix: ANALYSIS_PREFIX,
      userTurn: "x".repeat(NOMINAL_OFFER_CHARS),
    };
    // Unpriced: no call is worth making.
    return estimateMicros(request, options) ?? Number.POSITIVE_INFINITY;
  }

  /** Reads only: announcing a change is `sync()`'s job. */
  function capState(): SpendState {
    const current = settings();
    const month = monthOf(clock());
    const spent = spentMicros(month);
    const cap = usdToMicros(current.monthlySpendCapUsd);
    const batchReserved = batchReservedMicros();
    const reserved = realtimeReserved + batchReserved;
    const headroom = cap - spent - reserved;
    // The cheapest way any work goes out: backfills, escalations and runs always use the Batch API.
    const smallest = nominalCallMicros(current, { batch: true });
    const state: CapState =
      cap - spent - batchReserved >= smallest
        ? "ok"
        : cap - spent >= smallest
          ? "waiting-for-in-flight"
          : "reached";
    return {
      month,
      spentUsd: spent / MICROS,
      capUsd: current.monthlySpendCapUsd,
      reservedUsd: reserved / MICROS,
      headroomUsd: headroom / MICROS,
      state,
      resetsAt: nextMonthStart(clock()),
    };
  }

  /** Last announced on `/events`; a fresh process starts at `ok`, so a held cap is said once. */
  let announced: CapState = "ok";

  function sync(): SpendState {
    const now = capState();
    if (now.state !== announced) {
      announced = now.state;
      events.publish(now.state === "ok" ? "spend-cap-cleared" : "spend-cap-reached", now);
      deps.onChange?.();
    }
    return now;
  }

  return {
    reservedMicros: () => realtimeReserved + batchReservedMicros(),
    headroomMicros,
    headroomBetweenCallsMicros,
    estimateMicros,
    capState,
    sync,
    spentUsd: () => spentMicros() / MICROS,
    fitsRealtime: () =>
      headroomBetweenCallsMicros() >= nominalCallMicros(settings(), { batch: false }),

    /** Returns its cost in micros. */
    record(call: {
      model: string;
      effort: ModelChoice["effort"];
      batch: boolean;
      usage: TokenUsage;
      runId?: number | undefined;
    }): number {
      const table = settings().prices;
      const price = priceOf(call.model, table) ?? dearest(table);
      const costMicros = usdToMicros(usageCostUsd(call.usage, price, { batch: call.batch }));
      const now = clock();
      db.insert(analysisUsage)
        .values({
          at: new Date(now),
          month: monthOf(now),
          model: call.model,
          effort: call.effort,
          batch: call.batch,
          inputTokens: call.usage.inputTokens,
          outputTokens: call.usage.outputTokens,
          thinkingTokens: call.usage.thinkingTokens ?? 0,
          cacheReadTokens: call.usage.cacheReadTokens,
          cacheWriteTokens: call.usage.cacheWriteTokens,
          costMicros,
          runId: call.runId ?? null,
        })
        .run();
      return costMicros;
    },

    /**
     * Counts a reservation whose real cost can never be read back as spent (a realtime call that may
     * have been billed, a batch whose results cannot be read or priced): this can only make the cap
     * stricter.
     */
    recordUnconfirmed(micros: number): void {
      const now = clock();
      db.insert(analysisUsage)
        .values({
          at: new Date(now),
          month: monthOf(now),
          model: "unconfirmed batch",
          effort: null,
          batch: true,
          inputTokens: 0,
          outputTokens: 0,
          thinkingTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costMicros: micros,
          runId: null,
        })
        .run();
    },

    /** Release after recording its cost: the release announces any cap-state change. */
    reserve(micros: number): { release(): void } | undefined {
      if (headroomMicros() < micros) return undefined;
      realtimeReserved += micros;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          realtimeReserved -= micros;
          sync();
        },
      };
    },
  };
}
