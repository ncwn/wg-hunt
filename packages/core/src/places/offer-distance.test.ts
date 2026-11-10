import { describe, expect, it } from "vitest";
import type { OfferFacts } from "../offer-facts/schema.js";
import { fact, unknown } from "../ranking/test-helpers.js";
import { distanceToPlace } from "./offer-distance.js";
import { type Place, placeSchema } from "./place.js";
import { plzCentre } from "./plz.js";

const work: Place = placeSchema.parse({ name: "work", plz: "10115" });
const centre = plzCentre("10115") ?? { lat: 0, lng: 0 };

const facts = (extra: Record<string, unknown>) =>
  ({ category: "flatshare-room", ...extra }) as unknown as OfferFacts;

describe("distance from a Place to an Offer", () => {
  it("uses the Offer's coordinates, and is exact", () => {
    const offer = facts({ coordinates: fact({ lat: centre.lat + 0.02, lng: centre.lng }) });
    const found = distanceToPlace(offer, work);
    expect(found?.approximate).toBe(false);
    expect(found?.km).toBeCloseTo(2.224, 2);
  });

  it("falls back to the Offer's PLZ centre when it has no coordinates, and says so", () => {
    const found = distanceToPlace(facts({ postalCode: fact("10117") }), work);
    expect(found?.approximate).toBe(true);
    expect(found?.km).toBeGreaterThan(0);
    expect(found?.km).toBeLessThan(3);
  });

  it("falls back to the PLZ centre when the coordinates are unknown", () => {
    const found = distanceToPlace(
      facts({ coordinates: unknown(), postalCode: fact("10117") }),
      work,
    );
    expect(found?.approximate).toBe(true);
  });

  it("prefers the coordinates over the PLZ", () => {
    const offer = facts({
      coordinates: fact({ lat: centre.lat + 0.02, lng: centre.lng }),
      postalCode: fact("80331"),
    });
    expect(distanceToPlace(offer, work)?.approximate).toBe(false);
  });

  it("is unknown without coordinates or a PLZ the dataset knows", () => {
    expect(distanceToPlace(facts({}), work)).toBeNull();
    expect(distanceToPlace(facts({ postalCode: fact("00000") }), work)).toBeNull();
    expect(distanceToPlace(facts({ postalCode: unknown() }), work)).toBeNull();
  });

  it("measures from a Place given as coordinates", () => {
    const gym = placeSchema.parse({ name: "gym", lat: 0, lng: 0 });
    const offer = facts({ coordinates: fact({ lat: 1, lng: 0 }) });
    expect(distanceToPlace(offer, gym)?.km).toBeCloseTo(111.19, 1);
  });
});
