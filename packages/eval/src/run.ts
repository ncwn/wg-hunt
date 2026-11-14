import { type AnalysisProvider, analysisVersion, type ModelChoice } from "@wg-hunt/core";
import { wgGesuchtSource } from "@wg-hunt/core/sources/wg-gesucht";
import type { OfferCase, PairCase } from "./cases.js";
import type { Price } from "./cost.js";
import { runDedupe } from "./dedupe-run.js";
import { runExtraction } from "./extraction.js";
import { replayProvider } from "./replay.js";
import { buildRun, type RunResult } from "./report.js";

type PassSettings = {
  model: ModelChoice;
  escalation: ModelChoice | null;
  prices: readonly Price[];
  onUnexpected: (caseId: string, error: unknown) => void;
};

export type RunPlan =
  | ({ mode: "live"; provider: AnalysisProvider; concurrency: number } & PassSettings)
  | ({ mode: "replay" } & PassSettings)
  | { mode: "rules-only" };

type EvaluateArgs = {
  offers: readonly OfferCase[];
  pairs: readonly PairCase[];
  sets: string[];
  plan: RunPlan;
};

export async function evaluate(args: EvaluateArgs): Promise<RunResult> {
  const { plan } = args;
  const base = {
    rulesVersion: wgGesuchtSource.rulesVersion,
    sets: args.sets,
    at: new Date().toISOString(),
  };
  const dedupe = runDedupe(args.pairs);

  if (plan.mode === "rules-only") {
    const extraction = await runExtraction({ cases: args.offers, modelPass: null });
    return buildRun({ settings: { ...base, mode: plan.mode }, extraction, dedupe, prices: [] });
  }

  const extraction = await runExtraction({
    cases: args.offers,
    modelPass: {
      model: plan.model,
      escalation: plan.escalation,
      providerFor:
        plan.mode === "live"
          ? () => plan.provider
          : (offer) => (offer.replay ? replayProvider(offer.replay) : undefined),
      onUnexpected: plan.onUnexpected,
    },
    ...(plan.mode === "live" ? { concurrency: plan.concurrency } : {}),
  });
  return buildRun({
    settings: {
      ...base,
      mode: plan.mode,
      analysisVersion: analysisVersion(plan.model),
      model: plan.model.model,
      effort: plan.model.effort,
      escalation: plan.escalation,
    },
    extraction,
    dedupe,
    prices: plan.prices,
  });
}
