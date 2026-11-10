import type { CombinedFacts } from "@wg-hunt/core";
import { describe, expect, it, vi } from "vitest";
import type { OfferCase } from "./cases.js";
import { dedupeMetrics } from "./dedupe-metrics.js";
import { runExtraction } from "./extraction.js";
import { buildRun, formatRun } from "./report.js";
import { type Labels, scoreFacts } from "./score.js";
import { renderPage } from "./synthetic-page.js";

vi.mock("@wg-hunt/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@wg-hunt/core")>();
  return {
    ...core,
    MODEL_FACT_KEYS: [...core.MODEL_FACT_KEYS, "houseRules"],
    isListFact: (key: string) => key === "houseRules" || core.isListFact(key),
  };
});

const labels = (expected: Record<string, unknown>) => expected as Labels;

const offer: OfferCase = {
  id: "unread",
  category: "flatshare-room",
  html: renderPage({
    adId: "9500001",
    title: "Zimmer in Beispiel-WG",
    category: "flatshare-room",
    flatmates: { code: "1w,1m,0d,0n", size: 3 },
    roomSize: 14,
    totalRent: { euros: 500 },
    sections: [["Zimmer", "Ein helles Zimmer."]],
  }),
  expected: labels({
    houseRules: ["quiet_after_ten"],
    genderSought: "any",
    warmRent: { amount: 500, converted: false },
  }),
};

describe("which facts the model reads, and which are lists, come from core", () => {
  it("scores no model fact of an Offer the model did not read, a new one included", async () => {
    const result = await runExtraction({ cases: [offer], modelPass: null });
    expect(Object.keys(result.facts)).toEqual(["warmRent"]);
  });

  it("reports a new model fact as read by the model", async () => {
    const extraction = await runExtraction({ cases: [], modelPass: null });
    const tally = { labelled: 1, correct: 1, accuracy: 1 };
    const run = buildRun({
      settings: {
        rulesVersion: 1,
        sets: ["synthetic"],
        at: "2026-11-10T09:00:00.000Z",
        mode: "rules-only",
      },
      extraction: {
        ...extraction,
        facts: { houseRules: tally, genderSought: tally, warmRent: tally },
      },
      dedupe: dedupeMetrics([]),
      prices: [],
    });
    const text = formatRun(run);
    expect(text).toMatch(/houseRules\s+model\s/);
    expect(text).toMatch(/genderSought\s+rules\+model\s/);
    expect(text).toMatch(/warmRent\s+rules\s/);
  });

  it("scores a new list fact as a set of items, whatever their order", () => {
    const fact = (value: unknown) => ({ value, origin: "text", quote: "q" });
    const [score] = scoreFacts(labels({ houseRules: ["quiet_after_ten", "no_parties"] }), {
      houseRules: [fact("no_parties"), fact("quiet_after_ten")],
    } as unknown as CombinedFacts);
    expect(score?.correct).toBe(true);
  });
});
