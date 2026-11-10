import type { components } from "./api/schema.js";
import { RENT_TYPES } from "./searches.js";

type Gender = NonNullable<components["schemas"]["SeekerProfile"]["gender"]>;
type Furnished = components["schemas"]["Filters"]["furnished"]["accept"][number];

/** The server has the last word on what a value may be. */
export type FactEditor =
  | { kind: "choice"; options: { value: unknown; label: string }[] }
  | { kind: "checklist"; options: { value: string; label: string }[] }
  | { kind: "number"; integer?: boolean; unit?: string }
  | { kind: "money" }
  | { kind: "text" }
  | { kind: "date"; orNone?: boolean }
  | { kind: "month" }
  | { kind: "range" }
  | { kind: "requirements"; kinds: RequirementKind[]; strictness: StrictnessOption[] }
  | { kind: "json" };

type RequirementValueField =
  | { kind: "choice"; label: string; options: { value: string; label: string }[] }
  | { kind: "implied"; value: string }
  /** A two-letter ISO 639-1 code. */
  | { kind: "language" }
  /** May not be empty. */
  | { kind: "text" };

export type RequirementKind = { kind: string; label: string; value: RequirementValueField };
export type StrictnessOption = { value: "required" | "preferred"; label: string };

const yesNo: FactEditor = {
  kind: "choice",
  options: [
    { value: true, label: "yes" },
    { value: false, label: "no" },
  ],
};

const choice = (...values: readonly string[]): FactEditor => ({
  kind: "choice",
  options: values.map((value) => ({ value, label: value.replaceAll("_", " ") })),
});

// Typed as records so that a value added to the API fails to compile here.
const FURNISHED: Record<Furnished, true> = {
  furnished: true,
  partly_furnished: true,
  unfurnished: true,
};
const GENDER_GROUPS: Record<Gender, string> = {
  woman: "women",
  man: "men",
  diverse: "diverse people",
};

const GENDERS: { value: "any" | Gender[]; label: string }[] = [
  { value: "any", label: "any gender" },
  ...(Object.entries(GENDER_GROUPS) as [Gender, string][]).map(([gender, label]) => ({
    value: [gender],
    label,
  })),
  { value: ["woman", "diverse"], label: "women and diverse people" },
  { value: ["man", "diverse"], label: "men and diverse people" },
  { value: ["woman", "man"], label: "women and men" },
];

/**
 * A copy of core's `SCAM_SIGNAL_KINDS`, in its order, since the dashboard doesn't import core; a
 * test checks they match. Derived signals are not in the fact.
 */
const TEXT_SCAM_SIGNALS: { value: string; label: string }[] = [
  { value: "money_before_viewing", label: "Money asked before a viewing" },
  { value: "keys_by_post", label: "Keys sent by post" },
  { value: "cannot_show_in_person", label: "Can't show the place in person" },
  { value: "deposit_over_three_months", label: "Deposit over three months' rent" },
  { value: "off_platform_contact", label: "Contact moved off the platform" },
  { value: "id_copy_upfront", label: "ID copy asked for before a viewing" },
];

/**
 * A copy of core's `REQUIREMENT_KINDS` and the values `requirementValue` allows, since the
 * dashboard doesn't import core; a test checks they match.
 */
const REQUIREMENT_KINDS: RequirementKind[] = [
  {
    kind: "diet",
    label: "Diet",
    value: {
      kind: "choice",
      label: "Diet",
      options: [
        { value: "vegan", label: "Vegan" },
        { value: "vegetarian", label: "Vegetarian" },
      ],
    },
  },
  { kind: "religion", label: "Religion", value: { kind: "text" } },
  { kind: "smoking", label: "Non-smokers", value: { kind: "implied", value: "non_smoker" } },
  { kind: "pets", label: "No pets", value: { kind: "implied", value: "no_pets" } },
  {
    kind: "occupation",
    label: "Occupation",
    value: {
      kind: "choice",
      label: "Occupation",
      options: [
        { value: "student", label: "Students" },
        { value: "working", label: "Working people" },
        { value: "trainee", label: "Trainees" },
      ],
    },
  },
  { kind: "language", label: "Language", value: { kind: "language" } },
  { kind: "other", label: "Other", value: { kind: "text" } },
];

/** Copies of core's values, since the dashboard doesn't import core; a test checks they match. */
export const ANMELDUNG = ["possible", "not_possible", "conditional"] as const;
export const SMOKING = ["not_wanted", "anywhere", "own_room", "balcony"] as const;
export const OFFER_LANGUAGES = ["german", "other"] as const;

/** In core's `strictnessSchema` order. */
const STRICTNESS: StrictnessOption[] = [
  { value: "required", label: "Must meet" },
  { value: "preferred", label: "Should meet" },
];

const EDITORS: Record<string, FactEditor> = {
  anmeldung: choice(...ANMELDUNG),
  smoking: choice(...SMOKING),
  furnished: choice(...Object.keys(FURNISHED)),
  rentType: choice(...RENT_TYPES),
  offerLanguage: choice(...OFFER_LANGUAGES),
  genderSought: { kind: "choice", options: GENDERS },
  petsPresent: yesNo,
  petsAllowed: yesNo,
  greenElectricity: yesNo,
  accessible: yesNo,
  offeredAsWg: yesNo,
  schufaRequested: yesNo,
  costsComplete: yesNo,
  verified: yesNo,
  phoneGiven: yesNo,
  roomSize: { kind: "number", unit: "m²" },
  flatSize: { kind: "number", unit: "m²" },
  rooms: { kind: "number" },
  flatshareSize: { kind: "number", integer: true },
  minimumStay: { kind: "number", integer: true, unit: "months" },
  rentPerSqm: { kind: "number", unit: "€/m²" },
  transitMinutes: { kind: "number", integer: true, unit: "minutes" },
  photoCount: { kind: "number", integer: true },
  baseRent: { kind: "money" },
  utilities: { kind: "money" },
  otherCosts: { kind: "money" },
  deposit: { kind: "money" },
  equipmentFee: { kind: "money" },
  warmRent: { kind: "money" },
  availableFrom: { kind: "date" },
  availableUntil: { kind: "date", orNone: true },
  memberSince: { kind: "month" },
  district: { kind: "text" },
  street: { kind: "text" },
  postalCode: { kind: "text" },
  floor: { kind: "text" },
  buildingType: { kind: "text" },
  companyProfile: { kind: "text" },
  ageSought: { kind: "range" },
  flatmateAges: { kind: "range" },
  scamSignals: { kind: "checklist", options: TEXT_SCAM_SIGNALS },
  requirements: { kind: "requirements", kinds: REQUIREMENT_KINDS, strictness: STRICTNESS },
};

export const editorFor = (fact: string): FactEditor => EDITORS[fact] ?? { kind: "json" };

/**
 * The server refuses `unknown` for a list fact (an empty list says none); free JSON can type it.
 */
export const offersUnknown = (editor: FactEditor): boolean =>
  editor.kind !== "json" && editor.kind !== "checklist" && editor.kind !== "requirements";

/** Facts with no row to put an Override button on while the Offer says nothing of them. */
export const ALWAYS_OVERRIDABLE = ["anmeldung", "minimumStay", "scamSignals"] as const;

/** The server refuses them. */
export const NOT_OVERRIDABLE = new Set(["conflicts", "imageUrls", "category"]);
