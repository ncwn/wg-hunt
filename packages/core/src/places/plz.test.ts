import { describe, expect, it } from "vitest";
import { haversineKm } from "./distance.js";
import { plzCentre } from "./plz.js";

describe("PLZ centres from the bundled dataset", () => {
  it("resolves a Berlin PLZ to a point in Berlin", () => {
    const centre = plzCentre("10115");
    expect(centre).not.toBeNull();
    // Berlin Mitte is a few km from the city's middle (Alexanderplatz area, 52.52 N, 13.41 E).
    expect(haversineKm(centre ?? { lat: 0, lng: 0 }, { lat: 52.52, lng: 13.405 })).toBeLessThan(5);
  });

  it("resolves PLZs in other cities, and ones that start with a zero", () => {
    expect(plzCentre("80331")?.lat).toBeCloseTo(48.14, 0);
    expect(plzCentre("01067")?.lat).toBeCloseTo(51.05, 0);
  });

  it("answers null for a PLZ that does not exist", () => {
    expect(plzCentre("00000")).toBeNull();
    expect(plzCentre("99999")).toBeNull();
  });

  it("answers null for something that is not a five-digit PLZ", () => {
    expect(plzCentre("1011")).toBeNull();
    expect(plzCentre("101155")).toBeNull();
    expect(plzCentre("abcde")).toBeNull();
    expect(plzCentre("__proto__")).toBeNull();
  });
});
