import { z } from "zod";

/** The only value a fact has when the Offer does not say. It never means 0, false or none. */
export const UNKNOWN = "unknown" as const;

export const originSchema = z.enum(["field", "text", "manual"]);
type Origin = z.infer<typeof originSchema>;

export const DOUBTFUL_REASONS = [
  "quote_not_found",
  /** The value contradicts a structured field that the model did not report as a conflict. */
  "contradicts_field",
  /** The model said unknown, but a keyword tripwire fired in the text. */
  "keyword_tripwire",
  "model_ambiguous",
  "tiers_disagree",
] as const;
const doubtfulReasonSchema = z.enum(DOUBTFUL_REASONS);
export type DoubtfulReason = z.infer<typeof doubtfulReasonSchema>;

/** Only model facts carry one. */
const confidenceSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("confident") }),
  z.object({ status: z.literal("doubtful"), reasons: z.array(doubtfulReasonSchema).min(1) }),
]);
export type Confidence = z.infer<typeof confidenceSchema>;

/**
 * - `quote` is an exact substring of the Offer's original text, or for a structured field the field
 *   label plus its value. Every fact that is not `unknown` has one, an absence (`false`, `none`, an
 *   empty list) included: it quotes the section that shows the absence. Only a seeker's `manual`
 *   correction may go without.
 * - `alternatives` holds the losing value, its origin and quote when a field and the text disagree,
 *   or the reading a correction replaced.
 */
export function factOf<V extends z.ZodType>(value: V) {
  return z
    .object({
      value: z.union([value, z.literal(UNKNOWN)]),
      origin: originSchema,
      quote: z.string(),
      alternatives: z
        .array(z.object({ value, origin: originSchema, quote: z.string() }))
        .optional(),
      confidence: confidenceSchema.optional(),
    })
    .superRefine((parsed, ctx) => {
      // The generic value type is too deep for TypeScript to see through, so read it loosely.
      const fact = parsed as { origin: Origin; quote: string; value: unknown };
      if (fact.origin !== "manual" && fact.quote === "" && fact.value !== UNKNOWN) {
        ctx.addIssue({ code: "custom", path: ["quote"], message: "a stated value needs a quote" });
      }
    });
}

export type Fact<V> = {
  value: V | typeof UNKNOWN;
  origin: Origin;
  quote: string;
  alternatives?: { value: V; origin: Origin; quote: string }[];
  confidence?: Confidence;
};
