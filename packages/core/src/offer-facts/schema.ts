import { z } from "zod";
import type { Category } from "../searches.js";
import { factOf } from "./fact.js";
import {
  ageRangeValue,
  amenityValue,
  anmeldungValue,
  categorySchema,
  coordinatesValue,
  documentValue,
  energyCertificateValue,
  flatmatesValue,
  flatshareTypeValue,
  furnishedValue,
  genderSoughtValue,
  isoDate,
  isoMonth,
  moneyValue,
  rentTypeValue,
  requirementValue,
  scamSignalKind,
  smokingValue,
} from "./values.js";

const int = z.number().int().nonnegative();
const text = z.string().min(1);
const textList = z.array(text);

export const ruleFactShape = {
  flatmates: factOf(flatmatesValue),
  flatshareSize: factOf(int),
  flatmateAges: factOf(ageRangeValue),
  /** WG-Details merged with the model's reading of the text. Filters read this fact and nothing else. */
  genderSought: factOf(genderSoughtValue),
  ageSought: factOf(ageRangeValue),
  flatshareTypes: factOf(z.array(flatshareTypeValue)),
  languages: factOf(textList),
  smoking: factOf(smokingValue),
  petsPresent: factOf(z.boolean()),

  /** The room for a flatshare; the whole home (Größe) for a 1-room flat, flat or house. */
  roomSize: factOf(z.number().positive()),
  flatSize: factOf(z.number().positive()),
  rooms: factOf(z.number().positive()),

  baseRent: factOf(moneyValue),
  utilities: factOf(moneyValue),
  otherCosts: factOf(moneyValue),
  deposit: factOf(moneyValue),
  equipmentFee: factOf(moneyValue),
  warmRent: factOf(moneyValue),
  costsComplete: factOf(z.boolean()),
  rentPerSqm: factOf(z.number().nonnegative()),
  schufaRequested: factOf(z.boolean()),

  availableFrom: factOf(isoDate),
  availableUntil: factOf(z.union([isoDate, z.literal("none")])),
  rentType: factOf(rentTypeValue),

  // Local database only: never in logs, errors or fixtures.
  postalCode: factOf(z.string().regex(/^\d{5}$/)),
  district: factOf(text),
  street: factOf(text),
  coordinates: factOf(coordinatesValue),

  furnished: factOf(furnishedValue),
  floor: factOf(text),
  buildingType: factOf(text),
  kitchen: factOf(textList),
  bathroom: factOf(textList),
  internet: factOf(textList),
  tv: factOf(textList),
  flooring: factOf(textList),
  heating: factOf(textList),
  parking: factOf(textList),
  greenElectricity: factOf(z.boolean()),
  transitMinutes: factOf(int),
  amenities: factOf(z.array(amenityValue)),
  petsAllowed: factOf(z.boolean()),
  accessible: factOf(z.boolean()),
  /**
   * A flat or house offered as a WG. Only then do gender sought and Requirements from its text
   * apply to it.
   */
  offeredAsWg: factOf(z.boolean()),
  energyCertificate: factOf(energyCertificateValue),

  verified: factOf(z.boolean()),
  memberSince: factOf(isoMonth),
  companyProfile: factOf(text),
  phoneGiven: factOf(z.boolean()),
  requiredDocuments: factOf(z.array(documentValue)),

  photoCount: factOf(int),
  imageUrls: factOf(textList),
  /** `german` when the page showed the original, `other` when it showed a machine translation. */
  offerLanguage: factOf(z.enum(["german", "other"])),
};

export type RuleFactKey = keyof typeof ruleFactShape;

export const RULE_FACT_KEYS = Object.keys(ruleFactShape) as [RuleFactKey, ...RuleFactKey[]];
export const ruleFactKeySchema = z.enum(RULE_FACT_KEYS);

export const conflictValue = z.object({ factKey: ruleFactKeySchema, textValue: z.string() });

/**
 * Absent until the Offer is analysed. The model's gender sought is not here: it is merged into
 * `genderSought`.
 */
export const modelFactShape = {
  anmeldung: factOf(anmeldungValue),
  requirements: z.array(factOf(requirementValue)),
  minimumStay: factOf(z.number().int().positive()),
  scamSignals: z.array(factOf(scamSignalKind)),
  conflicts: z.array(factOf(conflictValue)),
};

export type ModelFactKey = keyof typeof modelFactShape;
export type FactKey = RuleFactKey | ModelFactKey;

const ALL: readonly Category[] = ["flatshare-room", "one-room-flat", "flat", "house"];
const FLATSHARE: readonly Category[] = ["flatshare-room"];
const HOMES: readonly Category[] = ["flat", "house"];

/**
 * A fact that does not apply is left out of the Offer, never `unknown`, so Filters on it neither
 * match nor penalize.
 */
const applicability: Record<FactKey, readonly Category[]> = {
  flatmates: FLATSHARE,
  flatshareSize: FLATSHARE,
  flatmateAges: FLATSHARE,
  genderSought: FLATSHARE,
  ageSought: FLATSHARE,
  flatshareTypes: FLATSHARE,
  languages: FLATSHARE,
  smoking: FLATSHARE,
  petsPresent: FLATSHARE,
  roomSize: ALL,
  flatSize: ALL,
  rooms: HOMES,
  baseRent: ALL,
  utilities: ALL,
  otherCosts: ALL,
  deposit: ALL,
  equipmentFee: ALL,
  warmRent: ALL,
  costsComplete: ALL,
  rentPerSqm: ALL,
  schufaRequested: ALL,
  availableFrom: ALL,
  availableUntil: ALL,
  rentType: ALL,
  postalCode: ALL,
  district: ALL,
  street: ALL,
  coordinates: ALL,
  furnished: ALL,
  floor: ALL,
  buildingType: ALL,
  kitchen: ALL,
  bathroom: ALL,
  internet: ALL,
  tv: ALL,
  flooring: ALL,
  heating: ALL,
  parking: ALL,
  greenElectricity: ALL,
  transitMinutes: ALL,
  amenities: ALL,
  petsAllowed: ALL,
  accessible: ALL,
  offeredAsWg: HOMES,
  energyCertificate: ALL,
  verified: ALL,
  memberSince: ALL,
  companyProfile: ALL,
  phoneGiven: ALL,
  requiredDocuments: ALL,
  photoCount: ALL,
  imageUrls: ALL,
  offerLanguage: ALL,
  anmeldung: ALL,
  requirements: FLATSHARE,
  minimumStay: ALL,
  scamSignals: ALL,
  conflicts: ALL,
};

/** A 1-room flat is never offered as a WG, so it gets neither. */
const OFFERED_AS_WG_ALSO: Partial<Record<FactKey, readonly Category[]>> = {
  genderSought: HOMES,
  requirements: HOMES,
};

export const MODEL_FACT_KEYS = Object.keys(modelFactShape) as ModelFactKey[];

export type ApplicabilityContext = {
  offeredAsWg?: boolean;
};

export function applicabilityContext(facts: {
  offeredAsWg?: { value: unknown } | undefined;
}): ApplicabilityContext {
  return { offeredAsWg: facts.offeredAsWg?.value === true };
}

export function isApplicable(
  key: string,
  category: Category,
  context: ApplicabilityContext = {},
): boolean {
  if ((applicability as Record<string, readonly Category[] | undefined>)[key]?.includes(category)) {
    return true;
  }
  const extra = (OFFERED_AS_WG_ALSO as Record<string, readonly Category[] | undefined>)[key];
  return context.offeredAsWg === true && (extra?.includes(category) ?? false);
}

export function applicableFactKeys(category: Category, context?: ApplicabilityContext): FactKey[] {
  return [...RULE_FACT_KEYS, ...MODEL_FACT_KEYS].filter((key) =>
    isApplicable(key, category, context),
  );
}

export function applicableRuleFactKeys(category: Category): RuleFactKey[] {
  return RULE_FACT_KEYS.filter((key) => isApplicable(key, category));
}

function optionalShape<S extends Record<string, z.ZodType>>(
  shape: S,
): { [K in keyof S]: z.ZodOptional<S[K]> } {
  return Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => [key, schema.optional()]),
  ) as { [K in keyof S]: z.ZodOptional<S[K]> };
}

export const ruleFactsSchema = z.object(optionalShape(ruleFactShape));
export type RuleFacts = z.infer<typeof ruleFactsSchema>;

export const offerFactsSchema = z
  .object({
    category: categorySchema,
    ...optionalShape(ruleFactShape),
    ...optionalShape(modelFactShape),
  })
  .superRefine((facts, ctx) => {
    const context = applicabilityContext(facts);
    for (const [key, fact] of Object.entries(facts)) {
      if (key === "category" || fact === undefined) continue;
      if (!isApplicable(key, facts.category, context)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${key} does not apply to category ${facts.category}`,
        });
      }
    }
  });
export type OfferFacts = z.infer<typeof offerFactsSchema>;
