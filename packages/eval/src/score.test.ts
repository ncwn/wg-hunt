import type { CombinedFacts } from "@wg-hunt/core";
import { describe, expect, it } from "vitest";
import { scoreFacts } from "./score.js";

const field = (value: unknown) => ({ value, origin: "field", quote: "q" });
const text = (value: unknown) => ({ value, origin: "text", quote: "q" });

const facts = (extra: Record<string, unknown>) => extra as unknown as CombinedFacts;

describe("scoring labels against the combined Offer Facts", () => {
  it("scores a scalar fact right or wrong by its value", () => {
    const scores = scoreFacts(
      { anmeldung: "possible", minimumStay: 6 },
      facts({ anmeldung: text("not_possible"), minimumStay: text(6) }),
    );
    expect(scores.map((s) => [s.key, s.correct])).toEqual([
      ["anmeldung", false],
      ["minimumStay", true],
    ]);
    expect(scores[0]).toMatchObject({ expected: "possible", actual: "not_possible" });
  });

  it("reads a missing fact as unknown, so a label of unknown is right about it", () => {
    const [score] = scoreFacts({ anmeldung: "unknown" }, facts({}));
    expect(score?.correct).toBe(true);
  });

  it("compares objects such as a one-sided age range or a converted rent exactly", () => {
    const scores = scoreFacts(
      { ageSought: { min: 25 }, warmRent: { amount: 2100, converted: true } },
      facts({
        ageSought: field({ min: 25 }),
        warmRent: field({ amount: 2100, converted: false }),
      }),
    );
    expect(scores.map((s) => s.correct)).toEqual([true, false]);
  });

  it("compares a gender sought as a set, whatever order it is written in", () => {
    const [score] = scoreFacts(
      { genderSought: ["woman", "diverse"] },
      facts({ genderSought: text(["diverse", "woman"]) }),
    );
    expect(score?.correct).toBe(true);
  });

  it("compares Requirements as a set of kind, strictness and value", () => {
    const vegan = { kind: "diet", strictness: "required", value: "vegan" };
    const student = { kind: "occupation", strictness: "required", value: "student" };
    const nonSmoker = { kind: "smoking", strictness: "preferred", value: "non_smoker" };
    const score = (found: unknown[]) =>
      scoreFacts({ requirements: [vegan, student] }, facts({ requirements: found.map(text) }))[0];

    expect(score([student, vegan, "unknown"])).toMatchObject({
      correct: true,
      actual: [student, vegan],
    });
    expect(score([vegan])?.correct).toBe(false);
    expect(score([vegan, student, nonSmoker])?.correct).toBe(false);
    expect(score([vegan, nonSmoker])?.correct).toBe(false);
    expect(score([vegan, vegan])?.correct).toBe(false);
  });

  it("compares Scam signals and conflicts as sets of kinds and field names", () => {
    const scores = scoreFacts(
      {
        scamSignals: ["keys_by_post", "money_before_viewing"],
        conflicts: ["warmRent"],
      },
      facts({
        scamSignals: [text("money_before_viewing"), text("keys_by_post")],
        conflicts: [text({ factKey: "warmRent", textValue: "450" })],
      }),
    );
    expect(scores.map((s) => s.correct)).toEqual([true, true]);
  });

  it("treats an absent list as an empty one", () => {
    const [score] = scoreFacts({ scamSignals: [] }, facts({}));
    expect(score?.correct).toBe(true);
  });
});
