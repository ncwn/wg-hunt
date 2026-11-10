import { describe, expect, it } from "vitest";
import { placePoint, placeSchema } from "./place.js";
import { plzCentre } from "./plz.js";

const issues = (input: unknown) => {
  const result = placeSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("a Place", () => {
  it("is a name and a PLZ that resolves offline to that PLZ's centre", () => {
    const place = placeSchema.parse({ name: "work", plz: "10115" });
    expect(placePoint(place)).toEqual(plzCentre("10115"));
  });

  it("is a name and pasted coordinates, which are used as given", () => {
    const place = placeSchema.parse({ name: "gym", lat: 10.5, lng: -20.25 });
    expect(placePoint(place)).toEqual({ lat: 10.5, lng: -20.25 });
  });

  it("trims its name", () => {
    expect(placeSchema.parse({ name: "  work ", plz: "10115" }).name).toBe("work");
  });

  it("rejects a PLZ the dataset does not know", () => {
    expect(issues({ name: "work", plz: "00000" })).toEqual(["plz: This PLZ is not in the dataset"]);
  });

  it("rejects something that is not a five-digit PLZ", () => {
    expect(issues({ name: "work", plz: "1011" })).toEqual(["plz: A PLZ has five digits"]);
  });

  it("needs a PLZ or both coordinates", () => {
    expect(issues({ name: "work" })).toEqual([": Give a PLZ or coordinates"]);
    expect(issues({ name: "work", lat: 10 })).toEqual([": Give a PLZ or coordinates"]);
  });

  it("takes a PLZ or coordinates, not both", () => {
    expect(issues({ name: "work", plz: "10115", lat: 10, lng: 10 })).toEqual([
      ": Give a PLZ or coordinates, not both",
    ]);
  });

  it("keeps coordinates on Earth, without echoing them", () => {
    const found = issues({ name: "work", lat: 123.456, lng: 10 });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^lat:/);
    expect(found.join()).not.toContain("123.456");
  });

  it("needs a name", () => {
    expect(issues({ name: "  ", plz: "10115" })).toHaveLength(1);
  });
});
