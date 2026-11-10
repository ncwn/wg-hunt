import { describe, expect, it } from "vitest";
import { placeSchema } from "../places/place.js";
import { plzCentre } from "../places/plz.js";
import { seekerProfileSchema } from "./profile.js";
import { fact, rank, reasonFor, unknown } from "./test-helpers.js";

const work = placeSchema.parse({ name: "work", plz: "10115" });
const centre = plzCentre("10115") ?? { lat: 0, lng: 0 };

/** One degree of latitude is 111.195 km. */
const north = (km: number) => fact({ lat: centre.lat + km / 111.195, lng: centre.lng });

const profile = { places: [work] };
const distance = (patch: Record<string, unknown> = {}) => ({
  distance: { enabled: true, strength: "want" as const, place: "work", limit: 5, ...patch },
});

describe("the distance Filter", () => {
  it("is off by default, and a Place alone changes nothing", () => {
    const ranking = rank({ coordinates: north(50) }, profile);
    expect(reasonFor(ranking, "distance")).toBeUndefined();
    expect(ranking.band).toBe("match");
  });

  it("passes inside the limit, naming the distance", () => {
    const ranking = rank({ coordinates: north(3) }, profile, distance());
    expect(ranking.band).toBe("match");
    expect(reasonFor(ranking, "distance")).toMatchObject({
      outcome: "pass",
      cause: "met",
      message: "Distance to work 3 km is at most 5 km",
    });
  });

  it("makes a Want that misses a Near match", () => {
    const ranking = rank({ coordinates: north(8) }, profile, distance());
    expect(ranking.band).toBe("near-match");
    expect(reasonFor(ranking, "distance")).toMatchObject({ outcome: "fail", cause: "missed" });
  });

  it("hides an Offer that misses a Dealbreaker", () => {
    const ranking = rank({ coordinates: north(8) }, profile, distance({ strength: "dealbreaker" }));
    expect(ranking.band).toBe("hidden");
  });

  it("keeps a Dealbreaker miss inside an absolute margin as a Near match", () => {
    const margin = { value: 1, unit: "absolute" as const };
    const filters = distance({ strength: "dealbreaker", margin });
    expect(rank({ coordinates: north(5.8) }, profile, filters).band).toBe("near-match");
    expect(
      reasonFor(rank({ coordinates: north(5.8) }, profile, filters), "distance"),
    ).toMatchObject({ cause: "within-margin" });
    expect(rank({ coordinates: north(6.5) }, profile, filters).band).toBe("hidden");
  });

  it("takes a margin in percent", () => {
    const margin = { value: 20, unit: "percent" as const };
    const filters = distance({ strength: "dealbreaker", margin });
    expect(rank({ coordinates: north(5.9) }, profile, filters).band).toBe("near-match");
    expect(rank({ coordinates: north(6.2) }, profile, filters).band).toBe("hidden");
  });

  it("measures from the Place the Filter names, whatever its case", () => {
    const home = placeSchema.parse({ name: "Home", lat: centre.lat + 0.5, lng: centre.lng });
    const both = { places: [work, home] };
    const near = rank({ coordinates: north(1) }, both, distance({ place: "work" }));
    const far = rank({ coordinates: north(1) }, both, distance({ place: "HOME" }));
    expect(near.band).toBe("match");
    expect(far.band).toBe("near-match");
  });

  it("is not evaluated without a limit, a named Place or a Place in the profile", () => {
    const facts = { coordinates: north(50) };
    expect(reasonFor(rank(facts, profile, distance({ limit: null })), "distance")).toBeUndefined();
    expect(reasonFor(rank(facts, profile, distance({ place: null })), "distance")).toBeUndefined();
    expect(reasonFor(rank(facts, profile, distance({ place: "gym" })), "distance")).toBeUndefined();
    expect(reasonFor(rank(facts, {}, distance()), "distance")).toBeUndefined();
  });

  describe("an Offer without coordinates", () => {
    it("uses its PLZ centre and marks the distance approximate", () => {
      const ranking = rank({ postalCode: fact("10117") }, profile, distance());
      expect(ranking.band).toBe("match");
      expect(reasonFor(ranking, "distance")?.message).toMatch(/^Approximate distance to work /);
    });

    it("never hides an Offer on an approximate miss, even for a Dealbreaker", () => {
      const ranking = rank(
        { postalCode: fact("80331") },
        profile,
        distance({ strength: "dealbreaker" }),
      );
      expect(ranking.band).toBe("near-match");
      expect(reasonFor(ranking, "distance")).toMatchObject({ outcome: "warn", cause: "unknown" });
      expect(reasonFor(ranking, "distance")?.message).toMatch(/^Approximate distance to work /);
    });

    it("is a Near match with the reason when the location is not known at all", () => {
      const ranking = rank({ coordinates: unknown(), postalCode: unknown() }, profile, distance());
      expect(ranking.band).toBe("near-match");
      expect(reasonFor(ranking, "distance")).toMatchObject({ cause: "unknown" });
    });
  });

  it("never puts coordinates in a reason", () => {
    const ranking = rank({ coordinates: north(3) }, profile, distance());
    const text = JSON.stringify(ranking.reasons);
    expect(text).not.toContain(String(centre.lat).slice(0, 5));
    expect(text).not.toContain(String(centre.lng).slice(0, 5));
  });
});

describe("Places in the Seeker Profile", () => {
  const base = {
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
  };

  it("default to none", () => {
    expect(seekerProfileSchema.parse(base).places).toEqual([]);
  });

  it("must have different names, whatever the case", () => {
    const result = seekerProfileSchema.safeParse({
      ...base,
      places: [work, { ...work, name: "WORK" }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["places", 1, "name"]);
  });

  it("reports an unknown PLZ at the Place", () => {
    const result = seekerProfileSchema.safeParse({
      ...base,
      places: [{ name: "work", plz: "00000" }],
    });
    expect(result.error?.issues[0]?.path).toEqual(["places", 0, "plz"]);
  });
});
