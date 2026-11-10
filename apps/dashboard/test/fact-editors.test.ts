import { describe, expect, expectTypeOf, it } from "vitest";
import {
  DOUBTFUL_REASONS,
  type DoubtfulReason,
} from "../../../packages/core/src/offer-facts/fact.js";
import { type RuleFacts, ruleFactShape } from "../../../packages/core/src/offer-facts/schema.js";
import {
  anmeldungValue,
  REQUIREMENT_KINDS,
  requirementValue,
  SCAM_SIGNAL_KINDS,
  smokingValue,
  strictnessSchema,
} from "../../../packages/core/src/offer-facts/values.js";
import { DOUBTFUL_REASON_LABELS } from "../src/analysis.js";
import {
  type ANMELDUNG,
  editorFor,
  type OFFER_LANGUAGES,
  offersUnknown,
  type SMOKING,
} from "../src/fact-editors.js";

describe("the Doubtful reasons", () => {
  it("has words for every reason core gives, in core's order: add one here when core adds a reason", () => {
    expect(Object.keys(DOUBTFUL_REASON_LABELS)).toEqual([...DOUBTFUL_REASONS]);
    expectTypeOf<keyof typeof DOUBTFUL_REASON_LABELS>().toEqualTypeOf<DoubtfulReason>();
  });
});

describe("the choice editors core has no API enum for", () => {
  const choices = (key: string) => {
    const editor = editorFor(key);
    if (editor.kind !== "choice") throw new Error(`${key} is not a choice`);
    return editor.options.map((option) => option.value);
  };

  it("offers core's Anmeldung values: add one here when core adds a value", () => {
    expect(choices("anmeldung")).toEqual(anmeldungValue.options);
    expectTypeOf<(typeof ANMELDUNG)[number]>().toEqualTypeOf<
      (typeof anmeldungValue.options)[number]
    >();
  });

  it("offers core's smoking values: add one here when core adds a value", () => {
    expect(choices("smoking")).toEqual(smokingValue.options);
    expectTypeOf<(typeof SMOKING)[number]>().toEqualTypeOf<(typeof smokingValue.options)[number]>();
  });

  it("offers core's ad languages: add one here when core adds a value", () => {
    const value = ruleFactShape.offerLanguage.shape.value.options[0];
    expect(choices("offerLanguage")).toEqual(value.options);
    expectTypeOf<(typeof OFFER_LANGUAGES)[number]>().toEqualTypeOf<
      Exclude<NonNullable<RuleFacts["offerLanguage"]>["value"], "unknown">
    >();
  });
});

describe("the Scam signals editor", () => {
  it("offers every Scam signal core reads from the text, in core's order: add a label here when core adds a kind", () => {
    const editor = editorFor("scamSignals");
    expect(editor.kind).toBe("checklist");
    if (editor.kind !== "checklist") return;
    expect(editor.options.map((option) => option.value)).toEqual([...SCAM_SIGNAL_KINDS]);
    for (const option of editor.options) expect(option.label).not.toMatch(/_/);
  });
});

describe("the Requirements editor", () => {
  const coreValues = new Map(
    requirementValue.options.map((option) => {
      const value = option.shape.value as unknown as { options?: string[]; value?: string };
      const allowed = value.options ?? (value.value === undefined ? "text" : [value.value]);
      return [option.shape.kind.value as string, allowed] as const;
    }),
  );

  it("offers every Requirement kind core knows, in core's order: add one here when core adds a kind", () => {
    const editor = editorFor("requirements");
    expect(editor.kind).toBe("requirements");
    if (editor.kind !== "requirements") return;
    expect(editor.kinds.map((kind) => kind.kind)).toEqual([...REQUIREMENT_KINDS]);
    expect(editor.strictness.map((option) => option.value)).toEqual(strictnessSchema.options);
    for (const label of [...editor.kinds, ...editor.strictness].map((item) => item.label)) {
      expect(label).not.toMatch(/_/);
    }
  });

  it("gives each kind the values core allows for it", () => {
    const editor = editorFor("requirements");
    if (editor.kind !== "requirements") throw new Error("not the Requirements editor");
    for (const { kind, value } of editor.kinds) {
      const allowed = coreValues.get(kind);
      switch (value.kind) {
        case "choice":
          expect(
            value.options.map((option) => option.value),
            kind,
          ).toEqual(allowed);
          break;
        case "implied":
          expect([value.value], kind).toEqual(allowed);
          break;
        case "language":
        case "text":
          expect(allowed, kind).toBe("text");
          break;
      }
    }
  });

  it("is a list, so the form doesn't offer Set to unknown", () => {
    expect(offersUnknown(editorFor("requirements"))).toBe(false);
  });
});
