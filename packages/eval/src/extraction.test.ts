import { type AnalysisProvider, ProviderError } from "@wg-hunt/core";
import { emptyOutput, outputWith, sure } from "@wg-hunt/core/analysis/testing";
import { beforeEach, describe, expect, it } from "vitest";
import type { OfferCase } from "./cases.js";
import { runExtraction } from "./extraction.js";
import { replayProvider } from "./replay.js";
import { renderPage } from "./synthetic-page.js";

const model = { model: "claude-haiku-5-5", effort: "medium" as const };
const escalation = { model: "claude-haiku-5-5", effort: "high" as const };

function offer(id: string, text: string, rest: Partial<OfferCase> = {}): OfferCase {
  return {
    id,
    category: "flatshare-room",
    html: renderPage({
      adId: "9100001",
      title: "Zimmer in Beispiel-WG",
      category: "flatshare-room",
      flatmates: { code: "1w,1m,0d,0n", size: 3 },
      roomSize: 14,
      totalRent: { euros: 500 },
      costs: [["Miete", "500€"]],
      from: "01.12.2026",
      sections: [["Zimmer", text]],
    }),
    expected: {},
    ...rest,
  };
}

const registered = outputWith({
  anmeldung: { value: "possible", ...sure("Anmeldung ist möglich") },
});

const unexpected: { caseId: string; error: unknown }[] = [];
beforeEach(() => {
  unexpected.length = 0;
});

const run = (cases: OfferCase[], providerFor: (c: OfferCase) => AnalysisProvider | undefined) =>
  runExtraction({
    cases,
    modelPass: {
      model,
      escalation,
      providerFor,
      onUnexpected: (caseId, error) => unexpected.push({ caseId, error }),
      sleep: async () => {},
    },
  });

describe("running rules and the model over labelled Offers", () => {
  it("scores each labelled fact and reports accuracy per fact", async () => {
    const cases = [
      offer("right", "Das Zimmer ist hell. Anmeldung ist möglich.", {
        expected: { anmeldung: "possible", warmRent: { amount: 500, converted: false } },
        replay: [registered],
      }),
      offer("wrong", "Das Zimmer ist hell. Anmeldung ist möglich.", {
        expected: { anmeldung: "not_possible" },
        replay: [registered],
      }),
    ];
    const result = await run(cases, (c) => replayProvider(c.replay ?? []));
    expect(result.facts.anmeldung).toEqual({ labelled: 2, correct: 1, accuracy: 0.5 });
    expect(result.facts.warmRent).toEqual({ labelled: 1, correct: 1, accuracy: 1 });
    expect(result.misses).toEqual([
      { case: "wrong", key: "anmeldung", expected: "not_possible", actual: "possible" },
    ]);
    expect(result.modelRan).toBe(2);
  });

  it("counts the Doubtful facts, and the escalation that settles them", async () => {
    const missed = emptyOutput();
    const cases = [
      offer("tripwire", "Anmeldung ist möglich.", {
        expected: { anmeldung: "possible" },
        replay: [missed, registered],
      }),
      offer("plain", "Ein helles Zimmer.", {
        expected: { anmeldung: "unknown" },
        replay: [missed],
      }),
    ];
    const result = await run(cases, (c) => replayProvider(c.replay ?? []));
    expect(result.facts.anmeldung?.accuracy).toBe(1);
    expect(result.escalated).toBe(1);
    expect(result.doubtful.offersWithDoubtful).toBe(0);
    expect(result.doubtful.offers).toBe(2);
  });

  it("reports the Doubtful rate of facts that stay Doubtful", async () => {
    const ambiguous = outputWith({
      anmeldung: {
        value: "conditional",
        quote: "Anmeldung ist möglich",
        ambiguous: true,
        ambiguityReason: "unclear",
      },
    });
    const result = await run(
      [offer("ambiguous", "Anmeldung ist möglich.", { expected: {}, replay: [ambiguous] })],
      (c) => replayProvider(c.replay ?? []),
    );
    expect(result.doubtful.doubtfulFacts).toBe(1);
    expect(result.doubtful.offersWithDoubtful).toBe(1);
    expect(result.doubtful.rate).toBeCloseTo(1 / result.doubtful.facts, 6);
  });

  it("scores only the rule facts of an Offer the model did not read", async () => {
    const result = await run(
      [
        offer("rules-only", "Anmeldung ist möglich.", {
          expected: { anmeldung: "possible", warmRent: { amount: 500, converted: false } },
        }),
      ],
      () => undefined,
    );
    expect(result.modelRan).toBe(0);
    expect(result.modelSkipped).toBe(1);
    expect(result.facts.anmeldung).toBeUndefined();
    expect(result.facts.warmRent?.accuracy).toBe(1);
    expect(result.calls).toEqual([]);
  });

  it("marks an Offer failed when the provider keeps failing, and does not score its model facts", async () => {
    const failing: AnalysisProvider = {
      async analyse() {
        throw new ProviderError("overloaded");
      },
    };
    const result = await run(
      [offer("down", "Anmeldung ist möglich.", { expected: { anmeldung: "possible" } })],
      () => failing,
    );
    expect(result.modelFailed).toBe(1);
    expect(result.failures).toEqual({ overloaded: 1 });
    expect(result.facts.anmeldung).toBeUndefined();
    expect(unexpected).toEqual([]);
  });

  it("counts the failed Offers by error kind, beside the ones the model read", async () => {
    const provider = (kind: "refused" | "unauthorized" | null): AnalysisProvider => ({
      async analyse() {
        if (kind !== null) throw new ProviderError(kind);
        return replayProvider([registered]).analyse({ ...model, prefix: "", userTurn: "" });
      },
    });
    const kinds = { a: "refused", b: "refused", c: "unauthorized", d: null } as const;
    const result = await run(
      Object.keys(kinds).map((id) => offer(id, "Anmeldung ist möglich.")),
      (c) => provider(kinds[c.id as keyof typeof kinds]),
    );
    expect(result).toMatchObject({ modelRan: 1, modelFailed: 3 });
    expect(result.failures).toEqual({ refused: 2, unauthorized: 1 });
  });

  it("records an exception that is not a provider error as an unexpected failure, and reports it", async () => {
    const broken: AnalysisProvider = {
      analyse: async () => ({ output: null as never, usage: {} as never }),
    };
    const result = await run(
      [
        offer("bug", "Anmeldung ist möglich.", {
          expected: { anmeldung: "possible", warmRent: { amount: 500, converted: false } },
        }),
      ],
      () => broken,
    );
    expect(result).toMatchObject({ modelRan: 0, modelFailed: 1, failures: { unexpected: 1 } });
    expect(result.facts.anmeldung).toBeUndefined();
    expect(result.facts.warmRent?.accuracy).toBe(1);
    expect(unexpected).toHaveLength(1);
    expect(unexpected[0]?.caseId).toBe("bug");
    expect(unexpected[0]?.error).toBeInstanceOf(TypeError);
  });

  it("leaves every text unread without a model pass", async () => {
    const result = await runExtraction({
      cases: [offer("no-pass", "Anmeldung ist möglich.", { replay: [registered] })],
      modelPass: null,
    });
    expect(result).toMatchObject({ modelRan: 0, modelSkipped: 1, modelFailed: 0, failures: {} });
  });

  it("never puts a location in the list of misses, even a wrong one", async () => {
    const result = await run(
      [offer("place", "Ein Zimmer.", { expected: { postalCode: "99999", street: "Falschweg 1" } })],
      () => undefined,
    );
    expect(result.facts.postalCode?.accuracy).toBe(0);
    expect(JSON.stringify(result.misses)).not.toMatch(/99999|Falschweg|12345/);
    expect(result.misses.map((miss) => miss.key)).toContain("postalCode");
  });

  it("adds up what the calls used", async () => {
    const result = await run(
      [offer("a", "Anmeldung ist möglich.", { expected: {}, replay: [registered] })],
      (c) => replayProvider(c.replay ?? []),
    );
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.model).toBe("claude-haiku-5-5");
    expect(result.calls[0]?.usage.inputTokens).toBeGreaterThan(500);
  });

  it("stops at a page the adapter cannot read, naming the case", async () => {
    await expect(
      run([{ ...offer("broken", "x"), html: "<html></html>" }], () => undefined),
    ).rejects.toThrow(/broken/);
  });
});
