import { z } from "zod";
import { flatshareTypeValue, furnishedValue } from "../offer-facts/values.js";

export const STRENGTHS = ["dealbreaker", "want"] as const;
export type Strength = (typeof STRENGTHS)[number];

/** How far a numeric Filter may be missed and still be a Near match instead of Hidden. */
const marginSchema = z.object({
  value: z.number().nonnegative(),
  unit: z.enum(["absolute", "percent"]),
});
export type Margin = z.infer<typeof marginSchema>;

const strength = z.enum(STRENGTHS);
const rule = { enabled: z.boolean(), strength };

const limit = z.number().nonnegative().nullable();

/**
 * A numeric Filter with no limit set, or a Filter that needs a Seeker Profile value the seeker has
 * not given, is not evaluated.
 */
export const filtersSchema = z.object({
  anmeldung: z.object(rule),
  genderSought: z.object(rule),
  requirements: z.object(rule),
  ageSought: z.object(rule),
  moveIn: z.object({ ...rule, marginDays: z.number().int().nonnegative().nullable() }),
  /** Available long enough for the intended minimum stay. */
  stayAvailable: z.object(rule),
  /** The Offer's minimum stay is not longer than the intended maximum stay. */
  stayMinimum: z.object(rule),
  /** Warm rent per month, in euros. */
  maxRent: z.object({ ...rule, limit, margin: marginSchema.nullable() }),
  /** Room (flatshare) or home size in square metres. */
  minSize: z.object({ ...rule, limit, margin: marginSchema.nullable() }),
  maxRentPerSqm: z.object({ ...rule, limit, margin: marginSchema.nullable() }),
  furnished: z.object({ ...rule, accept: z.array(furnishedValue).max(3) }),
  smoking: z.object(rule),
  pets: z.object(rule),
  /** Empty: not evaluated. */
  flatshareTypes: z.object({ ...rule, anyOf: z.array(flatshareTypeValue).max(24) }),
  /** District names or postal codes. Empty: not evaluated. */
  area: z.object({ ...rule, anyOf: z.array(z.string().min(1).max(60)).max(50) }),
  /** Straight-line kilometres to the named Place of the Seeker Profile. */
  distance: z.object({
    ...rule,
    place: z.string().min(1).max(40).nullable(),
    limit,
    margin: marginSchema.nullable(),
  }),
  languages: z.object(rule),
  /** Hides a Likely scam instead of showing it under Warned. */
  hideLikelyScams: z.object({ enabled: z.boolean(), strength: z.literal("dealbreaker") }),
  flatmateAges: z.object({
    ...rule,
    min: z.number().int().nullable(),
    max: z.number().int().nullable(),
  }),
});
export type Filters = z.infer<typeof filtersSchema>;
export type FilterKey = keyof Filters;
export const FILTER_KEYS = Object.keys(filtersSchema.shape) as FilterKey[];

const off = <S extends Strength>(s: S) => ({ enabled: false, strength: s });
const on = (s: Strength) => ({ enabled: true, strength: s });

export function defaultFilters(): Filters {
  return {
    anmeldung: on("dealbreaker"),
    genderSought: on("dealbreaker"),
    requirements: on("dealbreaker"),
    ageSought: on("want"),
    moveIn: { ...on("want"), marginDays: null },
    stayAvailable: on("want"),
    stayMinimum: on("want"),
    maxRent: { ...on("dealbreaker"), limit: null, margin: { value: 10, unit: "percent" } },
    minSize: { ...on("want"), limit: null, margin: null },
    maxRentPerSqm: { ...off("dealbreaker"), limit: null, margin: null },
    furnished: { ...off("want"), accept: ["furnished", "partly_furnished"] },
    smoking: off("want"),
    pets: off("want"),
    flatshareTypes: { ...off("want"), anyOf: [] },
    area: { ...off("want"), anyOf: [] },
    distance: { ...off("want"), place: null, limit: null, margin: null },
    languages: off("want"),
    hideLikelyScams: off("dealbreaker"),
    flatmateAges: { ...off("want"), min: null, max: null },
  };
}

/** Fills in any Filter a newer version added with its default. */
export function parseFilters(saved: unknown): Filters | null {
  if (typeof saved !== "object" || saved === null) return null;
  const parsed = filtersSchema.safeParse({ ...defaultFilters(), ...saved });
  return parsed.success ? parsed.data : null;
}
