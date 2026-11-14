import { type ModelChoice, usageCostUsd } from "@wg-hunt/core";
import type { AnalysisSettings } from "../analysis-settings.js";

/**
 * A typical Offer's usage for the "re-analyse for about $X" estimate: planning figures, not
 * measurements. The spend cap works from actual usage.
 */
const PREFIX_TOKENS = 3_000;
const OFFER_TOKENS = 2_000;
const ANSWER_TOKENS = 400;
/** Thinking tokens per Offer by effort; billed as output. */
const THINKING_TOKENS: Record<string, number> = {
  none: 0,
  low: 300,
  medium: 1_000,
  high: 3_000,
  xhigh: 6_000,
  max: 10_000,
};
const ESCALATION_SHARE = 0.2;

function offerCostUsd(choice: ModelChoice, prices: AnalysisSettings["prices"]): number {
  const price = prices.find((entry) => entry.model === choice.model);
  if (price === undefined) return 0;
  return usageCostUsd(
    {
      inputTokens: OFFER_TOKENS,
      cacheReadTokens: PREFIX_TOKENS,
      cacheWriteTokens: 0,
      outputTokens: ANSWER_TOKENS + (THINKING_TOKENS[choice.effort ?? "none"] ?? 0),
    },
    price,
    { batch: true },
  );
}

export function estimateReanalysisUsd(offers: number, settings: AnalysisSettings): number {
  const first = offerCostUsd({ model: settings.model, effort: settings.effort }, settings.prices);
  const second = settings.escalation
    ? ESCALATION_SHARE * offerCostUsd(settings.escalation, settings.prices)
    : 0;
  return offers * (first + second);
}
