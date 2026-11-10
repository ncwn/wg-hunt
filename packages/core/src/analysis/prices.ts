import type { ModelPrice } from "./cost.js";
import { EFFORTS, type Effort } from "./provider.js";

/** `efforts` is empty for a model without the effort parameter. */
export type PricedModel = ModelPrice & { model: string; efforts: Effort[] };

const ALL: Effort[] = [...EFFORTS];

/**
 * Anthropic's published standard-API prices per million tokens (2026-10). Haiku 5.5 costs five
 * times as much for a request whose input is over 100K tokens; an Offer never gets there, but the
 * table knows it so the spend cap would count it.
 */
export const DEFAULT_PRICES: readonly PricedModel[] = [
  {
    model: "claude-haiku-5-5",
    inputUsdPerMTok: 0.1,
    outputUsdPerMTok: 0.5,
    efforts: ALL,
    longPrompt: { aboveTokens: 100_000, inputUsdPerMTok: 0.5, outputUsdPerMTok: 2.5 },
  },
  { model: "claude-haiku-4-5", inputUsdPerMTok: 1, outputUsdPerMTok: 5, efforts: [] },
  { model: "claude-sonnet-5-5", inputUsdPerMTok: 2, outputUsdPerMTok: 10, efforts: ALL },
  { model: "claude-sonnet-5", inputUsdPerMTok: 2, outputUsdPerMTok: 10, efforts: ALL },
  {
    model: "claude-sonnet-4-6",
    inputUsdPerMTok: 3,
    outputUsdPerMTok: 15,
    efforts: ["low", "medium", "high", "max"],
  },
  { model: "claude-opus-5-5", inputUsdPerMTok: 4, outputUsdPerMTok: 20, efforts: ALL },
  { model: "claude-opus-5", inputUsdPerMTok: 5, outputUsdPerMTok: 25, efforts: ALL },
  { model: "claude-opus-4-8", inputUsdPerMTok: 5, outputUsdPerMTok: 25, efforts: ALL },
  { model: "claude-fable-5-1", inputUsdPerMTok: 10, outputUsdPerMTok: 50, efforts: ALL },
];
