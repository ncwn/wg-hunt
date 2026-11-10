import type { components } from "../api/schema.js";

export type AnalysisSettings = components["schemas"]["AnalysisSettings"];
export type Effort = NonNullable<AnalysisSettings["effort"]>;

export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Amounts stay text while typed, so a half-typed "0." is not lost; they become numbers when saving.
 */
export type AnalysisForm = {
  model: string;
  effort: Effort | null;
  escalationOn: boolean;
  escalationModel: string;
  escalationEffort: Effort | null;
  batchOnly: boolean;
  cap: string;
  prices: {
    model: string;
    input: string;
    output: string;
    efforts: Effort[];
    /** A model's long-prompt rate is kept as the server has it; the form does not edit it. */
    longPrompt?: AnalysisSettings["prices"][number]["longPrompt"];
  }[];
};

const MODEL_ID = /^[a-z0-9][a-z0-9._:-]{0,99}$/;
const AMOUNT = /^\d+(\.\d+)?$/;

export const isModelId = (text: string) => MODEL_ID.test(text);
export const isAmount = (text: string) => AMOUNT.test(text.trim());

export function effortsOf(prices: AnalysisForm["prices"], model: string): readonly Effort[] {
  return prices.find((price) => price.model === model)?.efforts ?? [];
}

export function effortFor(
  efforts: readonly Effort[],
  wanted: Effort | null,
  fallback: Effort = "medium",
): Effort | null {
  if (efforts.length === 0) return null;
  if (wanted && efforts.includes(wanted)) return wanted;
  if (efforts.includes(fallback)) return fallback;
  return efforts[0] ?? null;
}

export function toForm(settings: AnalysisSettings): AnalysisForm {
  const prices = settings.prices.map((price) => ({
    model: price.model,
    input: String(price.inputUsdPerMTok),
    output: String(price.outputUsdPerMTok),
    efforts: price.efforts,
    ...(price.longPrompt && { longPrompt: price.longPrompt }),
  }));
  const escalationModel = settings.escalation?.model ?? settings.model;
  return {
    model: settings.model,
    effort: settings.effort,
    escalationOn: settings.escalation !== null,
    escalationModel,
    escalationEffort:
      settings.escalation?.effort ?? effortFor(effortsOf(prices, escalationModel), "high"),
    batchOnly: settings.batchOnly,
    cap: String(settings.monthlySpendCapUsd),
    prices,
  };
}

export function toSettings(
  form: AnalysisForm,
): { settings: AnalysisSettings } | { problem: string } {
  if (!isAmount(form.cap)) {
    return { problem: "The monthly spend cap must be an amount in USD, such as 5 or 12.50." };
  }
  const prices: AnalysisSettings["prices"] = [];
  for (const price of form.prices) {
    if (!isAmount(price.input) || !isAmount(price.output)) {
      return { problem: `The prices of ${price.model} must be amounts in USD, such as 0.10.` };
    }
    prices.push({
      model: price.model,
      inputUsdPerMTok: Number(price.input),
      outputUsdPerMTok: Number(price.output),
      efforts: price.efforts,
      ...(price.longPrompt && { longPrompt: price.longPrompt }),
    });
  }
  return {
    settings: {
      model: form.model,
      effort: form.effort,
      escalation: form.escalationOn
        ? { model: form.escalationModel, effort: form.escalationEffort }
        : null,
      batchOnly: form.batchOnly,
      monthlySpendCapUsd: Number(form.cap),
      prices,
    },
  };
}
