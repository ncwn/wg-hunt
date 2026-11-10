import { describe, expect, it } from "vitest";
import { dedupeMetrics } from "./dedupe-metrics.js";
import type { ExtractionResult } from "./extraction.js";
import {
  buildRun,
  compareRuns,
  formatRun,
  type RunResult,
  type RunSettings,
  readSavedRun,
} from "./report.js";

const extraction = (over: Partial<ExtractionResult> = {}): ExtractionResult => ({
  cases: 4,
  modelRan: 4,
  modelSkipped: 0,
  modelFailed: 0,
  failures: {},
  escalated: 1,
  facts: {
    anmeldung: { labelled: 4, correct: 3, accuracy: 0.75 },
    warmRent: { labelled: 4, correct: 4, accuracy: 1 },
  },
  overall: { labelled: 8, correct: 7, accuracy: 0.875 },
  doubtful: { facts: 20, doubtfulFacts: 2, rate: 0.1, offers: 4, offersWithDoubtful: 2 },
  misses: [
    {
      case: "anmeldung-conditional",
      key: "anmeldung",
      expected: "conditional",
      actual: "possible",
    },
  ],
  calls: [
    {
      model: "claude-haiku-5-5",
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
  ],
  ...over,
});

const dedupe = dedupeMetrics([
  { id: "p1", expected: "duplicate", actual: "duplicate" },
  { id: "p2", expected: "sibling", actual: "apart" },
]);

type ModelRunSettings = Extract<RunSettings, { mode: "live" | "replay" }>;

const prices = [{ model: "claude-haiku-5-5", inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5 }];
const base = { rulesVersion: 1, sets: ["synthetic"], at: "2026-11-04T09:00:00.000Z" };

function run(
  settings: Partial<ModelRunSettings> = {},
  over: Partial<ExtractionResult> = {},
): RunResult {
  return buildRun({
    settings: {
      ...base,
      analysisVersion: "aaaaaaaaaaaa",
      model: "claude-haiku-5-5",
      effort: "medium",
      escalation: { model: "claude-haiku-5-5", effort: "high" },
      mode: "live",
      ...settings,
    },
    extraction: extraction(over),
    dedupe,
    prices,
  });
}

const rulesOnlyRun = (): RunResult =>
  buildRun({
    settings: { ...base, mode: "rules-only" },
    extraction: extraction({
      modelRan: 0,
      modelSkipped: 4,
      doubtful: { facts: 0, doubtfulFacts: 0, rate: null, offers: 0, offersWithDoubtful: 0 },
      calls: [],
    }),
    dedupe,
    prices: [],
  });

describe("a run's report", () => {
  const text = formatRun(run());

  it("stamps the run with its rules version and analysis version", () => {
    expect(text).toContain("rules version 1");
    expect(text).toContain("analysis version aaaaaaaaaaaa");
    expect(text).toContain("claude-haiku-5-5");
  });

  it("prints per-fact accuracy, the Doubtful rate and the cost", () => {
    expect(text).toMatch(/anmeldung\s+model\s+3\/4\s+75\.0%/);
    expect(text).toMatch(/warmRent\s+rules\s+4\/4\s+100\.0%/);
    expect(text).toContain("Doubtful rate: 10.0% (2 of 20 model facts; 2 of 4 Offers)");
    expect(text).toContain("Cost: $0.6000");
  });

  it("prints precision and recall for each dedupe relation", () => {
    expect(text).toMatch(/duplicate\s+100\.0%\s+100\.0%/);
    expect(text).toMatch(/sibling\s+-\s+0\.0%/);
  });

  it("lists what it got wrong", () => {
    expect(text).toContain("anmeldung-conditional");
    expect(text).toContain("p2");
  });

  it("says plainly that a replayed run is not a model", () => {
    expect(formatRun(run({ mode: "replay" }))).toMatch(/scripted answers.*not a real model/);
    expect(formatRun(run({ mode: "replay" }))).toContain("estimated");
  });

  it("says what is missing when the model did not run", () => {
    const rulesOnly = formatRun(rulesOnlyRun());
    expect(rulesOnly).toContain("Doubtful rate: not measured");
    expect(rulesOnly).toContain("Cost: $0.0000");
    expect(rulesOnly).toMatch(/rules only/);
  });

  it("says a cost is unknown when a model has no price", () => {
    const unpriced = formatRun(
      run(
        { model: "other-model" },
        {
          calls: [
            {
              model: "other-model",
              usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
            },
          ],
        },
      ),
    );
    expect(unpriced).toContain("Cost: unknown");
    expect(unpriced).toContain("other-model");
  });
});

describe("a run's outcome", () => {
  it("is complete when no model read failed, and when no model was asked", () => {
    expect(run().stamp.outcome).toEqual({ state: "complete" });
    expect(rulesOnlyRun().stamp.outcome).toEqual({ state: "complete" });
  });

  it("is partial, with the error kinds, when some Offers got an answer and some failed", () => {
    const partial = run({}, { modelRan: 1, modelFailed: 3, failures: { refused: 2, timeout: 1 } });
    expect(partial.stamp.outcome).toEqual({
      state: "partial",
      errors: { refused: 2, timeout: 1 },
    });
    expect(formatRun(partial)).toContain(
      "outcome: partial: the model failed on 3 of 4 Offers (refused 2, timeout 1)",
    );
  });

  it("is model-failed when no Offer got an answer", () => {
    const failed = run({}, { modelRan: 0, modelFailed: 4, failures: { unauthorized: 4 } });
    expect(failed.stamp.outcome).toEqual({ state: "model-failed", errors: { unauthorized: 4 } });
    expect(formatRun(failed)).toContain(
      "outcome: model-failed: no Offer got a model answer (unauthorized 4)",
    );
  });

  it("keeps the counts by kind in the stamp only, not twice in the saved run", () => {
    expect(run().extraction).not.toHaveProperty("failures");
  });
});

function savedBefore(current: RunResult): unknown {
  const { outcome: _outcome, ...stamp } = current.stamp;
  return JSON.parse(JSON.stringify({ ...current, stamp }));
}

describe("reading a saved run", () => {
  it("reads a run saved without an outcome as complete", () => {
    const read = readSavedRun(savedBefore(run()));
    expect(read.stamp.outcome).toEqual({ state: "complete" });
    expect(read.extraction).toEqual(run().extraction);
  });

  it("keeps the outcome a run was saved with", () => {
    const failed = run({}, { modelRan: 0, modelFailed: 4, failures: { unauthorized: 4 } });
    expect(readSavedRun(JSON.parse(JSON.stringify(failed)))).toEqual(failed);
  });

  it.each([null, {}, { format: 2 }])("refuses %j, which is not a run of this format", (saved) => {
    expect(() => readSavedRun(saved)).toThrow(/not a run/);
  });
});

describe("comparing two runs side by side", () => {
  const a = run();
  const b = run(
    { analysisVersion: "bbbbbbbbbbbb", model: "claude-sonnet-5-5" },
    {
      facts: {
        anmeldung: { labelled: 4, correct: 4, accuracy: 1 },
        warmRent: { labelled: 4, correct: 4, accuracy: 1 },
      },
      doubtful: { facts: 20, doubtfulFacts: 1, rate: 0.05, offers: 4, offersWithDoubtful: 1 },
    },
  );
  const text = compareRuns(a, b);

  it("shows both stamps", () => {
    expect(text).toContain("aaaaaaaaaaaa");
    expect(text).toContain("bbbbbbbbbbbb");
    expect(text).toMatch(/model\s+claude-haiku-5-5\s+claude-sonnet-5-5/);
  });

  it("shows each fact's accuracy in both runs and the change", () => {
    expect(text).toMatch(/anmeldung\s+75\.0%\s+100\.0%\s+\+25\.0 pts/);
    expect(text).toMatch(/warmRent\s+100\.0%\s+100\.0%\s+0\.0 pts/);
  });

  it("shows the Doubtful rate, the cost and the dedupe numbers in both", () => {
    expect(text).toMatch(/Doubtful rate\s+10\.0%\s+5\.0%/);
    expect(text).toMatch(/Cost\s+\$0\.6000\s+\$0\.6000/);
    expect(text).toMatch(/duplicate precision\s+100\.0%\s+100\.0%/);
  });

  it("warns when the two runs did not read the same cases", () => {
    const other = run({ sets: ["synthetic", "local"] }, { cases: 100 });
    expect(compareRuns(a, other)).toMatch(/not the same cases/);
  });

  it("notes a differing outcome, with each run's error kinds", () => {
    const partial = run({}, { modelRan: 3, modelFailed: 1, failures: { refused: 1 } });
    expect(compareRuns(a, partial)).toContain(
      "Note: The model's reads did not go the same (A: complete, 0 failed; B: partial, 1 failed (refused 1)).",
    );
  });

  it("notes a differing number of failed reads when the outcome is the same", () => {
    const one = run({}, { modelRan: 3, modelFailed: 1, failures: { refused: 1 } });
    const two = run({}, { modelRan: 2, modelFailed: 2, failures: { refused: 2 } });
    expect(compareRuns(one, two)).toMatch(/A: partial, 1 failed.*B: partial, 2 failed/);
  });

  it("notes failed reads in a run saved before outcomes, which reads as complete", () => {
    const older = readSavedRun(savedBefore(run({}, { modelRan: 1, modelFailed: 3 })));
    expect(compareRuns(older, a)).toMatch(/A: complete, 3 failed; B: complete, 0 failed/);
  });

  it("has no note about outcomes for two runs that went the same", () => {
    expect(compareRuns(a, b)).not.toMatch(/did not go the same/);
  });

  it("shows no model settings for a rules-only run", () => {
    const text = compareRuns(a, rulesOnlyRun());
    expect(text).toMatch(/model\s+claude-haiku-5-5\s+-/);
    expect(text).toMatch(/analysis version\s+aaaaaaaaaaaa\s+-/);
    expect(text).toMatch(/A ran in live mode, B in rules-only mode/);
  });

  it("warns when the rules version differs, since rule facts then differ too", () => {
    expect(compareRuns(a, run({ rulesVersion: 2 }))).toMatch(/rules versions differ/);
  });
});
