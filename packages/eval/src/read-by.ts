import { MODEL_FACT_KEYS, type RuleFactKey } from "@wg-hunt/core";

/**
 * The rule facts the model also has a say in: gender sought is the structured field merged with
 * the model's reading of the text (core's `combineOfferFacts`).
 */
const MERGED_WITH_MODEL: readonly RuleFactKey[] = ["genderSought"];

export function readBy(key: string): "rules" | "model" | "rules+model" {
  if ((MODEL_FACT_KEYS as readonly string[]).includes(key)) return "model";
  return (MERGED_WITH_MODEL as readonly string[]).includes(key) ? "rules+model" : "rules";
}
