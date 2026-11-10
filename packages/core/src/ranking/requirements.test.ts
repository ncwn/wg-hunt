import { describe, expect, it } from "vitest";
import { doubtful, fact, rank, reasonFor } from "./test-helpers.js";

const required = (kind: string, value: string, quote = "Hausregel") =>
  fact({ kind, strictness: "required", value }, { quote });
const preferred = (kind: string, value: string) =>
  fact({ kind, strictness: "preferred", value }, { quote: "gern" });

describe("Requirements", () => {
  it("are not evaluated while the profile says nothing a Requirement could contradict", () => {
    const result = rank({ requirements: [required("diet", "vegan")] });
    expect(result.band).toBe("match");
    expect(reasonFor(result, "requirements")).toBeUndefined();
  });

  it("are not evaluated for a vegan, who no diet Requirement can contradict", () => {
    expect(rank({ requirements: [required("diet", "vegan")] }, { diet: "vegan" }).reasons).toEqual(
      [],
    );
  });

  describe("a required Requirement the profile contradicts", () => {
    it.each([
      ["vegan diet, vegetarian seeker", required("diet", "vegan"), { diet: "vegetarian" as const }],
      ["vegan diet, omnivore seeker", required("diet", "vegan"), { diet: "omnivore" as const }],
      [
        "vegetarian diet, omnivore seeker",
        required("diet", "vegetarian"),
        { diet: "omnivore" as const },
      ],
      [
        "students only, working seeker",
        required("occupation", "student"),
        { occupation: "working" as const },
      ],
      ["non-smokers, smoker", required("smoking", "non_smoker"), { smoker: true }],
      ["no pets, seeker with pets", required("pets", "no_pets"), { hasPets: true }],
      ["German, seeker who speaks only English", required("language", "de"), { languages: ["en"] }],
    ])("hides: %s", (_name, requirement, profile) => {
      const result = rank({ requirements: [requirement] }, profile);
      expect(result.band).toBe("hidden");
      expect(reasonFor(result, "requirements")).toMatchObject({
        outcome: "fail",
        effect: "hidden",
        quote: "Hausregel",
      });
    });

    it("moves to Near match when the Filter is a Want", () => {
      const result = rank(
        { requirements: [required("diet", "vegan")] },
        { diet: "omnivore" },
        { requirements: { strength: "want" } },
      );
      expect(result.band).toBe("near-match");
    });

    it("moves to Near match when the Requirement is Doubtful", () => {
      const result = rank(
        { requirements: [doubtful({ kind: "diet", strictness: "required", value: "vegan" })] },
        { diet: "omnivore" },
      );
      expect(result.band).toBe("near-match");
      expect(reasonFor(result, "requirements")?.cause).toBe("doubtful");
    });

    it("still hides when another, firm Requirement is also contradicted", () => {
      const result = rank(
        {
          requirements: [
            doubtful({ kind: "diet", strictness: "required", value: "vegan" }),
            required("smoking", "non_smoker"),
          ],
        },
        { diet: "omnivore", smoker: true },
      );
      expect(result.band).toBe("hidden");
    });
  });

  describe("anything else is a chip, not a miss", () => {
    it("a preferred Requirement the profile contradicts", () => {
      const result = rank({ requirements: [preferred("diet", "vegan")] }, { diet: "omnivore" });
      expect(result.band).toBe("match");
      expect(result.chips).toContainEqual(
        expect.objectContaining({ kind: "requirement", tone: "warn", quote: "gern" }),
      );
    });

    it("a required Requirement the profile is silent on", () => {
      const result = rank({ requirements: [required("occupation", "student")] }, { smoker: true });
      expect(result.band).toBe("match");
      expect(result.chips).toContainEqual(
        expect.objectContaining({ kind: "requirement", tone: "info" }),
      );
    });

    it.each(["religion", "other"])("a %s Requirement", (kind) => {
      const result = rank({ requirements: [required(kind, "free text")] }, { smoker: true });
      expect(result.band).toBe("match");
      expect(result.chips).toHaveLength(1);
    });

    it("a required Requirement the profile meets", () => {
      const result = rank(
        { requirements: [required("smoking", "non_smoker")] },
        { smoker: false, diet: "omnivore" as const },
      );
      expect(result.band).toBe("match");
      expect(reasonFor(result, "requirements")).toMatchObject({ outcome: "pass" });
      expect(result.chips).toContainEqual(expect.objectContaining({ tone: "ok" }));
    });

    it("a vegan Requirement is met by a vegan, and a vegetarian one too", () => {
      expect(
        rank({ requirements: [required("diet", "vegetarian")] }, { diet: "vegan", smoker: true })
          .band,
      ).toBe("match");
    });
  });

  it("passes when the model found no Requirements", () => {
    expect(rank({ requirements: [] }, { diet: "omnivore" }).band).toBe("match");
  });

  it("is a Near match when no model has read the text yet", () => {
    const result = rank({}, { diet: "omnivore" });
    expect(result.band).toBe("near-match");
    expect(reasonFor(result, "requirements")?.cause).toBe("unknown");
  });

  it("is a Near match when a Doubtful required Requirement is met", () => {
    const result = rank(
      {
        requirements: [doubtful({ kind: "smoking", strictness: "required", value: "non_smoker" })],
      },
      { smoker: false, diet: "omnivore" as const },
    );
    expect(result.band).toBe("near-match");
  });

  it("ignores a Requirement whose value is unknown", () => {
    expect(rank({ requirements: [fact("unknown")] }, { diet: "omnivore" }).band).toBe("match");
  });

  it("does not apply to a 1-room flat, but does to a flat offered as a WG", () => {
    const facts = { requirements: [required("diet", "vegan")] };
    const profile = { diet: "omnivore" as const };
    expect(rank(facts, profile, {}, { category: "one-room-flat" }).band).toBe("match");
    expect(rank(facts, profile, {}, { category: "flat" }).band).toBe("match");
    expect(
      rank({ ...facts, offeredAsWg: fact(true) }, profile, {}, { category: "flat" }).band,
    ).toBe("hidden");
  });
});
