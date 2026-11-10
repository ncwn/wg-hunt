import type { AnalysisLogEntry, AnalysisResult, EscalationState, ModelChoice } from "@wg-hunt/core";
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

/** What the `offers.analysis` column holds. */
export type StoredAnalysis = {
  run?: AnalysisRun;
  failure?: AnalysisFailure;
  escalation?: OwedEscalation;
};

export function parseStoredAnalysis(json: string | null): StoredAnalysis {
  if (json === null) return {};
  try {
    return JSON.parse(json) as StoredAnalysis;
  } catch {
    return {};
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
