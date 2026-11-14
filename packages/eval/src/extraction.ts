import {
  type AnalysisProvider,
  analyseOffer,
  combineOfferFacts,
  type ModelChoice,
  type ModelFacts,
  type ParseResult,
  ProviderError,
  type ProviderErrorKind,
  type TokenUsage,
} from "@wg-hunt/core";
import { wgGesuchtSource } from "@wg-hunt/core/sources/wg-gesucht";
import type { OfferCase } from "./cases.js";
import { readBy } from "./read-by.js";
import { type FactScore, scoreFacts } from "./score.js";

/** Location facts are scored but their values are never printed or saved. */
const LOCATION_FACTS: readonly string[] = ["postalCode", "district", "street", "coordinates"];
const hidden = (key: string, value: unknown): unknown =>
  LOCATION_FACTS.includes(key) ? "(location, not shown)" : value;

type FactTally = { labelled: number; correct: number; accuracy: number };

type FailureKind = ProviderErrorKind | "unexpected";

export type ExtractionResult = {
  cases: number;
  modelRan: number;
  modelSkipped: number;
  modelFailed: number;
  failures: Partial<Record<FailureKind, number>>;
  escalated: number;
  facts: Record<string, FactTally>;
  overall: FactTally;
  doubtful: {
    facts: number;
    doubtfulFacts: number;
    rate: number | null;
    offers: number;
    offersWithDoubtful: number;
  };
  misses: { case: string; key: string; expected: unknown; actual: unknown }[];
  calls: { model: string; usage: TokenUsage }[];
};

type ModelPass = {
  model: ModelChoice;
  escalation: ModelChoice | null;
  /** Undefined leaves the case's text unread. */
  providerFor: (offer: OfferCase) => AnalysisProvider | undefined;
  onUnexpected: (caseId: string, error: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
};

type RunExtractionArgs = {
  cases: readonly OfferCase[];
  /** Null leaves every text unread, so only rule facts are scored. */
  modelPass: ModelPass | null;
  concurrency?: number;
};

/** The first day wg-hunt "saw" every case, so "sofort" always means the same date. */
const FIRST_SEEN = new Date("2026-11-04T09:00:00Z");

type ModelRead =
  | {
      state: "ran";
      facts: ModelFacts;
      escalated: boolean;
      calls: { model: string; usage: TokenUsage }[];
    }
  | { state: "skipped" }
  | { state: "failed"; kind: FailureKind };

type CaseRun = { scores: FactScore[]; read: ModelRead };

function readablePage(offer: OfferCase) {
  const parsed: ParseResult = wgGesuchtSource.parseOffer(offer.html, {
    firstSeen: FIRST_SEEN,
    category: offer.category,
  });
  if (parsed.outcome !== "parsed" || parsed.status === "deleted") {
    throw new Error(`${offer.id}: the page is not an Offer page the adapter can read`);
  }
  return parsed;
}

function modelFactList(facts: ModelFacts): { doubtful: boolean }[] {
  const all = [
    facts.anmeldung,
    facts.minimumStay,
    ...(facts.genderSoughtText ? [facts.genderSoughtText] : []),
    ...(facts.requirements ?? []),
    ...facts.scamSignals,
    ...facts.conflicts,
  ];
  return all.map((fact) => ({ doubtful: fact.confidence?.status === "doubtful" }));
}

async function readWithModel(
  offer: OfferCase,
  page: ReturnType<typeof readablePage>,
  pass: ModelPass | null,
): Promise<ModelRead> {
  const provider = pass?.providerFor(offer);
  if (pass === null || provider === undefined) return { state: "skipped" };
  try {
    const analysis = await analyseOffer({
      provider,
      text: page.text,
      category: page.category,
      ruleFacts: page.facts,
      model: pass.model,
      escalation: pass.escalation,
      ...(pass.sleep ? { sleep: pass.sleep } : {}),
    });
    return {
      state: "ran",
      facts: analysis.facts,
      escalated: analysis.escalated,
      calls: analysis.calls.map((call) => ({ model: call.model, usage: call.usage })),
    };
  } catch (error) {
    // A ProviderError's message is only its kind.
    if (error instanceof ProviderError) return { state: "failed", kind: error.kind };
    pass.onUnexpected(offer.id, error);
    return { state: "failed", kind: "unexpected" };
  }
}

async function runCase(offer: OfferCase, pass: ModelPass | null): Promise<CaseRun> {
  const page = readablePage(offer);
  const read = await readWithModel(offer, page, pass);
  const combined = combineOfferFacts({
    category: page.category,
    ruleFacts: page.facts,
    ...(read.state === "ran" ? { modelFacts: read.facts } : {}),
  });
  // Without a model read, a fact the model has a say in is not scored: a field-only answer would be
  // marked wrong for the very case the label is about.
  const labels = Object.fromEntries(
    Object.entries(offer.expected).filter(
      ([key]) => read.state === "ran" || readBy(key) === "rules",
    ),
  );
  return { scores: scoreFacts(labels, combined), read };
}

const ratio = (part: number, whole: number) => (whole === 0 ? 0 : part / whole);

export async function runExtraction(args: RunExtractionArgs): Promise<ExtractionResult> {
  const runs = new Array<CaseRun>(args.cases.length);
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < args.cases.length; index = next++) {
      const offer = args.cases[index];
      if (offer === undefined) continue;
      runs[index] = await runCase(offer, args.modelPass);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, args.concurrency ?? 1) }, worker));

  const facts: Record<string, FactTally> = {};
  const misses: ExtractionResult["misses"] = [];
  const raw: Record<string, { labelled: number; correct: number }> = {};
  let doubtfulFacts = 0;
  let modelFactCount = 0;
  let offersWithDoubtful = 0;
  let offersRead = 0;

  args.cases.forEach((offer, index) => {
    const run = runs[index];
    if (run === undefined) return;
    for (const score of run.scores) {
      const tally = raw[score.key] ?? { labelled: 0, correct: 0 };
      raw[score.key] = tally;
      tally.labelled++;
      if (score.correct) tally.correct++;
      else
        misses.push({
          case: offer.id,
          key: score.key,
          expected: hidden(score.key, score.expected),
          actual: hidden(score.key, score.actual),
        });
    }
    if (run.read.state === "ran") {
      offersRead++;
      const modelFacts = modelFactList(run.read.facts);
      const doubtful = modelFacts.filter((fact) => fact.doubtful).length;
      doubtfulFacts += doubtful;
      modelFactCount += modelFacts.length;
      if (doubtful > 0) offersWithDoubtful++;
    }
  });

  let labelled = 0;
  let correct = 0;
  for (const [key, tally] of Object.entries(raw)) {
    facts[key] = { ...tally, accuracy: ratio(tally.correct, tally.labelled) };
    labelled += tally.labelled;
    correct += tally.correct;
  }

  const reads = runs.map((run) => run.read);
  const count = (state: ModelRead["state"]) => reads.filter((read) => read.state === state).length;
  const failures: ExtractionResult["failures"] = {};
  for (const read of reads) {
    if (read.state === "failed") failures[read.kind] = (failures[read.kind] ?? 0) + 1;
  }
  return {
    cases: args.cases.length,
    modelRan: count("ran"),
    modelSkipped: count("skipped"),
    modelFailed: count("failed"),
    failures,
    escalated: reads.filter((read) => read.state === "ran" && read.escalated).length,
    facts,
    overall: { labelled, correct, accuracy: ratio(correct, labelled) },
    doubtful: {
      facts: modelFactCount,
      doubtfulFacts,
      rate: modelFactCount === 0 ? null : doubtfulFacts / modelFactCount,
      offers: offersRead,
      offersWithDoubtful,
    },
    misses,
    calls: reads.flatMap((read) => (read.state === "ran" ? read.calls : [])),
  };
}
