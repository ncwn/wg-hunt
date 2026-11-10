import { z } from "zod";
import { CATEGORIES, RENT_TYPES } from "../searches.js";

export const categorySchema = z.enum(CATEGORIES);

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const isoMonth = z.string().regex(/^\d{4}-\d{2}$/);

export const genderSchema = z.enum(["woman", "man", "diverse"]);
export type Gender = z.infer<typeof genderSchema>;

export const genderSoughtValue = z.union([z.literal("any"), z.array(genderSchema).min(1)]);

export const ageRangeValue = z.object({
  min: z.number().int().optional(),
  max: z.number().int().optional(),
});
export type AgeRange = z.infer<typeof ageRangeValue>;

export const flatmatesValue = z.object({
  women: z.number().int().nonnegative(),
  men: z.number().int().nonnegative(),
  diverse: z.number().int().nonnegative(),
  unspecified: z.number().int().nonnegative(),
});
export type Flatmates = z.infer<typeof flatmatesValue>;

/** Euros per month. `converted` marks a per-night or per-day price that was multiplied by 30. */
export const moneyValue = z.object({
  amount: z.number().nonnegative(),
  converted: z.boolean(),
});
export type Money = z.infer<typeof moneyValue>;

export const rentTypeValue = z.enum(RENT_TYPES);

export const coordinatesValue = z.object({ lat: z.number(), lng: z.number() });

export const smokingValue = z.enum(["not_wanted", "anywhere", "own_room", "balcony"]);

export const furnishedValue = z.enum(["furnished", "partly_furnished", "unfurnished"]);

/** In the Source's own order (index = its id). Descriptions, not Requirements. */
export const FLATSHARE_TYPES = [
  "purpose_wg",
  "students",
  "women_only",
  "men_only",
  "business",
  "dormitory",
  "working_professionals",
  "trainees",
  "seniors",
  "with_children",
  "fraternity",
  "not_purpose_wg",
  "mixed_gender",
  "plus",
  "multigenerational",
  "vegetarian_vegan",
  "lgbtqia",
  "living_for_help",
  "single_parents",
  "internationals_welcome",
  "inclusive",
  "functional",
  "new_flatshare",
  "no_gender_given",
] as const;
export const flatshareTypeValue = z.enum(FLATSHARE_TYPES);
export type FlatshareType = z.infer<typeof flatshareTypeValue>;

const AMENITIES = [
  "washing_machine",
  "dishwasher",
  "balcony",
  "terrace",
  "garden",
  "shared_garden",
  "cellar",
  "bike_cellar",
  "elevator",
] as const;
export const amenityValue = z.enum(AMENITIES);
export type Amenity = z.infer<typeof amenityValue>;

const DOCUMENTS = [
  "applicant_portfolio",
  "id_copy",
  "proof_of_income",
  "self_disclosure",
  "rent_payment_confirmation",
  "guarantee",
  "parental_guarantee",
  "enrolment_certificate",
  "credit_check",
] as const;
export const documentValue = z.enum(DOCUMENTS);
export type RequiredDocument = z.infer<typeof documentValue>;

export const energyCertificateValue = z.object({
  type: z.enum(["consumption", "demand"]).optional(),
  energyValue: z.string().optional(),
  energySource: z.string().optional(),
  buildYear: z.number().int().optional(),
  efficiencyClass: z.string().optional(),
});

export const anmeldungValue = z.enum(["possible", "not_possible", "conditional"]);

export const REQUIREMENT_KINDS = [
  "diet",
  "religion",
  "smoking",
  "pets",
  "occupation",
  "language",
  "other",
] as const;
export const strictnessSchema = z.enum(["required", "preferred"]);

export const requirementValue = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("diet"),
    strictness: strictnessSchema,
    value: z.enum(["vegan", "vegetarian"]),
  }),
  z.object({
    kind: z.literal("occupation"),
    strictness: strictnessSchema,
    value: z.enum(["student", "working", "trainee"]),
  }),
  z.object({
    kind: z.literal("smoking"),
    strictness: strictnessSchema,
    value: z.literal("non_smoker"),
  }),
  z.object({ kind: z.literal("pets"), strictness: strictnessSchema, value: z.literal("no_pets") }),
  /** An ISO 639-1 code. */
  z.object({ kind: z.literal("language"), strictness: strictnessSchema, value: z.string() }),
  z.object({ kind: z.literal("religion"), strictness: strictnessSchema, value: z.string() }),
  z.object({ kind: z.literal("other"), strictness: strictnessSchema, value: z.string() }),
]);
export type Requirement = z.infer<typeof requirementValue>;

export const SCAM_SIGNAL_KINDS = [
  "money_before_viewing",
  "keys_by_post",
  "cannot_show_in_person",
  "deposit_over_three_months",
  "off_platform_contact",
  "id_copy_upfront",
] as const;
export const scamSignalKind = z.enum(SCAM_SIGNAL_KINDS);
