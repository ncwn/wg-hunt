import type { ModelChoice } from "@wg-hunt/core";
import { type Cost, costOf, type Price } from "./cost.js";
import { type DedupeMetrics, REPORTED_RELATIONS } from "./dedupe-metrics.js";
import type { ExtractionResult } from "./extraction.js";
import { readBy } from "./read-by.js";

type ModelSettings = {
  analysisVersion: string;
  model: string;
  effort: ModelChoice["effort"];
  escalation: ModelChoice | null;
};

export type RunSettings = {
  rulesVersion: number;
  sets: string[];
  at: string;
} & (({ mode: "live" | "replay" } & ModelSettings) | { mode: "rules-only" });

/** A run that asked no model is `complete` too. */
type RunOutcome =
  | { state: "complete" }
  | {
      state: "partial" | "model-failed";
      errors: Record<string, number>;
    };

type RunStamp = RunSettings & { outcome: RunOutcome };

export type RunResult = {
  format: 1;
  stamp: RunStamp;
  extraction: Omit<ExtractionResult, "calls" | "failures"> & {
    usage: {
      calls: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    };
    cost: Cost;
  };
  dedupe: DedupeMetrics;
};

function outcomeOf(extraction: ExtractionResult): RunOutcome {
  if (extraction.modelFailed === 0) return { state: "complete" };
  return {
    state: extraction.modelRan === 0 ? "model-failed" : "partial",
    errors: { ...extraction.failures },
  };
}

export function buildRun(args: {
  settings: RunSettings;
  extraction: ExtractionResult;
  dedupe: DedupeMetrics;
  prices: readonly Price[];
}): RunResult {
  const { calls, failures: _failures, ...rest } = args.extraction;
  const sum = (pick: (usage: (typeof calls)[number]["usage"]) => number) =>
    calls.reduce((total, call) => total + pick(call.usage), 0);
  return {
    format: 1,
    stamp: { ...args.settings, outcome: outcomeOf(args.extraction) },
    extraction: {
      ...rest,
      usage: {
        calls: calls.length,
        inputTokens: sum((u) => u.inputTokens),
        outputTokens: sum((u) => u.outputTokens),
        cacheReadTokens: sum((u) => u.cacheReadTokens),
        cacheWriteTokens: sum((u) => u.cacheWriteTokens),
      },
      cost: costOf(calls, args.prices),
    },
    dedupe: args.dedupe,
  };
}

/** Runs saved before a run had an outcome carry none, and read as `complete`. */
export function readSavedRun(saved: unknown): RunResult {
  const run = saved as Omit<RunResult, "stamp"> & {
    stamp: RunSettings & { outcome?: RunOutcome };
  };
  if (run?.format !== 1) throw new Error("not a run this version can read");
  return { ...run, stamp: { ...run.stamp, outcome: run.stamp.outcome ?? { state: "complete" } } };
}

const pct = (value: number | null) => (value === null ? "-" : `${(value * 100).toFixed(1)}%`);
const usd = (cost: Cost) => (cost.usd === null ? "unknown" : `$${cost.usd.toFixed(4)}`);
const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function table(rows: string[][]): string {
  const widths =
    rows[0]?.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length))) ?? [];
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .map((line) => `  ${line}`)
    .join("\n");
}

function describeMode(stamp: RunStamp): string {
  switch (stamp.mode) {
    case "live":
      return "live: a real model was asked";
    case "replay":
      return "replay: scripted answers stand in for a model (not a real model; token counts are estimated)";
    case "rules-only":
      return "rules only: the model did not run, so only rule facts are scored";
  }
}

const effortOf = (choice: ModelChoice) => `${choice.model}/${choice.effort ?? "no effort"}`;

function kindsOf(outcome: RunOutcome): string {
  if (outcome.state === "complete") return "";
  return Object.entries(outcome.errors)
    .map(([kind, count]) => `${kind} ${count}`)
    .join(", ");
}

export function describeOutcome(run: RunResult): string {
  const { outcome } = run.stamp;
  if (outcome.state === "complete") return "complete";
  const { modelRan, modelFailed } = run.extraction;
  return outcome.state === "partial"
    ? `partial: the model failed on ${modelFailed} of ${modelRan + modelFailed} Offers (${kindsOf(outcome)}), whose model facts are not scored`
    : `model-failed: no Offer got a model answer (${kindsOf(outcome)}), so no model fact is scored`;
}

/**
 * The count is the extraction's own, because a run saved before runs had an outcome reads as
 * `complete` whatever failed in it.
 */
function readsOf(run: RunResult): string {
  const kinds = kindsOf(run.stamp.outcome);
  return `${run.stamp.outcome.state}, ${run.extraction.modelFailed} failed${kinds === "" ? "" : ` (${kinds})`}`;
}

export function formatRun(run: RunResult): string {
  const { stamp, extraction: x, dedupe } = run;
  const out: string[] = [];
  out.push("wg-hunt evaluation");
  out.push(
    stamp.mode === "rules-only"
      ? `  rules version ${stamp.rulesVersion}`
      : `  rules version ${stamp.rulesVersion}, analysis version ${stamp.analysisVersion} (${effortOf(stamp)}; escalation ${stamp.escalation ? effortOf(stamp.escalation) : "off"})`,
  );
  out.push(`  mode: ${describeMode(stamp)}`);
  out.push(`  outcome: ${describeOutcome(run)}`);
  out.push(`  sets: ${stamp.sets.join(", ")}; run at ${stamp.at}`);
  out.push("");

  out.push(
    `Extraction: ${x.cases} Offers; the model read ${x.modelRan}, skipped ${x.modelSkipped}, failed ${x.modelFailed}; ${x.escalated} escalated`,
  );
  const keys = Object.keys(x.facts).sort(
    (a, b) => readBy(a).localeCompare(readBy(b)) || a.localeCompare(b),
  );
  out.push(
    table([
      ["fact", "read by", "right", "accuracy"],
      ...keys.map((key) => {
        const tally = x.facts[key];
        return [
          key,
          readBy(key),
          `${tally?.correct}/${tally?.labelled}`,
          pct(tally?.accuracy ?? null),
        ];
      }),
      [
        "all labelled facts",
        "",
        `${x.overall.correct}/${x.overall.labelled}`,
        pct(x.overall.accuracy),
      ],
    ]),
  );
  out.push("");

  out.push(
    x.doubtful.rate === null
      ? "Doubtful rate: not measured (the model did not run)"
      : `Doubtful rate: ${pct(x.doubtful.rate)} (${x.doubtful.doubtfulFacts} of ${x.doubtful.facts} model facts; ${x.doubtful.offersWithDoubtful} of ${x.doubtful.offers} Offers)`,
  );
  const u = x.usage;
  const estimated = stamp.mode === "replay" ? ", estimated" : "";
  out.push(
    x.cost.usd === null
      ? `Cost: unknown, no price for ${x.cost.unpriced.join(", ")} (give --input-price and --output-price); ${u.calls} calls, ${tokens(u.inputTokens)} input and ${tokens(u.outputTokens)} output tokens`
      : `Cost: ${usd(x.cost)} (${u.calls} calls, ${tokens(u.inputTokens)} input and ${tokens(u.outputTokens)} output tokens${estimated})`,
  );
  out.push("");

  out.push(`Dedupe: ${dedupe.pairs} labelled pairs, ${pct(dedupe.accuracy)} exactly right`);
  out.push(
    table([
      ["relation", "precision", "recall", "right/wrongly added/missed"],
      ...REPORTED_RELATIONS.map((relation) => {
        const r = dedupe.relations[relation];
        return [
          relation,
          pct(r.precision),
          pct(r.recall),
          `${r.truePositives}/${r.falsePositives}/${r.falseNegatives}`,
        ];
      }),
    ]),
  );

  if (x.misses.length > 0 || dedupe.misses.length > 0) {
    out.push("");
    out.push("Got wrong:");
    for (const miss of x.misses) {
      out.push(
        `  ${miss.case}: ${miss.key} should be ${JSON.stringify(miss.expected)}, was ${JSON.stringify(miss.actual)}`,
      );
    }
    for (const miss of dedupe.misses) {
      out.push(`  ${miss.id}: pair should be ${miss.expected}, was ${miss.actual}`);
    }
  }
  return out.join("\n");
}

const delta = (a: number | null, b: number | null) =>
  a === null || b === null ? "" : `${b - a > 0 ? "+" : ""}${((b - a) * 100).toFixed(1)} pts`;

export function compareRuns(a: RunResult, b: RunResult): string {
  const out: string[] = ["Comparing two runs (left is A, right is B)"];
  const notes: string[] = [];
  if (a.stamp.rulesVersion !== b.stamp.rulesVersion) {
    notes.push("The rules versions differ, so rule facts may differ too.");
  }
  if (
    a.extraction.cases !== b.extraction.cases ||
    a.dedupe.pairs !== b.dedupe.pairs ||
    a.stamp.sets.join() !== b.stamp.sets.join()
  ) {
    notes.push(
      `These are not the same cases (A: ${a.extraction.cases} Offers, ${a.dedupe.pairs} pairs; B: ${b.extraction.cases} Offers, ${b.dedupe.pairs} pairs), so differences are not only the model's.`,
    );
  }
  if (a.stamp.mode !== b.stamp.mode)
    notes.push(`A ran in ${a.stamp.mode} mode, B in ${b.stamp.mode} mode.`);
  if (
    a.stamp.outcome.state !== b.stamp.outcome.state ||
    a.extraction.modelFailed !== b.extraction.modelFailed
  ) {
    notes.push(
      `The model's reads did not go the same (A: ${readsOf(a)}; B: ${readsOf(b)}). A failed Offer's model facts are not scored, so the two accuracies are not over the same Offers.`,
    );
  }
  for (const note of notes) out.push(`  Note: ${note}`);
  out.push("");

  const stampRow = (label: string, pick: (s: RunStamp) => string) => [
    label,
    pick(a.stamp),
    pick(b.stamp),
    "",
  ];
  const modelRow = (label: string, pick: (s: ModelSettings) => string) =>
    stampRow(label, (s) => (s.mode === "rules-only" ? "-" : pick(s)));
  out.push(
    table([
      ["", "A", "B", "change"],
      stampRow("run at", (s) => s.at),
      stampRow("mode", (s) => s.mode),
      stampRow("outcome", (s) => s.outcome.state),
      [
        "failed model reads",
        String(a.extraction.modelFailed),
        String(b.extraction.modelFailed),
        "",
      ],
      stampRow("rules version", (s) => String(s.rulesVersion)),
      modelRow("analysis version", (s) => s.analysisVersion),
      modelRow("model", (s) => s.model),
      modelRow("effort", (s) => s.effort ?? "none"),
      modelRow("escalation", (s) => (s.escalation ? effortOf(s.escalation) : "off")),
    ]),
  );
  out.push("");

  const keys = [
    ...new Set([...Object.keys(a.extraction.facts), ...Object.keys(b.extraction.facts)]),
  ].sort();
  const accuracy = (run: RunResult, key: string) => run.extraction.facts[key]?.accuracy ?? null;
  out.push("Per-fact accuracy");
  out.push(
    table([
      ["fact", "A", "B", "change"],
      ...keys.map((key) => [
        key,
        pct(accuracy(a, key)),
        pct(accuracy(b, key)),
        delta(accuracy(a, key), accuracy(b, key)),
      ]),
      [
        "all labelled facts",
        pct(a.extraction.overall.accuracy),
        pct(b.extraction.overall.accuracy),
        delta(a.extraction.overall.accuracy, b.extraction.overall.accuracy),
      ],
    ]),
  );
  out.push("");

  out.push(
    table([
      ["", "A", "B", "change"],
      [
        "Doubtful rate",
        pct(a.extraction.doubtful.rate),
        pct(b.extraction.doubtful.rate),
        delta(a.extraction.doubtful.rate, b.extraction.doubtful.rate),
      ],
      ["Cost", usd(a.extraction.cost), usd(b.extraction.cost), ""],
      ...REPORTED_RELATIONS.flatMap((relation) => [
        [
          `${relation} precision`,
          pct(a.dedupe.relations[relation].precision),
          pct(b.dedupe.relations[relation].precision),
          delta(a.dedupe.relations[relation].precision, b.dedupe.relations[relation].precision),
        ],
        [
          `${relation} recall`,
          pct(a.dedupe.relations[relation].recall),
          pct(b.dedupe.relations[relation].recall),
          delta(a.dedupe.relations[relation].recall, b.dedupe.relations[relation].recall),
        ],
      ]),
    ]),
  );
  return out.join("\n");
}
