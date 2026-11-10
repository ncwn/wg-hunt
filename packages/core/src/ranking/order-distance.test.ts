import { describe, expect, it } from "vitest";
import { placeSchema } from "../places/place.js";
import { plzCentre } from "../places/plz.js";
import { compareKeys, orderKey } from "./order.js";
import { rankOffer } from "./rank.js";
import { DAY, fact, NOW, offer, seeking } from "./test-helpers.js";

const centre = plzCentre("10115") ?? { lat: 0, lng: 0 };
const work = placeSchema.parse({ name: "work", plz: "10115" });
const gym = placeSchema.parse({
  name: "gym",
  lat: centre.lat + 50 / 111.195,
  lng: centre.lng,
});

const north = (km: number) => fact({ lat: centre.lat + km / 111.195, lng: centre.lng });

type Spec = {
  name: string;
  facts?: Record<string, unknown>;
  bumped?: number;
  stale?: boolean;
};

function byDistance(specs: Spec[], place?: string, places = [work, gym]) {
  const config = seeking({ places });
  return specs
    .map((spec) => {
      const o = offer(spec.facts, {
        firstSeenAt: NOW - 10 * DAY,
        lastBumpAt: spec.bumped ?? null,
        stale: spec.stale,
      });
      return { spec, key: orderKey(o, rankOffer(o, config), "distance", config, place) };
    })
    .sort((a, b) => compareKeys(a.key, b.key))
    .map(({ spec }) => spec.name);
}

describe("sorting by distance to a Place", () => {
  const specs: Spec[] = [
    { name: "far", facts: { coordinates: north(12) } },
    { name: "near", facts: { coordinates: north(1) } },
    { name: "approx", facts: { postalCode: fact("10117") } },
    { name: "blank", facts: {}, bumped: NOW - DAY },
  ];

  it("puts the nearest first and Offers with no location last", () => {
    expect(byDistance(specs, "work")).toEqual(["near", "approx", "far", "blank"]);
  });

  it("measures from the chosen Place, whatever its case", () => {
    expect(byDistance(specs, "GYM")).toEqual(["far", "near", "approx", "blank"]);
  });

  it("measures from the first Place when none is chosen", () => {
    expect(byDistance(specs)).toEqual(byDistance(specs, "work"));
  });

  it("puts every Offer in the unknown group when the profile has no such Place", () => {
    const names = byDistance(specs, "nowhere");
    expect(names).toEqual(["blank", "far", "near", "approx"]);
  });

  it("keeps the bands apart", () => {
    const names = byDistance(
      [
        { name: "near-hidden", facts: { coordinates: north(1) }, stale: true },
        { name: "far-match", facts: { coordinates: north(30) } },
      ],
      "work",
    );
    expect(names).toEqual(["far-match", "near-hidden"]);
  });

  it("breaks a tie by recency and keeps the key JSON-safe", () => {
    const names = byDistance(
      [
        { name: "older", facts: { coordinates: north(4) }, bumped: NOW - 3 * DAY },
        { name: "newer", facts: { coordinates: north(4) }, bumped: NOW - DAY },
      ],
      "work",
    );
    expect(names).toEqual(["newer", "older"]);
    const o = offer({ coordinates: north(4) });
    const config = seeking({ places: [work] });
    const key = orderKey(o, rankOffer(o, config), "distance", config, "work");
    expect(JSON.parse(JSON.stringify(key))).toEqual(key);
  });
});
