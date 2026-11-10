import { describe, expect, it } from "vitest";
import { defaultFilters, filtersSchema, parseFilters } from "./filters.js";
import { defaultSeekerProfile, seekerProfileSchema } from "./profile.js";

describe("saved Filters", () => {
  it("the defaults are valid Filters and a valid Seeker Profile", () => {
    expect(filtersSchema.safeParse(defaultFilters()).success).toBe(true);
    expect(seekerProfileSchema.safeParse(defaultSeekerProfile()).success).toBe(true);
  });

  it("fill a Filter a newer version added with its default", () => {
    const { area: _area, ...older } = defaultFilters();
    expect(parseFilters(older)).toEqual(defaultFilters());
  });

  it("are rejected when they are not Filters", () => {
    expect(parseFilters(null)).toBeNull();
    expect(parseFilters({ maxRent: { enabled: "yes" } })).toBeNull();
  });

  it("rejects a Profile whose move-in window or stay runs backwards", () => {
    const base = defaultSeekerProfile();
    const backwards = [
      { ...base, moveIn: { earliest: "2027-02-01", latest: "2027-01-01" } },
      { ...base, stay: { minMonths: 12, maxMonths: 6 } },
    ];
    for (const profile of backwards) {
      expect(seekerProfileSchema.safeParse(profile).success).toBe(false);
    }
    const fine = [
      { ...base, moveIn: { earliest: "2027-01-01", latest: "2027-01-01" } },
      { ...base, stay: { minMonths: 6, maxMonths: 6 } },
      { ...base, moveIn: { earliest: "2027-01-01", latest: null } },
    ];
    for (const profile of fine) {
      expect(seekerProfileSchema.safeParse(profile).success).toBe(true);
    }
  });
});
