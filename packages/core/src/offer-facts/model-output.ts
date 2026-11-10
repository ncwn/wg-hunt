import { z } from "zod";
import { ruleFactKeySchema } from "./schema.js";
import { genderSchema, REQUIREMENT_KINDS, SCAM_SIGNAL_KINDS, strictnessSchema } from "./values.js";

const evidence = {
  /** An exact substring of the Offer's original text, or "" when the value is unknown. */
  quote: z.string(),
  ambiguous: z.boolean(),
  /** "" when not ambiguous. */
  ambiguityReason: z.string(),
};

/**
 * Structured outputs allow at most 24 optional and 16 union-typed fields in a schema, so this one
 * has required fields only, with an `unknown` enum value instead of a nullable, and an empty string
 * or array where a field has nothing to say.
 */
export const modelFactsOutputSchema = z.object({
  anmeldung: z.object({
    value: z.enum(["possible", "not_possible", "conditional", "unknown"]),
    ...evidence,
  }),
  requirements: z.array(
    z.object({
      kind: z.enum(REQUIREMENT_KINDS),
      strictness: strictnessSchema,
      /** Normalized per kind: vegan, student, non_smoker, no_pets, an ISO code; otherwise free text. */
      value: z.string(),
      ...evidence,
    }),
  ),
  minimumStay: z.object({
    value: z.enum(["stated", "unknown"]),
    /** Months; 0 when unknown. */
    months: z.number().int(),
    ...evidence,
  }),
  genderSoughtFromText: z.object({
    value: z.enum(["any", "only", "unknown"]),
    /** The genders sought when `value` is "only", else empty. */
    only: z.array(genderSchema),
    ...evidence,
  }),
  scamSignals: z.array(z.object({ kind: z.enum(SCAM_SIGNAL_KINDS), ...evidence })),
  conflicts: z.array(
    z.object({
      factKey: ruleFactKeySchema,
      textValue: z.string(),
      ...evidence,
    }),
  ),
});
export type ModelFactsOutput = z.infer<typeof modelFactsOutputSchema>;

type JsonNode = Record<string, unknown>;

/** Counts the optional and union-typed fields the way the structured-output limits do. */
export function structuredOutputUsage(schema: z.ZodType): { optional: number; unions: number } {
  const usage = { optional: 0, unions: 0 };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const object = node as JsonNode;
    const properties = object.properties;
    if (typeof properties === "object" && properties !== null) {
      const required = Array.isArray(object.required) ? object.required.length : 0;
      usage.optional += Object.keys(properties).length - required;
    }
    if (Array.isArray(object.anyOf) || Array.isArray(object.oneOf) || Array.isArray(object.type)) {
      usage.unions += 1;
    }
    for (const child of Object.values(object)) visit(child);
  };
  visit(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }));
  return usage;
}
