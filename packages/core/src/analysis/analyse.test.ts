import { describe, expect, it } from "vitest";
import type { OfferText } from "../source/source.js";
import { analyseOffer } from "./analyse.js";
import type { ModelChoice } from "./provider.js";
import { emptyOutput, fakeProvider, outputWith, sure, unsure } from "./testing.js";

const FIRST: ModelChoice = { model: "claude-haiku-5-5", effort: "medium" };
const SECOND: ModelChoice = { model: "claude-haiku-5-5", effort: "high" };

const text: OfferText = {
  title: "Helles Zimmer in ruhiger WG",
  sections: [
    { label: "Zimmer", text: "Das Zimmer ist hell und möbliert. Anmeldung ist möglich." },
    { label: "WG-Leben", text: "Wir kochen gern zusammen. Nur Frauen, bitte." },
    { label: "Sonstiges", text: "Mindestmietdauer 6 Monate. Schlüssel per Post ist leider nötig." },
  ],
};

const base = {
  text,
  category: "flatshare-room" as const,
  ruleFacts: {},
  model: FIRST,
  escalation: SECOND as ModelChoice | null,
  sleep: async () => {},
};

describe("a confident first pass", () => {
  it("turns what the model read into text-origin facts, without escalating", async () => {
    const { provider, requests } = fakeProvider([
      outputWith({ anmeldung: { value: "possible", ...sure("Anmeldung ist möglich") } }),
    ]);

    const plain: OfferText = {
      title: "Zimmer",
      sections: [{ label: "Zimmer", text: "Hell und möbliert. Anmeldung ist möglich." }],
    };

    const result = await analyseOffer({ ...base, text: plain, provider });

    expect(requests).toHaveLength(1);
    expect(result.escalated).toBe(false);
    expect(result.facts.anmeldung).toEqual({
      value: "possible",
      origin: "text",
      quote: "Anmeldung ist möglich",
      confidence: { status: "confident" },
    });
  });

  it("keeps a fact the model does not find as unknown and quote-less", async () => {
    const { provider } = fakeProvider([emptyOutput()]);
    const quiet: OfferText = { title: "Zimmer", sections: [{ label: "Zimmer", text: "Hell." }] };

    const result = await analyseOffer({ ...base, text: quiet, provider });

    expect(result.facts.anmeldung).toEqual({
      value: "unknown",
      origin: "text",
      quote: "",
      confidence: { status: "confident" },
    });
    expect(result.facts.requirements).toEqual([]);
    expect(result.escalated).toBe(false);
  });

  it("is the model-pass setting the provider is asked to run", async () => {
    const { provider, requests } = fakeProvider([emptyOutput()]);
    const quiet: OfferText = { title: "Zimmer", sections: [] };

    await analyseOffer({ ...base, text: quiet, provider });

    expect(requests[0]).toMatchObject({ model: "claude-haiku-5-5", effort: "medium" });
  });
});

describe("Doubtful", () => {
  it("when the quote is not an exact substring of the Offer's text", async () => {
    const { provider } = fakeProvider([
      outputWith({ anmeldung: { value: "possible", ...sure("Anmeldung ist problemlos möglich") } }),
    ]);

    const result = await analyseOffer({ ...base, escalation: null, provider });

    expect(result.facts.anmeldung).toMatchObject({
      value: "unknown",
      quote: "",
      confidence: { status: "doubtful", reasons: ["quote_not_found"] },
    });
    expect(result.log).toContainEqual(
      expect.objectContaining({ fact: "anmeldung", event: "quote_not_found", tier: 1 }),
    );
  });

  it("when the model flags the fact as ambiguous", async () => {
    const { provider } = fakeProvider([
      outputWith({
        anmeldung: {
          value: "conditional",
          ...unsure("Anmeldung ist möglich", "only after a trial"),
        },
      }),
    ]);

    const result = await analyseOffer({ ...base, escalation: null, provider });

    expect(result.facts.anmeldung).toMatchObject({
      value: "conditional",
      quote: "Anmeldung ist möglich",
      confidence: { status: "doubtful", reasons: ["model_ambiguous"] },
    });
  });

  it.each([
    ["Anmeldung", "anmeldung"],
    ["Mindestmietdauer", "minimumStay"],
  ] as const)(
    "when the model says unknown but the keyword %s is in the text",
    async (_word, fact) => {
      const { provider } = fakeProvider([emptyOutput()]);

      const result = await analyseOffer({ ...base, escalation: null, provider });

      expect(result.facts[fact]).toMatchObject({
        value: "unknown",
        confidence: { status: "doubtful", reasons: ["keyword_tripwire"] },
      });
      const quote = (result.facts[fact] as { quote: string }).quote;
      expect(quote).not.toBe("");
      expect(text.sections.some((section) => section.text.includes(quote))).toBe(true);
    },
  );

  it("when 'Schlüssel per Post' is in the text and no keys-by-post Scam signal was found", async () => {
    const { provider } = fakeProvider([emptyOutput()]);

    const result = await analyseOffer({ ...base, escalation: null, provider });

    expect(result.facts.scamSignals).toEqual([
      expect.objectContaining({
        value: "unknown",
        confidence: { status: "doubtful", reasons: ["keyword_tripwire"] },
        quote: expect.stringContaining("Schlüssel per Post"),
      }),
    ]);
  });

  it("does not fire a tripwire when the model found the fact", async () => {
    const { provider } = fakeProvider([
      outputWith({
        anmeldung: { value: "possible", ...sure("Anmeldung ist möglich") },
        minimumStay: { value: "stated", months: 6, ...sure("Mindestmietdauer 6 Monate") },
        scamSignals: [{ kind: "keys_by_post", ...sure("Schlüssel per Post ist leider nötig") }],
      }),
    ]);

    const result = await analyseOffer({ ...base, provider });

    expect(result.escalated).toBe(false);
    expect(result.facts.minimumStay).toMatchObject({ value: 6, origin: "text" });
    expect(result.facts.scamSignals).toHaveLength(1);
  });
});

describe("conflicts", () => {
  it("keeps a rent conflict and drops one about gender, which the text's own reading covers", async () => {
    const { provider } = fakeProvider([
      outputWith({
        conflicts: [
          { factKey: "genderSought", textValue: "everyone", ...sure("Nur Frauen, bitte.") },
          { factKey: "warmRent", textValue: "520", ...sure("Mindestmietdauer 6 Monate.") },
        ],
      }),
    ]);

    const result = await analyseOffer({ ...base, provider });

    expect(result.facts.conflicts?.map((fact) => fact.value)).toEqual([
      { factKey: "warmRent", textValue: "520" },
    ]);
  });
});
