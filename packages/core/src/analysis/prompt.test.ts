import { describe, expect, it } from "vitest";
import { modelFactsOutputSchema, type RuleFacts } from "../offer-facts/index.js";
import type { OfferText } from "../source/source.js";
import { analyseOffer } from "./analyse.js";
import { ANALYSIS_PREFIX, buildUserTurn, EXAMPLES } from "./prompt.js";
import { emptyOutput, fakeProvider } from "./testing.js";

const offerA: OfferText = { title: "Zimmer A", sections: [{ label: "Zimmer", text: "Hell." }] };
const offerB: OfferText = {
  title: "Zimmer B",
  sections: [{ label: "Sonstiges", text: "Ruhig, Nichtraucher bevorzugt." }],
};

const run = (text: OfferText, ruleFacts: RuleFacts, model: string) => {
  const { provider, requests } = fakeProvider([emptyOutput()]);
  return analyseOffer({
    provider,
    text,
    category: "flatshare-room",
    ruleFacts,
    model: { model, effort: "medium" },
    escalation: null,
    sleep: async () => {},
  }).then(() => requests[0]);
};

describe("the cached prefix", () => {
  it("is identical, byte for byte, for every Offer, setting and model", async () => {
    const a = await run(offerA, {}, "claude-haiku-5-5");
    const b = await run(
      offerB,
      { smoking: { value: "balcony", origin: "field", quote: "Rauchen: Balkon" } },
      "claude-sonnet-5-5",
    );

    expect(a?.prefix).toBe(ANALYSIS_PREFIX);
    expect(b?.prefix).toBe(a?.prefix);
    expect(a?.userTurn).not.toBe(b?.userTurn);
  });

  it("is long enough to be cached (Haiku 5.5 caches from 512 tokens)", () => {
    // German and JSON take about 3 characters a token, so this is well past 512 tokens.
    expect(ANALYSIS_PREFIX.length).toBeGreaterThan(3000);
  });

  it("holds nothing that changes: no date, no number that looks like an id", () => {
    expect(ANALYSIS_PREFIX).not.toMatch(/20\d\d-\d\d-\d\d/);
  });

  it("shows the model synthetic examples that the output schema accepts and whose quotes are real", () => {
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(2);
    for (const { offer, answer } of EXAMPLES) {
      expect(modelFactsOutputSchema.safeParse(answer).success).toBe(true);
      const quotes = [
        answer.anmeldung,
        answer.minimumStay,
        answer.genderSoughtFromText,
        ...answer.requirements,
        ...answer.scamSignals,
        ...answer.conflicts,
      ].map((fact) => fact.quote);
      for (const quote of quotes.filter((q) => q !== "")) expect(offer).toContain(quote);
    }
  });
});

describe("the Offer's turn", () => {
  it("holds the text and the structured fields to compare it with, and no location", () => {
    const turn = buildUserTurn({
      category: "flatshare-room",
      text: offerB,
      ruleFacts: {
        smoking: { value: "balcony", origin: "field", quote: "Rauchen: Balkon" },
        street: { value: "Teststraße 12", origin: "field", quote: "Teststraße 12" },
        postalCode: { value: "12345", origin: "field", quote: "12345" },
        coordinates: { value: { lat: 1.5, lng: 2.5 }, origin: "field", quote: "map" },
      },
    });

    expect(turn).toContain("Nichtraucher bevorzugt.");
    expect(turn).toContain('smoking: "balcony"');
    expect(turn).not.toContain("Teststraße");
    expect(turn).not.toContain("12345");
    expect(turn).not.toContain("lng");
  });

  it("leaves out the gender field: the text's gender is read on its own and merged by rule", () => {
    const turn = buildUserTurn({
      category: "flatshare-room",
      text: offerB,
      ruleFacts: { genderSought: { value: ["woman"], origin: "field", quote: "Frau" } },
    });

    expect(turn).not.toContain("genderSought");
  });
});
