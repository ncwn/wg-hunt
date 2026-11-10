import { describe, expect, it } from "vitest";
import { doubtful, fact, rank, reasonFor } from "./test-helpers.js";

const window = { moveIn: { earliest: "2027-01-01", latest: "2027-01-15" } };

describe("move-in window", () => {
  it("is not evaluated while the profile has no window", () => {
    expect(rank({ availableFrom: fact("2030-01-01") }).band).toBe("match");
  });

  it.each([
    ["2027-01-01", "match"],
    ["2027-01-10", "match"],
    ["2027-01-15", "match"],
  ])("available from %s is a %s", (from, band) => {
    expect(rank({ availableFrom: fact(from) }, window).band).toBe(band);
  });

  it("is a Near match 'N days early' when free before the window", () => {
    const result = rank({ availableFrom: fact("2026-12-20") }, window);
    expect(result.band).toBe("near-match");
    expect(reasonFor(result, "moveIn")).toMatchObject({
      outcome: "warn",
      cause: "early",
      message: expect.stringContaining("12 days early"),
    });
  });

  it("is a Near match when early even if raised to a Dealbreaker", () => {
    const result = rank({ availableFrom: fact("2026-06-01") }, window, {
      moveIn: { strength: "dealbreaker" },
    });
    expect(result.band).toBe("near-match");
  });

  it("fails a Want when free after the window", () => {
    const result = rank({ availableFrom: fact("2027-01-16") }, window);
    expect(result.band).toBe("near-match");
    expect(reasonFor(result, "moveIn")).toMatchObject({ outcome: "fail", effect: "near-match" });
  });

  it("hides an Offer free after the window when raised to a Dealbreaker", () => {
    const filters = { moveIn: { strength: "dealbreaker" as const } };
    expect(rank({ availableFrom: fact("2027-03-01") }, window, filters).band).toBe("hidden");
  });

  it("keeps a Dealbreaker miss inside the margin in days a Near match", () => {
    const filters = { moveIn: { strength: "dealbreaker" as const, marginDays: 14 } };
    expect(rank({ availableFrom: fact("2027-01-29") }, window, filters).band).toBe("near-match");
    expect(rank({ availableFrom: fact("2027-01-30") }, window, filters).band).toBe("hidden");
  });

  it("reads a window with one end only", () => {
    const onlyEarliest = { moveIn: { earliest: "2027-01-01", latest: null } };
    expect(rank({ availableFrom: fact("2030-01-01") }, onlyEarliest).band).toBe("match");
    expect(rank({ availableFrom: fact("2026-12-30") }, onlyEarliest).band).toBe("near-match");
    const onlyLatest = { moveIn: { earliest: null, latest: "2027-01-15" } };
    expect(rank({ availableFrom: fact("2020-01-01") }, onlyLatest).band).toBe("match");
    expect(rank({ availableFrom: fact("2027-02-01") }, onlyLatest).band).toBe("near-match");
  });

  it("is a Near match when the date is unknown or Doubtful", () => {
    expect(rank({ availableFrom: fact("unknown") }, window).band).toBe("near-match");
    expect(rank({ availableFrom: doubtful("2027-01-05") }, window).band).toBe("near-match");
  });
});

describe("available long enough for the intended stay", () => {
  const stay = { stay: { minMonths: 12, maxMonths: null } };

  it("is not evaluated while the profile has no minimum stay", () => {
    expect(
      rank({ availableFrom: fact("2027-01-01"), availableUntil: fact("2027-02-01") }).band,
    ).toBe("match");
  });

  it("passes an open-ended Offer", () => {
    const result = rank({ availableFrom: fact("2027-01-01"), availableUntil: fact("none") }, stay);
    expect(result.band).toBe("match");
    expect(reasonFor(result, "stayAvailable")?.outcome).toBe("pass");
  });

  it("passes when the Offer lasts exactly the stay", () => {
    const facts = { availableFrom: fact("2027-01-01"), availableUntil: fact("2027-12-31") };
    expect(rank(facts, stay).band).toBe("match");
  });

  it("fails a Want when the Offer ends before the stay would", () => {
    const facts = { availableFrom: fact("2027-01-01"), availableUntil: fact("2027-06-30") };
    const result = rank(facts, stay);
    expect(result.band).toBe("near-match");
    expect(reasonFor(result, "stayAvailable")).toMatchObject({ outcome: "fail" });
  });

  it("counts the stay from the seeker's earliest move-in when that is later", () => {
    const facts = { availableFrom: fact("2026-10-01"), availableUntil: fact("2027-09-30") };
    expect(reasonFor(rank(facts, stay), "stayAvailable")?.outcome).toBe("pass");
    expect(reasonFor(rank(facts, { ...stay, ...window }), "stayAvailable")?.outcome).toBe("fail");
  });

  it("is a Near match when the end date is unknown", () => {
    const facts = { availableFrom: fact("2027-01-01"), availableUntil: fact("unknown") };
    expect(rank(facts, stay).band).toBe("near-match");
  });

  it("can be raised to a Dealbreaker", () => {
    const facts = { availableFrom: fact("2027-01-01"), availableUntil: fact("2027-03-31") };
    expect(rank(facts, stay, { stayAvailable: { strength: "dealbreaker" } }).band).toBe("hidden");
  });
});

describe("minimum stay against the intended maximum", () => {
  const stay = { stay: { minMonths: null, maxMonths: 6 } };

  it("is not evaluated while the profile has no maximum stay", () => {
    expect(rank({ minimumStay: fact(24) }).band).toBe("match");
  });

  it("passes a minimum stay up to the maximum", () => {
    expect(rank({ minimumStay: fact(6) }, stay).band).toBe("match");
  });

  it("fails a Want when the minimum stay is longer", () => {
    const result = rank({ minimumStay: fact(12) }, stay);
    expect(result.band).toBe("near-match");
    expect(reasonFor(result, "stayMinimum")).toMatchObject({ outcome: "fail" });
  });

  it("counts a minimum stay no model has read as unknown", () => {
    const result = rank({}, stay);
    expect(result.band).toBe("near-match");
    expect(reasonFor(result, "stayMinimum")?.cause).toBe("unknown");
  });

  it("is a Near match when the minimum stay is Doubtful", () => {
    expect(rank({ minimumStay: doubtful(3) }, stay).band).toBe("near-match");
    expect(
      rank({ minimumStay: doubtful(12) }, stay, { stayMinimum: { strength: "dealbreaker" } }).band,
    ).toBe("near-match");
  });
});
