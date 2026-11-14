import type {
  AnalysisLogEntry,
  AnalysisResult,
  EscalationState,
  ModelChoice,
  ModelFacts,
} from "@wg-hunt/core";
import { z } from "zod";
import type { OfferRow } from "../db/schema.js";
import { analysisVersion } from "./version.js";

export type AnalysisRun = {
  model: string;
  effort: ModelChoice["effort"];
  /** `null` when escalation was off. */
  escalation: ModelChoice | null;
  /** The whole Offer was read again at the escalation setting. */
  escalated: boolean;
  analyzedAt: string;
  contentHash: string | null;
  /** Holds Offer text: kept in the database, never printed. */
  log: AnalysisLogEntry[];
  /** Missing on results stored before versions existed. */
  analysisVersion?: string;
};

export type AnalysisFailure = {
  kind: string;
  at: string;
  /** Failed attempts in a row for the same words. */
  attempts?: number;
  contentHash?: string | null;
};

/** Kept so a lost escalation is resent without paying for the first pass twice. */
export type OwedEscalation = {
  carry: EscalationState;
  plan: AnalysisPlan;
  contentHash: string;
  /** Since it was lost; `resentAt` is epoch ms. */
  resends?: number;
  resentAt?: number;
};

export type OfferAnalysis =
  | { state: "pending" }
  | { state: "failed"; failure: AnalysisFailure }
  | {
      state: "analyzed";
      /** Null on a row stored without them, which still counts as read. */
      facts: ModelFacts | null;
      run: AnalysisRun;
      escalation: OwedEscalation | null;
      failure: AnalysisFailure | null;
    };

type Columns = Pick<OfferRow, "analysisState" | "modelFacts" | "analysis">;

/** What the `offers.analysis` column holds. */
type StoredAnalysis = {
  run?: AnalysisRun;
  failure?: AnalysisFailure;
  escalation?: OwedEscalation;
};

// Only what callers branch on is checked. A value that passes is used as stored, not as zod
// returns it: zod reorders and drops keys, and a writer must store an unchanged part byte for byte.
const storedShape = z.object({
  run: z
    .object({
      model: z.string().optional(),
      contentHash: z.string().nullable(),
      analysisVersion: z.string().optional(),
    })
    .optional(),
  failure: z
    .object({
      kind: z.string(),
      at: z.string(),
      attempts: z.number().optional(),
      contentHash: z.string().nullable().optional(),
    })
    .optional(),
  escalation: z
    .object({
      carry: z.object({}),
      plan: z.object({ model: z.object({}) }),
      contentHash: z.string(),
      resends: z.number().optional(),
      resentAt: z.number().optional(),
    })
    .optional(),
});
const factsShape = z.object({ conflicts: z.array(z.unknown()) }).nullable();

/**
 * A row that fits no shape reads as pending, so the Offer is read again rather than kept out of the
 * queue or shown with facts for words that were not read.
 */
export function readAnalysis(row: Columns): OfferAnalysis {
  let facts: unknown;
  let stored: unknown;
  try {
    facts = row.modelFacts === null ? null : JSON.parse(row.modelFacts);
    stored = row.analysis === null ? {} : JSON.parse(row.analysis);
  } catch {
    return { state: "pending" };
  }
  if (!factsShape.safeParse(facts).success || !storedShape.safeParse(stored).success) {
    return { state: "pending" };
  }
  const { run, failure, escalation } = stored as StoredAnalysis;
  if (row.analysisState === "analyzed" && run !== undefined) {
    return {
      state: "analyzed",
      facts: facts as ModelFacts | null,
      run,
      escalation: escalation ?? null,
      failure: failure ?? null,
    };
  }
  if (row.analysisState === "failed" && failure !== undefined) return { state: "failed", failure };
  return { state: "pending" };
}

export function analysisColumns(value: OfferAnalysis): Columns {
  switch (value.state) {
    case "pending":
      return { analysisState: "pending", modelFacts: null, analysis: null };
    case "failed":
      return {
        analysisState: "failed",
        modelFacts: null,
        analysis: JSON.stringify({ failure: value.failure }),
      };
    case "analyzed": {
      const { facts, run, escalation, failure } = value;
      return {
        analysisState: "analyzed",
        modelFacts: facts === null ? null : JSON.stringify(facts),
        analysis: JSON.stringify({
          run,
          ...(escalation && { escalation }),
          ...(failure && { failure }),
        }),
      };
    }
  }
}

export type AnalysisPlan = { model: ModelChoice; escalation: ModelChoice | null };

export function makeRun(args: {
  plan: AnalysisPlan;
  result: Pick<AnalysisResult, "escalated" | "log">;
  analyzedAt: string;
  contentHash: string;
}): AnalysisRun {
  const { plan, result } = args;
  return {
    model: plan.model.model,
    effort: plan.model.effort,
    escalation: plan.escalation,
    escalated: result.escalated,
    analyzedAt: args.analyzedAt,
    contentHash: args.contentHash,
    log: result.log,
    analysisVersion: analysisVersion(plan.model),
  };
}
