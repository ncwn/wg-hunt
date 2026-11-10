import type { TokenUsage } from "./provider.js";

/** What Anthropic charges for tokens, relative to the base input rate. */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;
/** The Batch API bills every token type at this share of the standard rate. */
const BATCH_MULTIPLIER = 0.5;

/** USD per million tokens at the standard rate. */
export type ModelPrice = {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /**
   * A model that costs more for long prompts (Claude Haiku 5.5 above 100,000 input tokens). The
   * threshold counts every input token of the request, cache reads and writes included, and the
   * whole request, output too, is then billed at these rates.
   */
  longPrompt?: { aboveTokens: number; inputUsdPerMTok: number; outputUsdPerMTok: number } | null;
};

export function usageCostUsd(
  usage: TokenUsage,
  price: ModelPrice,
  options: { batch?: boolean } = {},
): number {
  const inputTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const long = price.longPrompt;
  const rates =
    long && inputTokens > long.aboveTokens
      ? { input: long.inputUsdPerMTok, output: long.outputUsdPerMTok }
      : { input: price.inputUsdPerMTok, output: price.outputUsdPerMTok };
  const usd =
    (usage.inputTokens * rates.input +
      usage.cacheWriteTokens * rates.input * CACHE_WRITE_MULTIPLIER +
      usage.cacheReadTokens * rates.input * CACHE_READ_MULTIPLIER +
      usage.outputTokens * rates.output) /
    1_000_000;
  return options.batch ? usd * BATCH_MULTIPLIER : usd;
}
