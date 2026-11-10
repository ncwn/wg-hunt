import { describe, expect, it } from "vitest";
import { medianOf, type RentSample, rentBaselines } from "./baseline.js";

const NOW = Date.parse("2026-11-04T09:00:00Z");
const DAY = 86_400_000;

const sample = (id: number, rentPerSqm: number, extra: Partial<RentSample> = {}): RentSample => ({
  id,
  category: "flatshare-room",
  district: "Neukölln",
  rentPerSqm,
  seenAt: NOW - DAY,
  ...extra,
});

const many = (count: number, rent = 20, extra: Partial<RentSample> = {}) =>
  Array.from({ length: count }, (_, index) => sample(100 + index, rent, extra));

describe("medianOf", () => {
  it("takes the middle value of an odd list", () => {
    expect(medianOf([30, 10, 20])).toBe(20);
  });

  it("averages the two middle values of an even list", () => {
    expect(medianOf([10, 20, 30, 41])).toBe(25);
  });
});

describe("rentBaselines", () => {
  const target = { id: 1, category: "flatshare-room", district: "Neukölln" } as const;

  it("is the median of the other Offers in the same category and district", () => {
    const baseline = rentBaselines([...many(14, 20), sample(200, 30)], NOW)(target);
    expect(baseline).toEqual({ median: 20, count: 15, district: "Neukölln" });
  });

  it("is silent with fewer than 15 comparable Offers", () => {
    expect(rentBaselines(many(14), NOW)(target)).toBeNull();
  });

  it("never counts the Offer itself", () => {
    expect(rentBaselines([...many(14), sample(1, 5)], NOW)(target)).toBeNull();
  });

  it("only counts Offers first seen in the last 30 days", () => {
    expect(rentBaselines(many(15, 20, { seenAt: NOW - 31 * DAY }), NOW)(target)).toBeNull();
    expect(rentBaselines(many(15, 20, { seenAt: NOW - 30 * DAY }), NOW)(target)).not.toBeNull();
  });

  it("only counts the same category", () => {
    expect(rentBaselines(many(15, 20, { category: "flat" }), NOW)(target)).toBeNull();
  });

  it("only counts the same district, ignoring case and spacing", () => {
    expect(rentBaselines(many(15, 20, { district: "Mitte" }), NOW)(target)).toBeNull();
    expect(rentBaselines(many(15, 20, { district: " neukölln " }), NOW)(target)).not.toBeNull();
  });

  it("has no baseline for an Offer without a district", () => {
    expect(rentBaselines(many(15), NOW)({ ...target, district: null })).toBeNull();
  });
});
