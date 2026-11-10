import { describe, expect, it } from "vitest";
import { offerFactsSchema, type RuleFacts } from "../offer-facts/index.js";
import type { OfferText } from "../source/source.js";
import { analyseOffer } from "./analyse.js";
import { combineOfferFacts } from "./combine.js";
import type { ModelFacts } from "./model-facts.js";
import { fakeProvider, outputWith, sure } from "./testing.js";

const text: OfferText = {
  title: "Zimmer",
  sections: [
    { label: "WG-Leben", text: "Wir sind eine nette WG. Nur Frauen, bitte. Miete 500 Euro." },
  ],
};

const confident = { status: "confident" as const };

function modelFacts(over: Partial<ModelFacts>): ModelFacts {
  return {
    anmeldung: { value: "unknown", origin: "text", quote: "", confidence: confident },
    minimumStay: { value: "unknown", origin: "text", quote: "", confidence: confident },
    scamSignals: [],
    conflicts: [],
    ...over,
  };
}

const field = (value: unknown, quote: string) => ({ value, origin: "field" as const, quote });

describe("gender sought: the field and the text", () => {
  it("takes the stricter reading, with the field in alternatives ('Geschlecht egal' and 'nur Frauen')", async () => {
    const ruleFacts = {
      genderSought: field("any", "Geschlecht egal"),
    } as RuleFacts;
    const { provider } = fakeProvider([
      outputWith({
        genderSoughtFromText: { value: "only", only: ["woman"], ...sure("Nur Frauen, bitte") },
      }),
    ]);

    const analysis = await analyseOffer({
      provider,
      text,
      category: "flatshare-room",
      ruleFacts,
      model: { model: "claude-haiku-5-5", effort: "medium" },
      escalation: null,
      sleep: async () => {},
    });
    const facts = combineOfferFacts({
      category: "flatshare-room",
      ruleFacts,
      modelFacts: analysis.facts,
    });

    expect(facts.genderSought).toEqual({
      value: ["woman"],
      origin: "text",
      quote: "Nur Frauen, bitte",
      confidence: { status: "confident" },
      alternatives: [{ value: "any", origin: "field", quote: "Geschlecht egal" }],
    });
  });

  it("keeps a stricter field and notes the text's looser reading as the alternative", () => {
    const facts = combineOfferFacts({
      category: "flatshare-room",
      ruleFacts: { genderSought: field(["woman"], "gesucht: Frau") } as RuleFacts,
      modelFacts: modelFacts({
        genderSoughtText: {
          value: "any",
          origin: "text",
          quote: "Alle sind willkommen",
          confidence: confident,
        },
      }),
    });

    expect(facts.genderSought).toEqual({
      value: ["woman"],
      origin: "field",
      quote: "gesucht: Frau",
      alternatives: [{ value: "any", origin: "text", quote: "Alle sind willkommen" }],
    });
  });

  it("changes nothing when the text agrees with the field", () => {
    const ruleFacts = { genderSought: field(["woman"], "gesucht: Frau") } as RuleFacts;
    const facts = combineOfferFacts({
      category: "flatshare-room",
      ruleFacts,
      modelFacts: modelFacts({
        genderSoughtText: {
          value: ["woman"],
          origin: "text",
          quote: "Nur Frauen",
          confidence: confident,
        },
      }),
    });

    expect(facts.genderSought).toEqual(ruleFacts.genderSought);
  });

  it("keeps the field when the text names someone else entirely, and records what the text said", () => {
    const facts = combineOfferFacts({
      category: "flatshare-room",
      ruleFacts: { genderSought: field(["woman"], "gesucht: Frau") } as RuleFacts,
      modelFacts: modelFacts({
        genderSoughtText: {
          value: ["man"],
          origin: "text",
          quote: "Nur Männer",
          confidence: confident,
        },
      }),
    });

    expect(facts.genderSought).toMatchObject({
      value: ["woman"],
      origin: "field",
      alternatives: [{ value: ["man"], origin: "text", quote: "Nur Männer" }],
    });
  });

  it("uses the text when no field says who is sought", () => {
    const facts = combineOfferFacts({
      category: "flatshare-room",
      ruleFacts: {},
      modelFacts: modelFacts({
        genderSoughtText: {
          value: ["man"],
          origin: "text",
          quote: "Nur Männer",
          confidence: confident,
        },
      }),
    });

    expect(facts.genderSought).toMatchObject({ value: ["man"], origin: "text" });
    expect(facts.genderSought?.alternatives).toBeUndefined();
  });

  it("keeps a Doubtful text reading Doubtful when it wins", () => {
    const doubtful = {
      status: "doubtful" as const,
      reasons: ["model_ambiguous" as const],
    };
    const facts = combineOfferFacts({
      category: "flatshare-room",
      ruleFacts: { genderSought: field("any", "Geschlecht egal") } as RuleFacts,
      modelFacts: modelFacts({
        genderSoughtText: {
          value: ["woman"],
          origin: "text",
          quote: "Eher Frauen",
          confidence: doubtful,
        },
      }),
    });

    expect(facts.genderSought).toMatchObject({ value: ["woman"], confidence: doubtful });
  });

  it("leaves a flat that is not offered as a WG without gender sought", () => {
    const facts = combineOfferFacts({
      category: "flat",
      ruleFacts: {},
      modelFacts: modelFacts({}),
    });

    expect(facts.genderSought).toBeUndefined();
  });
});

describe("rent: the field always wins", () => {
  const ruleFacts = {
    baseRent: field({ amount: 450, converted: false }, "Miete: 450€"),
  } as RuleFacts;
  const conflict = {
    value: { factKey: "baseRent" as const, textValue: "500 Euro" },
    origin: "text" as const,
    quote: "Miete 500 Euro",
    confidence: confident,
  };

  it("leaves the field's rent and puts the text's into alternatives", () => {
    const facts = combineOfferFacts({
      category: "flatshare-room",
      ruleFacts,
      modelFacts: modelFacts({ conflicts: [conflict] }),
    });

    expect(facts.baseRent).toEqual({
      value: { amount: 450, converted: false },
      origin: "field",
      quote: "Miete: 450€",
      alternatives: [
        { value: { amount: 500, converted: false }, origin: "text", quote: "Miete 500 Euro" },
      ],
    });
    expect(facts.conflicts).toHaveLength(1);
  });

  it("reads German number formats", () => {
    const facts = combineOfferFacts({
      category: "flatshare-room",
      ruleFacts,
      modelFacts: modelFacts({
        conflicts: [{ ...conflict, value: { factKey: "baseRent", textValue: "1.250,50 €" } }],
      }),
    });

    expect(facts.baseRent?.alternatives?.[0]?.value).toEqual({ amount: 1250.5, converted: false });
  });

  it("ignores a text rent it cannot read as a number", () => {
    const facts = combineOfferFacts({
      category: "flatshare-room",
      ruleFacts,
      modelFacts: modelFacts({
        conflicts: [{ ...conflict, value: { factKey: "baseRent", textValue: "günstig" } }],
      }),
    });

    expect(facts.baseRent).toEqual(ruleFacts.baseRent);
  });
});

describe("the combined facts", () => {
  it("carry the model facts beside the rule facts and still satisfy the Offer Facts schema", () => {
    const ruleFacts = { genderSought: field("any", "Geschlecht egal") } as RuleFacts;
    const facts = combineOfferFacts({
      category: "flatshare-room",
      ruleFacts,
      modelFacts: modelFacts({
        genderSoughtText: {
          value: ["woman"],
          origin: "text",
          quote: "Nur Frauen",
          confidence: confident,
        },
        requirements: [
          {
            value: { kind: "diet", strictness: "required", value: "vegan" },
            origin: "text",
            quote: "vegan",
            confidence: confident,
          },
        ],
      }),
    });

    expect(offerFactsSchema.parse({ category: "flatshare-room", ...facts })).toBeDefined();
    expect(Object.keys(facts)).toEqual(
      expect.arrayContaining(["genderSought", "anmeldung", "minimumStay", "requirements"]),
    );
  });

  it("are the rule facts alone for an Offer the model has not read", () => {
    const ruleFacts = { genderSought: field("any", "Geschlecht egal") } as RuleFacts;

    expect(combineOfferFacts({ category: "flatshare-room", ruleFacts })).toEqual(ruleFacts);
  });
});
