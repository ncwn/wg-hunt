import type { OfferFacts } from "../offer-facts/schema.js";
import { readFact } from "../ranking/read.js";
import { haversineKm, type LatLng } from "./distance.js";
import { type Place, placePoint } from "./place.js";
import { plzCentre } from "./plz.js";

export type OfferDistance = {
  /** Straight-line kilometres. */
  km: number;
  /** True when the Offer has no coordinates and its PLZ centre stood in for them. */
  approximate: boolean;
};

function offerPoint(facts: OfferFacts): { point: LatLng; approximate: boolean } | null {
  const coordinates = readFact<LatLng>(facts, "coordinates");
  if (coordinates.state === "known") {
    return { point: coordinates.value, approximate: false };
  }
  const plz = readFact<string>(facts, "postalCode");
  if (plz.state !== "known") return null;
  const centre = plzCentre(plz.value);
  return centre === null ? null : { point: centre, approximate: true };
}

/** Pure and offline: nothing here sends a location anywhere. */
export function distanceToPlace(facts: OfferFacts, place: Place): OfferDistance | null {
  const from = placePoint(place);
  const at = offerPoint(facts);
  if (from === null || at === null) return null;
  return { km: haversineKm(from, at.point), approximate: at.approximate };
}
