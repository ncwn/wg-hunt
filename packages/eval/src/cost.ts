import { type ModelPrice, type TokenUsage, usageCostUsd } from "@wg-hunt/core";

export type Price = ModelPrice & { model: string };

// Priced with core's `DEFAULT_PRICES`, so an evaluation costs what production would.

export type Cost = {
  /** Dollars, or null when a model that was called has no price. */
  usd: number | null;
  unpriced: string[];
};

export function costOf(
  calls: readonly { model: string; usage: TokenUsage }[],
  prices: readonly Price[],
): Cost {
  let usd = 0;
  const unpriced = new Set<string>();
  for (const { model, usage } of calls) {
    const price = prices.find((candidate) => candidate.model === model);
    if (price === undefined) {
      unpriced.add(model);
      continue;
    }
    usd += usageCostUsd(usage, price);
  }
  return { usd: unpriced.size > 0 ? null : usd, unpriced: [...unpriced] };
}
