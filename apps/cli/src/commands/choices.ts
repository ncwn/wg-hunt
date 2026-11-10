import type { components, paths } from "../api/schema.js";

type Search = components["schemas"]["Search"];
type OffersQuery = NonNullable<paths["/offers"]["get"]["parameters"]["query"]>;

/**
 * Written as a record over the API's own type: the typecheck fails when the server adds a value
 * (a missing key) or drops one (an excess key).
 */
const valuesOf = <T extends string>(all: Record<T, true>): T[] => Object.keys(all) as T[];

export const BANDS = valuesOf<components["schemas"]["Band"]>({
  match: true,
  "near-match": true,
  warned: true,
  hidden: true,
});

export const CATEGORIES = valuesOf<Search["categories"][number]>({
  "flatshare-room": true,
  "one-room-flat": true,
  flat: true,
  house: true,
});

export const RENT_TYPES = valuesOf<Search["rentTypes"][number]>({
  unlimited: true,
  limited: true,
  overnight: true,
});

export const SORTS = valuesOf<NonNullable<OffersQuery["sort"]>>({
  recency: true,
  "warm-rent": true,
  "rent-per-sqm": true,
  size: true,
  "available-from": true,
  distance: true,
});
