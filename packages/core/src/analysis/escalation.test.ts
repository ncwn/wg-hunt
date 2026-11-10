import { describe, expect, it } from "vitest";
import type { OfferText } from "../source/source.js";
import { analyseOffer } from "./analyse.js";
import { type ModelChoice, ProviderError } from "./provider.js";
import { fakeProvider, outputWith, sure, unsure } from "./testing.js";

const FIRST: ModelChoice = { model: "claude-haiku-5-5", effort: "medium" };
const SECOND: ModelChoice = { model: "claude-sonnet-5-5", effort: "high" };

const text: OfferText = {
  title: "Zimmer in WG",
  sections: [
    {
      label: "Zimmer",
      text: "Das Zimmer ist hell. Anmeldung ist möglich. Mindestens 6 Monate bitte. Nur Studenten.",
    },
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

const anmeldung = (value: "possible" | "not_possible", quote: string) => ({
  value,
  ...sure(quote),
});
const stay = { value: "stated" as const, months: 6, ...sure("Mindestens 6 Monate") };
const student = {
  kind: "occupation" as const,
  strictness: "required" as const,
  value: "student",
  ...sure("Nur Studenten"),
};

describe("escalation", () => {
  it("re-reads the whole Offer at the escalation setting when a fact is Doubtful", async () => {
    const { provider, requests } = fakeProvider([
      outputWith({
        anmeldung: { value: "possible", ...unsure("Anmeldung ist möglich") },
        minimumStay: stay,
        requirements: [student],
      }),
      outputWith({
        anmeldung: anmeldung("possible", "Anmeldung ist möglich"),
        minimumStay: stay,
        requirements: [student],
      }),
    ]);

    const result = await analyseOffer({ ...base, provider });

    expect(requests.map((r) => [r.model, r.effort])).toEqual([
      ["claude-haiku-5-5", "medium"],
      ["claude-sonnet-5-5", "high"],
    ]);
    expect(result.escalated).toBe(true);
    expect(result.facts.anmeldung.confidence).toEqual({ status: "confident" });
    expect(result.facts.requirements?.[0]?.confidence).toEqual({ status: "confident" });
  });

  it("sends the same prefix and Offer turn to both passes", async () => {
    const { provider, requests } = fakeProvider([
      outputWith({ anmeldung: { value: "possible", ...unsure("Anmeldung ist möglich") } }),
      outputWith({ anmeldung: anmeldung("possible", "Anmeldung ist möglich") }),
    ]);

    await analyseOffer({ ...base, provider });

    expect(requests[1]?.prefix).toBe(requests[0]?.prefix);
    expect(requests[1]?.userTurn).toBe(requests[0]?.userTurn);
  });

  it("does not escalate when escalation is off", async () => {
    const { provider, requests } = fakeProvider([
      outputWith({ anmeldung: { value: "possible", ...unsure("Anmeldung ist möglich") } }),
    ]);

    const result = await analyseOffer({ ...base, escalation: null, provider });

    expect(requests).toHaveLength(1);
    expect(result.escalated).toBe(false);
    expect(result.facts.anmeldung.confidence?.status).toBe("doubtful");
  });

  describe("per-fact merge", () => {
    it("keeps the escalation value and marks a confident first value that it disagrees with as 'tiers disagree'", async () => {
      const { provider } = fakeProvider([
        outputWith({
          anmeldung: anmeldung("possible", "Anmeldung ist möglich"),
          minimumStay: { ...stay, ...unsure("Mindestens 6 Monate") },
        }),
        outputWith({
          anmeldung: anmeldung("not_possible", "Anmeldung ist möglich"),
          minimumStay: stay,
        }),
      ]);

      const result = await analyseOffer({ ...base, provider });

      expect(result.facts.anmeldung).toMatchObject({
        value: "not_possible",
        confidence: { status: "doubtful", reasons: ["tiers_disagree"] },
      });
      expect(result.facts.minimumStay).toMatchObject({
        value: 6,
        confidence: { status: "confident" },
      });
      expect(result.log).toContainEqual(
        expect.objectContaining({ fact: "anmeldung", event: "tiers_disagree", tier: 2 }),
      );
    });

    it("stays confident when both passes read the same value", async () => {
      const { provider } = fakeProvider([
        outputWith({
          anmeldung: anmeldung("possible", "Anmeldung ist möglich"),
          minimumStay: { ...stay, ...unsure("Mindestens 6 Monate") },
        }),
        outputWith({
          anmeldung: anmeldung("possible", "Anmeldung ist möglich"),
          minimumStay: stay,
        }),
      ]);

      const result = await analyseOffer({ ...base, provider });

      expect(result.facts.anmeldung.confidence).toEqual({ status: "confident" });
    });

    it("keeps a Requirement only the first pass found, but Doubtful, since the second did not find it", async () => {
      const { provider } = fakeProvider([
        outputWith({
          requirements: [student],
          minimumStay: { ...stay, ...unsure("Mindestens 6 Monate") },
        }),
        outputWith({ minimumStay: stay }),
      ]);

      const result = await analyseOffer({ ...base, provider });

      expect(result.facts.requirements).toEqual([
        expect.objectContaining({
          value: { kind: "occupation", strictness: "required", value: "student" },
          confidence: { status: "doubtful", reasons: ["tiers_disagree"] },
        }),
      ]);
    });

    it("drops a Requirement the first pass doubted and the second did not find", async () => {
      const { provider } = fakeProvider([
        outputWith({ requirements: [{ ...student, ambiguous: true, ambiguityReason: "unclear" }] }),
        outputWith({}),
      ]);

      const result = await analyseOffer({ ...base, provider });

      expect(result.facts.requirements).toEqual([]);
    });

    it("resolves a keyword tripwire's Doubtful unknown when the second pass finds the fact", async () => {
      const vegan: OfferText = {
        title: "Zimmer",
        sections: [{ label: "WG", text: "Anmeldung ist möglich. Wir sind eine vegane WG." }],
      };
      const found = {
        kind: "diet" as const,
        strictness: "required" as const,
        value: "vegan",
        ...sure("Wir sind eine vegane WG"),
      };
      const { provider } = fakeProvider([
        outputWith({}),
        outputWith({
          anmeldung: anmeldung("possible", "Anmeldung ist möglich"),
          requirements: [found],
        }),
      ]);

      const result = await analyseOffer({ ...base, text: vegan, provider });

      expect(result.escalated).toBe(true);
      expect(result.facts.anmeldung).toMatchObject({
        value: "possible",
        confidence: { status: "confident" },
      });
      expect(result.facts.requirements).toEqual([
        expect.objectContaining({
          value: { kind: "diet", strictness: "required", value: "vegan" },
          confidence: { status: "confident" },
        }),
      ]);
    });
  });

  describe("still Doubtful after the last pass", () => {
    it("turns a value whose quote was never found into unknown, and logs the attempt", async () => {
      const wrong = anmeldung("possible", "Anmeldung kein Problem");
      const { provider } = fakeProvider([
        outputWith({ anmeldung: wrong }),
        outputWith({ anmeldung: wrong }),
      ]);

      const result = await analyseOffer({ ...base, provider });

      expect(result.facts.anmeldung).toMatchObject({
        value: "unknown",
        quote: "",
        confidence: { status: "doubtful", reasons: ["quote_not_found"] },
      });
      expect(result.log).toContainEqual(
        expect.objectContaining({
          fact: "anmeldung",
          event: "quote_not_found",
          tier: 2,
          quote: "Anmeldung kein Problem",
        }),
      );
    });

    it("keeps the value, marked Doubtful, for any other reason", async () => {
      const shaky = { value: "conditional" as const, ...unsure("Anmeldung ist möglich") };
      const { provider } = fakeProvider([
        outputWith({ anmeldung: shaky }),
        outputWith({ anmeldung: shaky }),
      ]);

      const result = await analyseOffer({ ...base, provider });

      expect(result.facts.anmeldung).toMatchObject({
        value: "conditional",
        quote: "Anmeldung ist möglich",
        confidence: { status: "doubtful", reasons: ["model_ambiguous"] },
      });
    });

    it("does not trust a second pass that found the quote no more than the first", async () => {
      const { provider } = fakeProvider([
        outputWith({ anmeldung: anmeldung("possible", "Anmeldung kein Problem") }),
        outputWith({ anmeldung: anmeldung("not_possible", "Anmeldung kein Thema") }),
      ]);

      const result = await analyseOffer({ ...base, provider });

      expect(result.facts.anmeldung.value).toBe("unknown");
    });
  });
});

describe("a value that contradicts a structured field", () => {
  const withSmoking = (conflicts: Parameters<typeof outputWith>[0]["conflicts"] = []) =>
    outputWith({
      anmeldung: anmeldung("possible", "Anmeldung ist möglich"),
      requirements: [
        {
          kind: "smoking",
          strictness: "required",
          value: "non_smoker",
          ...sure("Das Zimmer ist hell"),
        },
      ],
      conflicts,
    });
  const ruleFacts = {
    smoking: { value: "anywhere" as const, origin: "field" as const, quote: "Rauchen: überall" },
  };

  it("is Doubtful when the contradiction is not recorded as a conflict", async () => {
    const { provider } = fakeProvider([withSmoking()]);

    const result = await analyseOffer({ ...base, escalation: null, ruleFacts, provider });

    expect(result.facts.requirements?.[0]?.confidence).toEqual({
      status: "doubtful",
      reasons: ["contradicts_field"],
    });
  });

  it("is not Doubtful when the model recorded the conflict", async () => {
    const { provider } = fakeProvider([
      withSmoking([
        { factKey: "smoking", textValue: "non_smoker", ...sure("Das Zimmer ist hell") },
      ]),
    ]);

    const result = await analyseOffer({ ...base, escalation: null, ruleFacts, provider });

    expect(result.facts.requirements?.[0]?.confidence).toEqual({ status: "confident" });
    expect(result.facts.conflicts).toHaveLength(1);
  });
});

describe("API errors", () => {
  it("retries three times with a growing wait, then gives up", async () => {
    const { provider, requests } = fakeProvider(() => new ProviderError("overloaded"));
    const waits: number[] = [];

    await expect(
      analyseOffer({
        ...base,
        provider,
        sleep: async (ms) => {
          waits.push(ms);
        },
      }),
    ).rejects.toMatchObject({ kind: "overloaded" });

    expect(requests).toHaveLength(4);
    expect(waits).toEqual([1000, 2000, 4000]);
  });

  it("goes on with the answer of a retry that works", async () => {
    const { provider, requests } = fakeProvider((call) =>
      call < 2 ? new ProviderError("rate_limited") : outputWith({}),
    );
    const quiet: OfferText = { title: "Zimmer", sections: [] };

    const result = await analyseOffer({ ...base, text: quiet, provider });

    expect(requests).toHaveLength(3);
    expect(result.escalated).toBe(false);
  });

  it("does not retry what no retry can fix", async () => {
    const { provider, requests } = fakeProvider(() => new ProviderError("unauthorized"));

    await expect(analyseOffer({ ...base, provider })).rejects.toMatchObject({
      kind: "unauthorized",
    });
    expect(requests).toHaveLength(1);
  });

  it("is not escalation: a failure is never read as a Doubtful fact", async () => {
    const { provider, requests } = fakeProvider(() => new ProviderError("server_error"));

    await expect(analyseOffer({ ...base, provider })).rejects.toBeInstanceOf(ProviderError);
    expect(new Set(requests.map((r) => r.model))).toEqual(new Set([FIRST.model]));
  });

  it("fails the Offer when the escalation pass fails for good", async () => {
    const { provider } = fakeProvider((call) =>
      call === 0
        ? outputWith({ anmeldung: { value: "possible", ...unsure("Anmeldung ist möglich") } })
        : new ProviderError("network"),
    );

    await expect(analyseOffer({ ...base, provider })).rejects.toMatchObject({ kind: "network" });
  });
});
