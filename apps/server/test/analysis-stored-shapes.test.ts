import type { ModelFacts } from "@wg-hunt/core";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  type AnalysisPlan,
  analysisColumns,
  makeRun,
  type OfferAnalysis,
  type OwedEscalation,
  readAnalysis,
} from "../src/analysis/record.js";
import { type OfferRow, offers } from "../src/db/schema.js";
import { type Boot, boot, crawlOffers, poll, setKey } from "./analysis-harness.js";

type Columns = Pick<OfferRow, "analysisState" | "modelFacts" | "analysis">;

const columnsOf = (h: Boot, id: number): Columns => {
  const row = h.runtime.db.select().from(offers).where(eq(offers.id, id)).get();
  if (row === undefined) throw new Error("no Offer");
  return { analysisState: row.analysisState, modelFacts: row.modelFacts, analysis: row.analysis };
};

const store = (h: Boot, id: number, columns: Columns) =>
  h.runtime.db.update(offers).set(columns).where(eq(offers.id, id)).run();

const plan: AnalysisPlan = {
  model: { model: "claude-haiku-5-5", effort: "medium" },
  escalation: { model: "claude-haiku-5-5", effort: "high" },
};

/** Synthetic: told apart from anything the fake model reads by the 17-month minimum stay. */
const facts = {
  anmeldung: { value: "unknown", origin: "model", quote: "" },
  minimumStay: { value: 17, origin: "model", quote: "" },
  scamSignals: [],
  conflicts: [],
} as unknown as ModelFacts;

const owed = (contentHash: string): OwedEscalation => ({
  carry: { first: facts, log: [], calls: [] },
  plan,
  contentHash,
});

const truncated = (contentHash: string) => ({
  kind: "truncated",
  at: new Date(0).toISOString(),
  attempts: 1,
  contentHash,
});

async function offer(withKey: boolean) {
  const h = boot();
  if (withKey) await setKey(h);
  const [offer] = await crawlOffers(h, 1);
  const id = offer?.id as number;
  const hash = h.runtime.offers.analysisJob(id)?.contentHash as string;
  const run = makeRun({
    plan,
    result: { escalated: false, log: [] },
    analyzedAt: new Date(h.clock.now).toISOString(),
    contentHash: hash,
  });
  return { h, id, hash, run };
}

/** What the dashboard shows, then which model calls the next sweep sends. */
async function observe(h: Boot, id: number) {
  const list = await h.json("GET", "/offers");
  const detail = await h.json("GET", `/offers/${id}`);
  const before = { realtime: h.requests.length, batch: h.batch.submissions.flat().length };
  let swept = true;
  try {
    h.runtime.analysis.sweep();
  } catch {
    swept = false;
  }
  await h.runtime.analysis.idle();
  await poll(h);
  return {
    listed: list.status === 200,
    state: detail.body.analysisState ?? null,
    status: detail.body.analysisStatus?.status ?? null,
    willRead: detail.body.analysisStatus?.willRead ?? null,
    modelFacts: detail.body.facts?.minimumStay?.value === 17,
    ranWith: detail.body.analysis?.model ?? null,
    swept,
    calls: [
      ...h.requests.slice(before.realtime).map((request) => `${request.effort} now`),
      ...h.batch.submissions
        .flat()
        .slice(before.batch)
        .map(({ request }) => `${request.effort} in a batch`),
    ],
  };
}

type Stored = Awaited<ReturnType<typeof offer>>;
type Seen = Awaited<ReturnType<typeof observe>>;

const readAgain: Seen = {
  listed: true,
  state: "pending",
  status: "queued",
  willRead: true,
  modelFacts: false,
  ranWith: null,
  swept: true,
  calls: ["medium now"],
};

describe("an Offer whose stored analysis fits no shape", () => {
  const cases: [string, (offer: Stored) => Columns, Seen][] = [
    [
      "analyzed with no run",
      () => ({ analysisState: "analyzed", modelFacts: JSON.stringify(facts), analysis: null }),
      readAgain,
    ],
    [
      "analyzed with no model facts",
      ({ run }) => ({
        analysisState: "analyzed",
        modelFacts: null,
        analysis: JSON.stringify({ run }),
      }),
      {
        ...readAgain,
        state: "analyzed",
        status: "analyzed",
        willRead: false,
        ranWith: plan.model.model,
        calls: [],
      },
    ],
    [
      "analyzed with model facts that do not parse",
      ({ run }) => ({
        analysisState: "analyzed",
        modelFacts: "{not json",
        analysis: JSON.stringify({ run }),
      }),
      readAgain,
    ],
    [
      "failed with no failure",
      ({ run }) => ({
        analysisState: "failed",
        modelFacts: null,
        analysis: JSON.stringify({ run }),
      }),
      readAgain,
    ],
    [
      "pending with model facts left over",
      () => ({ analysisState: "pending", modelFacts: JSON.stringify(facts), analysis: null }),
      readAgain,
    ],
    [
      "pending with a run left over",
      ({ run }) => ({
        analysisState: "pending",
        modelFacts: null,
        analysis: JSON.stringify({ run }),
      }),
      readAgain,
    ],
    [
      "pending with an analysis that is not JSON",
      () => ({ analysisState: "pending", modelFacts: null, analysis: "{not json" }),
      readAgain,
    ],
    [
      "failed with an analysis that is not JSON",
      () => ({ analysisState: "failed", modelFacts: null, analysis: "{not json" }),
      readAgain,
    ],
    [
      "analyzed with an analysis that is not JSON",
      () => ({
        analysisState: "analyzed",
        modelFacts: JSON.stringify(facts),
        analysis: "{not json",
      }),
      readAgain,
    ],
    [
      "analyzed with an analysis that is JSON but no object",
      () => ({ analysisState: "analyzed", modelFacts: JSON.stringify(facts), analysis: "null" }),
      readAgain,
    ],
    [
      "analyzed with an escalation and no run",
      ({ hash }) => ({
        analysisState: "analyzed",
        modelFacts: JSON.stringify(facts),
        analysis: JSON.stringify({ escalation: owed(hash) }),
      }),
      readAgain,
    ],
    [
      "pending with an escalation",
      ({ hash }) => ({
        analysisState: "pending",
        modelFacts: null,
        analysis: JSON.stringify({ escalation: owed(hash) }),
      }),
      readAgain,
    ],
    [
      "failed with an escalation",
      ({ hash }) => ({
        analysisState: "failed",
        modelFacts: null,
        analysis: JSON.stringify({ escalation: owed(hash), failure: truncated(hash) }),
      }),
      { ...readAgain, state: "failed", status: "needs-click", willRead: false, calls: [] },
    ],
  ];

  it.each(cases)("%s", async (_name, columns, expected) => {
    const read = await offer(true);
    store(read.h, read.id, columns(read));
    expect(await observe(read.h, read.id)).toEqual(expected);
  });
});

describe("the stored analysis columns", () => {
  it("are written in the format earlier releases read, and read back byte for byte", async () => {
    const { h, id, hash, run } = await offer(false);
    const offers = h.runtime.offers;
    const at = new Date(h.clock.now).toISOString();
    const legacy = { ...run, analysisVersion: undefined };
    const written: Columns[] = [];
    const after = (write: () => void) => {
      write();
      written.push(columnsOf(h, id));
    };

    after(() => {});
    after(() => offers.saveAnalysis(id, facts, run, owed(hash)));
    after(() => offers.noteEscalationResent(id));
    after(() => offers.failAnalysis(id, "truncated"));
    after(() => offers.saveAnalysis(id, facts, legacy));
    after(() => offers.resetAnalysis(id));
    after(() => offers.failAnalysis(id, "truncated"));
    after(() => offers.failAnalysis(id, "truncated"));

    const resent = { ...owed(hash), resends: 1, resentAt: h.clock.now };
    const failure = (attempts: number) => ({ kind: "truncated", at, attempts, contentHash: hash });
    const analyzed = (analysis: object) => ({
      analysisState: "analyzed",
      modelFacts: JSON.stringify(facts),
      analysis: JSON.stringify(analysis),
    });
    const pending = { analysisState: "pending", modelFacts: null, analysis: null };
    expect(written).toEqual([
      pending,
      analyzed({ run, escalation: owed(hash) }),
      analyzed({ run, escalation: resent }),
      analyzed({ run, escalation: resent, failure: failure(1) }),
      analyzed({ run: legacy }),
      pending,
      {
        analysisState: "failed",
        modelFacts: null,
        analysis: JSON.stringify({ failure: failure(1) }),
      },
      {
        analysisState: "failed",
        modelFacts: null,
        analysis: JSON.stringify({ failure: failure(2) }),
      },
    ]);
    expect(written.map((columns) => analysisColumns(readAnalysis(columns)))).toEqual(written);
    expect(written.map((columns) => readAnalysis(columns).state)).toEqual<OfferAnalysis["state"][]>(
      ["pending", "analyzed", "analyzed", "analyzed", "analyzed", "pending", "failed", "failed"],
    );
  });
});
