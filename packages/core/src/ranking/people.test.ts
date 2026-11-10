import { describe, expect, it } from "vitest";
import { doubtful, fact, rank, reasonFor } from "./test-helpers.js";

describe("Anmeldung", () => {
  const needs = { anmeldungNeeded: true };

  it("is not evaluated when the profile does not need Anmeldung", () => {
    const result = rank({ anmeldung: fact("not_possible") });
    expect(result.band).toBe("match");
    expect(reasonFor(result, "anmeldung")).toBeUndefined();
  });

  it("matches when Anmeldung is possible", () => {
    const result = rank({ anmeldung: fact("possible") }, needs);
    expect(result.band).toBe("match");
    expect(reasonFor(result, "anmeldung")).toMatchObject({ outcome: "pass", effect: "none" });
  });

  it("is a Near match when it is conditional, with the condition quoted", () => {
    const result = rank(
      { anmeldung: fact("conditional", { quote: "Anmeldung nur nach 3 Monaten" }) },
      needs,
    );
    expect(result.band).toBe("near-match");
    expect(reasonFor(result, "anmeldung")).toMatchObject({
      outcome: "warn",
      cause: "conditional",
      quote: "Anmeldung nur nach 3 Monaten",
    });
  });

  it.each([
    ["unknown", fact("unknown")],
    ["not yet analysed", undefined],
  ])("is a Near match when it is %s", (_name, anmeldung) => {
    const result = rank(anmeldung ? { anmeldung } : {}, needs);
    expect(result.band).toBe("near-match");
    expect(reasonFor(result, "anmeldung")?.cause).toBe("unknown");
  });

  it("hides an Offer where Anmeldung is not possible", () => {
    const result = rank({ anmeldung: fact("not_possible") }, needs);
    expect(result.band).toBe("hidden");
    expect(reasonFor(result, "anmeldung")).toMatchObject({ outcome: "fail", effect: "hidden" });
  });

  it("only makes a Near match of a Doubtful not_possible, never Hidden", () => {
    expect(rank({ anmeldung: doubtful("not_possible") }, needs).band).toBe("near-match");
  });

  it("makes a Near match of a Doubtful possible", () => {
    const result = rank({ anmeldung: doubtful("possible") }, needs);
    expect(result.band).toBe("near-match");
    expect(reasonFor(result, "anmeldung")?.cause).toBe("doubtful");
  });

  it("is a Near match, not Hidden, when it is a Want", () => {
    const result = rank({ anmeldung: fact("not_possible") }, needs, {
      anmeldung: { strength: "want" },
    });
    expect(result.band).toBe("near-match");
  });
});

describe("gender sought", () => {
  const woman = { gender: "woman" as const };

  it("is not evaluated until the profile has a gender", () => {
    expect(rank({ genderSought: fact(["man"]) }).band).toBe("match");
  });

  it("matches when the Offer seeks anyone", () => {
    expect(rank({ genderSought: fact("any") }, woman).band).toBe("match");
  });

  it("matches when the seeker's gender is in the set sought", () => {
    expect(rank({ genderSought: fact(["woman", "diverse"]) }, woman).band).toBe("match");
  });

  it("hides an Offer that leaves out the seeker's gender", () => {
    const result = rank({ genderSought: fact(["man"], { quote: "nur Männer" }) }, woman);
    expect(result.band).toBe("hidden");
    expect(reasonFor(result, "genderSought")).toMatchObject({
      outcome: "fail",
      quote: "nur Männer",
    });
  });

  it("makes a Near match of a Possible request: someone of the seeker's gender already lives there", () => {
    const flatmates = fact({ women: 1, men: 1, diverse: 0, unspecified: 0 });
    const result = rank({ genderSought: fact(["man"]), flatmates }, woman);
    expect(result.band).toBe("near-match");
    expect(reasonFor(result, "genderSought")).toMatchObject({
      outcome: "warn",
      cause: "worth-asking",
    });
  });

  it("hides when no flatmate shares the seeker's gender", () => {
    const flatmates = fact({ women: 0, men: 2, diverse: 0, unspecified: 0 });
    expect(rank({ genderSought: fact(["man"]), flatmates }, woman).band).toBe("hidden");
  });

  it("hides when the flatmates are not known", () => {
    expect(rank({ genderSought: fact(["man"]), flatmates: fact("unknown") }, woman).band).toBe(
      "hidden",
    );
  });

  it("is a Near match when the sought gender is unknown or Doubtful", () => {
    expect(rank({ genderSought: fact("unknown") }, woman).band).toBe("near-match");
    expect(rank({ genderSought: doubtful(["man"]) }, woman).band).toBe("near-match");
    expect(rank({ genderSought: doubtful("any") }, woman).band).toBe("near-match");
  });

  it("applies to a flat offered as a WG, and not to a plain flat", () => {
    const facts = { genderSought: fact(["man"]) };
    expect(rank({ ...facts, offeredAsWg: fact(true) }, woman, {}, { category: "flat" }).band).toBe(
      "hidden",
    );
    expect(rank({ ...facts }, woman, {}, { category: "flat" }).band).toBe("match");
    expect(rank({ ...facts }, woman, {}, { category: "one-room-flat" }).band).toBe("match");
  });
});

describe("age sought", () => {
  const age = { age: 27 };

  it("is not evaluated until the profile has an age", () => {
    expect(rank({ ageSought: fact({ min: 30, max: 40 }) }).band).toBe("match");
  });

  it.each([
    [{ min: 20, max: 30 }, "match"],
    [{ min: 27, max: 27 }, "match"],
    [{ min: 18 }, "match"],
    [{ max: 35 }, "match"],
    [{}, "match"],
    [{ min: 30, max: 40 }, "near-match"],
    [{ max: 25 }, "near-match"],
    [{ min: 28 }, "near-match"],
  ])("a range of %j is a %s", (range, band) => {
    expect(rank({ ageSought: fact(range) }, age).band).toBe(band);
  });

  it("only fails a Want: outside the range is never Hidden", () => {
    const result = rank({ ageSought: fact({ min: 30 }) }, age);
    expect(reasonFor(result, "ageSought")).toMatchObject({ outcome: "fail", effect: "near-match" });
  });

  it("can be raised to a Dealbreaker", () => {
    expect(
      rank({ ageSought: fact({ min: 30 }) }, age, { ageSought: { strength: "dealbreaker" } }).band,
    ).toBe("hidden");
  });

  it("is a Near match when unknown", () => {
    expect(rank({ ageSought: fact("unknown") }, age).band).toBe("near-match");
  });

  it("does not apply to a 1-room flat", () => {
    expect(
      rank({ ageSought: fact({ min: 30 }) }, age, {}, { category: "one-room-flat" }).band,
    ).toBe("match");
  });
});
