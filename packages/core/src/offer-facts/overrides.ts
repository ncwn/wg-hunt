import type { z } from "zod";
import type { Category } from "../searches.js";
import { deriveFacts } from "./derived.js";
import { type Fact, UNKNOWN } from "./fact.js";
import {
  applicabilityContext,
  isApplicable,
  MODEL_FACT_KEYS,
  modelFactShape,
  RULE_FACT_KEYS,
  ruleFactShape,
} from "./schema.js";

/**
 * An override lives apart from the rules and the model so a re-parse of the page or a new analysis
 * never loses it. Its value is the fact's `value` as stored (a list fact takes its items' values),
 * the shape the evaluation set's labels use, so an override exports as a label unchanged.
 */

/**
 * Not corrected by hand: the photo list (shown above the table, not a reading of the text) and the
 * model's field/text conflicts (a note about two sources, not a fact about the Offer).
 */
const NOT_OVERRIDABLE: readonly string[] = ["conflicts", "imageUrls"];

const FACT_KEYS: readonly string[] = [...RULE_FACT_KEYS, ...MODEL_FACT_KEYS];

const LIST_KEYS: readonly string[] = ["requirements", "scamSignals", "conflicts"];

export function isOverridable(key: string): boolean {
  return FACT_KEYS.includes(key) && !NOT_OVERRIDABLE.includes(key);
}

export const isListFact = (key: string): boolean => LIST_KEYS.includes(key);

const shapes = { ...ruleFactShape, ...modelFactShape } as unknown as Record<string, z.ZodType>;

const manual = (value: unknown) => ({ value, origin: "manual", quote: "" });

export type OverrideCheck = { ok: true; value: unknown } | { ok: false; message: string };

const messageOf = (error: z.ZodError) =>
  error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ` : "") + issue.message)
    .join("; ");

/** `unknown` is a value like any other: it says the Offer does not say. */
export function checkOverride(key: string, value: unknown): OverrideCheck {
  if (!isOverridable(key)) return { ok: false, message: `${key} is not a fact you can correct` };
  const schema = shapes[key];
  if (schema === undefined) return { ok: false, message: `${key} is not an Offer Fact` };
  if (isListFact(key)) {
    if (!Array.isArray(value)) {
      return { ok: false, message: `${key} takes a list of values` };
    }
    const parsed = schema.safeParse(value.map(manual));
    return parsed.success ? { ok: true, value } : { ok: false, message: messageOf(parsed.error) };
  }
  const parsed = schema.safeParse(manual(value));
  return parsed.success
    ? { ok: true, value: (parsed.data as { value: unknown }).value }
    : { ok: false, message: messageOf(parsed.error) };
}

export type FactOverride = { key: string; value: unknown };

/**
 * The replaced reading stays as an alternative so the seeker can see what it said. An override of
 * a fact that does not apply to the category is skipped, never an error: the page may have changed
 * under it.
 */
export function overrideFacts<F extends { category: Category }>(
  facts: F,
  overrides: readonly FactOverride[],
): F {
  const usable = overrides.filter(({ key }) => isOverridable(key));
  if (usable.length === 0) return facts;
  const result: Record<string, unknown> = { ...facts };
  const corrected = new Set<string>();

  const put = ({ key, value }: FactOverride) => {
    corrected.add(key);
    if (isListFact(key)) {
      result[key] = Array.isArray(value) ? value.map(manual) : [];
      return;
    }
    const replaced = result[key] as Fact<unknown> | undefined;
    result[key] = {
      ...manual(value),
      ...(replaced !== undefined && replaced.value !== UNKNOWN && replaced.origin !== "manual"
        ? {
            alternatives: [
              { value: replaced.value, origin: replaced.origin, quote: replaced.quote },
            ],
          }
        : {}),
    };
  };

  // Whether a fact applies can depend on `offeredAsWg`, so its override is laid down first.
  const first = usable.filter(({ key }) => key === "offeredAsWg");
  if (first.length > 0) {
    const wg = first.at(-1);
    if (wg !== undefined && isApplicable("offeredAsWg", facts.category)) put(wg);
  }
  const context = applicabilityContext(result);
  for (const override of usable) {
    if (override.key === "offeredAsWg") continue;
    if (isApplicable(override.key, facts.category, context)) put(override);
  }
  return deriveFacts(result as F, corrected);
}
