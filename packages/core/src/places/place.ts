import { z } from "zod";
import type { LatLng } from "./distance.js";
import { plzCentre } from "./plz.js";

/** Local database only; never in logs or errors. */
export const placeSchema = z
  .object({
    name: z.string().trim().min(1, "A Place needs a name").max(40),
    plz: z
      .string()
      .regex(/^\d{5}$/, "A PLZ has five digits")
      .optional(),
    lat: z
      .number()
      .min(-90, "Latitude is between -90 and 90")
      .max(90, "Latitude is between -90 and 90")
      .optional(),
    lng: z
      .number()
      .min(-180, "Longitude is between -180 and 180")
      .max(180, "Longitude is between -180 and 180")
      .optional(),
  })
  .superRefine((place, ctx) => {
    const hasCoordinates = place.lat !== undefined || place.lng !== undefined;
    if (place.plz !== undefined && hasCoordinates) {
      ctx.addIssue({ code: "custom", message: "Give a PLZ or coordinates, not both" });
    } else if (place.plz !== undefined) {
      // A malformed PLZ already has its own issue above.
      if (/^\d{5}$/.test(place.plz) && plzCentre(place.plz) === null) {
        ctx.addIssue({ code: "custom", path: ["plz"], message: "This PLZ is not in the dataset" });
      }
    } else if (place.lat === undefined || place.lng === undefined) {
      ctx.addIssue({ code: "custom", message: "Give a PLZ or coordinates" });
    }
  });
export type Place = z.infer<typeof placeSchema>;

export function placePoint(place: Place): LatLng | null {
  if (place.plz !== undefined) return plzCentre(place.plz);
  return place.lat !== undefined && place.lng !== undefined
    ? { lat: place.lat, lng: place.lng }
    : null;
}

export function findPlace(places: readonly Place[], name: string): Place | undefined {
  const wanted = name.trim().toLowerCase();
  return places.find((place) => place.name.toLowerCase() === wanted);
}
