import type { AnalysisProvider } from "@wg-hunt/core";
import { emptyOutput } from "@wg-hunt/core/analysis/testing";
import { describe, expect, it } from "vitest";
import { evaluate, type RunPlan } from "./run.js";

const pass = {
  model: { model: "claude-haiku-5-5", effort: "medium" as const },
  escalation: null,
  prices: [],
  onUnexpected: () => {},
};

const provider: AnalysisProvider = {
  analyse: async () => ({
    output: emptyOutput(),
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  }),
};

describe("planning a run", () => {
  it("cannot plan a live run without a provider, or name a model for a rules-only one", () => {
    const plans: RunPlan[] = [
      { mode: "live", provider, concurrency: 1, ...pass },
      { mode: "replay", ...pass },
      { mode: "rules-only" },
      // @ts-expect-error a live run needs the provider that answers it
      { mode: "live", concurrency: 1, ...pass },
      // @ts-expect-error no model is asked in a rules-only run, so none is named
      { mode: "rules-only", model: pass.model },
    ];
    expect(plans).toHaveLength(5);
  });

  it("stamps a run with no cases as complete, in every mode", async () => {
    const empty = { offers: [], pairs: [], sets: ["local"] };
    for (const plan of [
      { mode: "live", provider, concurrency: 1, ...pass },
      { mode: "replay", ...pass },
      { mode: "rules-only" },
    ] satisfies RunPlan[]) {
      const run = await evaluate({ ...empty, plan });
      expect(run.stamp).toMatchObject({ mode: plan.mode, outcome: { state: "complete" } });
    }
  });
});
