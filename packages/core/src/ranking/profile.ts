import { z } from "zod";
import { genderSchema, isoDate } from "../offer-facts/values.js";
import { placeSchema } from "../places/place.js";

const DIETS = ["omnivore", "vegetarian", "vegan"] as const;
const OCCUPATIONS = ["student", "working", "trainee"] as const;

const baseProfile = z.object({
  gender: genderSchema.nullable(),
  age: z.number().int().min(16).max(120).nullable(),
  anmeldungNeeded: z.boolean(),
  moveIn: z.object({ earliest: isoDate.nullable(), latest: isoDate.nullable() }),
  stay: z.object({
    minMonths: z.number().int().positive().max(1200).nullable(),
    maxMonths: z.number().int().positive().max(1200).nullable(),
  }),
  diet: z.enum(DIETS).nullable(),
  occupation: z.enum(OCCUPATIONS).nullable(),
  smoker: z.boolean().nullable(),
  hasPets: z.boolean().nullable(),
  /** ISO 639-1 codes. */
  languages: z.array(z.string().regex(/^[a-z]{2}$/)).max(20),
  places: z.array(placeSchema).max(20).default([]),
});
export type SeekerProfile = z.infer<typeof baseProfile>;

export const seekerProfileSchema = baseProfile.superRefine((profile, ctx) => {
  const { earliest, latest } = profile.moveIn;
  if (earliest !== null && latest !== null && earliest > latest) {
    ctx.addIssue({
      code: "custom",
      path: ["moveIn", "latest"],
      message: "The latest move-in date is before the earliest.",
    });
  }
  const { minMonths, maxMonths } = profile.stay;
  if (minMonths !== null && maxMonths !== null && minMonths > maxMonths) {
    ctx.addIssue({
      code: "custom",
      path: ["stay", "maxMonths"],
      message: "The longest stay is shorter than the shortest.",
    });
  }
  const seen = new Set<string>();
  profile.places.forEach((place, index) => {
    const name = place.name.toLowerCase();
    if (seen.has(name)) {
      ctx.addIssue({
        code: "custom",
        path: ["places", index, "name"],
        message: "Two Places have the same name.",
      });
    }
    seen.add(name);
  });
});
export function defaultSeekerProfile(): SeekerProfile {
  return {
    gender: null,
    age: null,
    anmeldungNeeded: false,
    moveIn: { earliest: null, latest: null },
    stay: { minMonths: null, maxMonths: null },
    diet: null,
    occupation: null,
    smoker: null,
    hasPets: null,
    languages: [],
    places: [],
  };
}
