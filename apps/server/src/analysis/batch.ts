import {
  type AnalysisErrorKind,
  type BatchOutcome,
  type BatchProvider,
  contentHash,
  type EscalationState,
  escalationRequest,
  firstRequest,
  type ModelChoice,
  ProviderError,
  policyOf,
  readFirst,
  readSecond,
  type StepArgs,
} from "@wg-hunt/core";
import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { type AnalysisSettings, loadAnalysisSettings } from "../analysis-settings.js";
import type { Db } from "../db/index.js";
import {
  type AnalysisBatchRow,
  type AnalysisItemRow,
  type AnalysisRunRow,
  analysisBatches,
  analysisItems,
  analysisRuns,
  analysisUsage,
} from "../db/schema.js";
import type { EventBus } from "../events.js";
import type { AnalysisJob, Offers } from "../offers/offers.js";
import { createBatchState, SETTLED, WAITING } from "./batch-state.js";
import { estimateReanalysisUsd } from "./estimate.js";
import { keyReportingBatch, keyState } from "./key.js";
import type { OfferReader } from "./read-offer.js";
import { type AnalysisPlan, makeRun } from "./record.js";
import {
  type RunStatus,
  type RunStopReason,
  type StartRunRefusal,
  settledOutcome,
} from "./run-status.js";
import type { SpendLedger } from "./spend.js";
import { usdToMicros } from "./spend.js";
import { analysisVersion, onOlderAnalysis } from "./version.js";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_POLL_MS = 60_000;
const DEFAULT_RECONCILE_GRACE_MS = 10 * 60_000;
const MICROS = 1_000_000;
const MINUTE = 60_000;
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60_000;
/** The API keeps a batch's results for 29 days; after that nothing can be read back. */
const MAX_BATCH_AGE_MS = 29 * 24 * 60 * 60_000;
const MAX_CHECK_FAILURES = 5;

export type BatchOptions = {
  size?: number;
  pollMs?: number;
  /** A send that timed out can still create its batch a little later. */
  reconcileGraceMs?: number;
};

export type RunView = {
  id: number;
  status: RunStatus;
  createdAt: string;
  finishedAt: string | null;
  analysisVersion: string;
  estimatedCostUsd: number;
  actualCostUsd: number;
  counts: {
    total: number;
    applied: number;
    failed: number;
    capped: number;
    /** The Offer's words changed, or the Offer is gone. */
    dropped: number;
    pending: number;
  };
  errorKinds: Record<string, number>;
  stopReason: RunStopReason | null;
};

export type StartRun = { ok: true; run: RunView } | { ok: false; reason: StartRunRefusal };

type StoredRun = AnalysisRunRow & { offerCount: number };

function parseKinds(stored: string): Record<string, number> {
  try {
    const kinds = JSON.parse(stored) as unknown;
    return typeof kinds === "object" && kinds !== null ? (kinds as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function providerIdOf(batch: AnalysisBatchRow): string {
  if (batch.providerBatchId === null) throw new Error("a sent batch always has its provider's id");
  return batch.providerBatchId;
}

/**
 * Request ids name the batch row and item, so a batch found again by its contents can be told from
 * someone else's, and results only ever match their own batch.
 */
const customIdOf = (batchId: number, itemId: number) => `b${batchId}-i${itemId}`;
const itemIdOf = (batchId: number, customId: string) => {
  const match = /^b(\d+)-i(\d+)$/.exec(customId);
  return match?.[1] === String(batchId) && match[2] !== undefined ? Number(match[2]) : undefined;
};

export function createBatchAnalysis(deps: {
  db: Db;
  offers: Offers;
  reader: OfferReader;
  ledger: SpendLedger;
  events: EventBus;
  /** Epoch milliseconds. */
  clock: () => number;
  keyOf: () => string | undefined;
  providerFor: (apiKey: string) => BatchProvider;
  realtimeHeld?: () => Iterable<number>;
  announce?: (offerIds: Iterable<number>) => void;
  statusChanged?: () => void;
  options?: BatchOptions;
}) {
  const { db, offers, reader, ledger, events, clock, keyOf } = deps;
  const touched = new Set<number>();
  function announceTouched(): void {
    if (touched.size === 0) return;
    const ids = [...touched];
    touched.clear();
    deps.announce?.(ids);
  }
  const size = deps.options?.size ?? DEFAULT_BATCH_SIZE;
  const pollMs = deps.options?.pollMs ?? DEFAULT_POLL_MS;
  const reconcileGraceMs = deps.options?.reconcileGraceMs ?? DEFAULT_RECONCILE_GRACE_MS;
  const state = createBatchState({
    db,
    clock,
    offers,
    onSettled: (row) => {
      touched.add(row.offerId);
      if (row.state in TALLY_COLUMN) {
        noteSettled({ ...row, state: row.state as keyof typeof TALLY_COLUMN });
      }
    },
  });

  let provider: { apiKey: string; provider: BatchProvider } | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  function providerOf(apiKey: string): BatchProvider {
    if (provider?.apiKey !== apiKey) {
      provider = {
        apiKey,
        provider: keyReportingBatch(deps.providerFor(apiKey), {
          db,
          key: apiKey,
          now,
          changed: () => deps.statusChanged?.(),
        }),
      };
    }
    return provider.provider;
  }

  const planOf = (settings: AnalysisSettings): AnalysisPlan => ({
    model: { model: settings.model, effort: settings.effort },
    escalation: settings.escalation,
  });

  const now = () => new Date(clock());

  function batchHeld(): Set<number> {
    const rows = db
      .selectDistinct({ offerId: analysisItems.offerId })
      .from(analysisItems)
      .where(inArray(analysisItems.state, [...WAITING]))
      .all();
    return new Set(rows.map((row) => row.offerId));
  }

  /** Nothing else may send these Offers, so no words are billed twice. */
  function heldOffers(): Set<number> {
    const held = batchHeld();
    for (const id of deps.realtimeHeld?.() ?? []) held.add(id);
    return held;
  }

  function heldBy(offerId: number): "batch" | "realtime" | undefined {
    if (batchHeld().has(offerId)) return "batch";
    for (const id of deps.realtimeHeld?.() ?? []) if (id === offerId) return "realtime";
    return undefined;
  }
  function hashOf(job: AnalysisJob): string | { failed: AnalysisErrorKind } {
    if (job.contentHash !== null) return job.contentHash;
    const page = reader.read(job);
    return typeof page === "string" ? { failed: page } : contentHash(page.text);
  }

  /** `holder: "realtime"`: the realtime worker that holds these Offers hands them over. */
  function enqueue(
    jobs: AnalysisJob[],
    options: { plan: AnalysisPlan; runId?: number; holder?: "realtime" },
  ): number {
    const held = options.holder === "realtime" ? batchHeld() : heldOffers();
    let queued = 0;
    db.$client.transaction(() => {
      for (const job of jobs) {
        if (held.has(job.id)) continue;
        const hash = hashOf(job);
        const base = {
          offerId: job.id,
          runId: options.runId ?? null,
          stage: 1 as const,
          plan: options.plan,
        };
        if (typeof hash !== "string") {
          state.addItem({ ...base, contentHash: "", failed: hash.failed });
          continue;
        }
        state.addItem({ ...base, contentHash: hash });
        touched.add(job.id);
        queued++;
      }
    })();
    announceTouched();
    return queued;
  }

  function outdatedJobs(settings: AnalysisSettings): AnalysisJob[] {
    const version = analysisVersion(planOf(settings).model);
    const held = heldOffers();
    return offers
      .analysisJobs()
      .filter((job) => onOlderAnalysis(job, version) && !held.has(job.id));
  }

  function waitingCount(runId: number, offerId?: number): number {
    const where = [eq(analysisItems.runId, runId), inArray(analysisItems.state, WAITING)];
    if (offerId !== undefined) where.push(eq(analysisItems.offerId, offerId));
    return (
      db
        .select({ n: sql<number>`count(*)` })
        .from(analysisItems)
        .where(and(...where))
        .get()?.n ?? 0
    );
  }

  const runRow = (runId: number): StoredRun | undefined =>
    db.select().from(analysisRuns).where(eq(analysisRuns.id, runId)).get() as StoredRun | undefined;

  const runningRuns = (): StoredRun[] =>
    db
      .select()
      .from(analysisRuns)
      .where(eq(analysisRuns.status, "running"))
      .orderBy(asc(analysisRuns.id))
      .all() as StoredRun[];

  const TALLY_COLUMN = {
    applied: "appliedCount",
    failed: "failedCount",
    capped: "cappedCount",
    dropped: "droppedCount",
  } as const;

  /** The only writer of a run's tally until the run settles. */
  function noteSettled(item: {
    runId: number | null;
    offerId: number;
    state: keyof typeof TALLY_COLUMN;
    errorKind: string | null;
  }): void {
    if (item.runId === null) return;
    const run = runRow(item.runId);
    if (run === undefined || run.status !== "running") return;
    if (waitingCount(run.id, item.offerId) > 0) return;
    const column = TALLY_COLUMN[item.state];
    const patch: Partial<typeof analysisRuns.$inferInsert> = {
      [column]: sql`${analysisRuns[column]} + 1`,
    };
    if (item.errorKind !== null && (item.state === "failed" || item.state === "capped")) {
      const kinds = parseKinds(run.errorKinds);
      kinds[item.errorKind] = (kinds[item.errorKind] ?? 0) + 1;
      patch.errorKinds = JSON.stringify(kinds);
    }
    db.update(analysisRuns).set(patch).where(eq(analysisRuns.id, run.id)).run();
  }

  function countsOf(run: StoredRun): RunView["counts"] {
    const tally = {
      applied: run.appliedCount,
      failed: run.failedCount,
      capped: run.cappedCount,
      dropped: run.droppedCount,
    };
    const settled = tally.applied + tally.failed + tally.capped + tally.dropped;
    return { total: run.offerCount, ...tally, pending: Math.max(0, run.offerCount - settled) };
  }

  function settleRun(run: StoredRun, interrupted = false): void {
    const { pending, ...counts } = countsOf(run);
    const tally = { ...counts, dropped: counts.dropped + pending };
    const { status, stopReason } = settledOutcome(tally, interrupted);
    db.update(analysisRuns)
      .set({ status, stopReason, finishedAt: now(), droppedCount: tally.dropped })
      .where(and(eq(analysisRuns.id, run.id), eq(analysisRuns.status, "running")))
      .run();
  }

  function settleIfIdle(runId: number): boolean {
    const run = runRow(runId);
    if (run?.status !== "running" || waitingCount(runId) > 0) return false;
    settleRun(run);
    return true;
  }

  function settleIdleRuns(): void {
    for (const run of runningRuns()) if (settleIfIdle(run.id)) publishRun(run.id);
  }

  /**
   * Runs inside the wipe's transaction, so runs are announced only once it commits; a rollback
   * leaves them.
   */
  function interruptRuns(): void {
    const settled: number[] = [];
    for (const run of runningRuns()) {
      if (!settleIfIdle(run.id)) settleRun(run, true);
      settled.push(run.id);
    }
    const announce = () => {
      for (const runId of settled) if (runRow(runId)?.status !== "running") publishRun(runId);
    };
    // better-sqlite3 transactions are synchronous: by the next microtask the outer one has ended.
    if (db.$client.inTransaction) queueMicrotask(announce);
    else announce();
  }

  function activeRunId(): number | undefined {
    settleIdleRuns();
    return runningRuns()[0]?.id;
  }

  function runView(runId: number): RunView | undefined {
    const run = runRow(runId);
    if (run === undefined) return undefined;
    const cost = db
      .select({ total: sql<number>`coalesce(sum(${analysisUsage.costMicros}), 0)` })
      .from(analysisUsage)
      .where(eq(analysisUsage.runId, runId))
      .get();
    return {
      id: run.id,
      status: run.status,
      createdAt: run.createdAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      analysisVersion: run.analysisVersion,
      estimatedCostUsd: run.estimatedCostMicros / MICROS,
      actualCostUsd: (cost?.total ?? 0) / MICROS,
      counts: countsOf(run),
      errorKinds: parseKinds(run.errorKinds),
      stopReason: run.stopReason,
    };
  }

  function publishRun(runId: number): void {
    const view = runView(runId);
    if (view === undefined) return;
    events.publish("analysis-run-progress", {
      runId,
      status: view.status,
      stopReason: view.stopReason,
      done: view.counts.total - view.counts.pending,
      applied: view.counts.applied,
      total: view.counts.total,
      spentUsd: ledger.spentUsd(),
    });
    if (view.status !== "running") deps.statusChanged?.();
  }

  function announceRun(runId: number | null | undefined): void {
    if (runId === null || runId === undefined) return;
    settleIfIdle(runId);
    publishRun(runId);
  }

  /**
   * A refused key would fail every request `unauthorized`, and a run with nothing outdated would
   * just say "succeeded".
   */
  function runRefusal(): StartRunRefusal | null {
    if (keyOf() === undefined) return "no-api-key";
    if (keyState(db) === "refused") return "api-key-refused";
    if (!ledger.fitsRun()) return "spend-cap-reached";
    if (activeRunId() !== undefined) return "analysis-run-active";
    if (outdatedJobs(loadAnalysisSettings(db)).length === 0) return "nothing-to-reanalyze";
    return null;
  }

  function startRun(): StartRun {
    ledger.sync();
    const refusal = runRefusal();
    if (refusal !== null) return { ok: false, reason: refusal };
    const settings = loadAnalysisSettings(db);
    const plan = planOf(settings);
    const jobs = outdatedJobs(settings);
    const run = db.$client.transaction(() => {
      const row = db
        .insert(analysisRuns)
        .values({
          createdAt: now(),
          analysisVersion: analysisVersion(plan.model),
          estimatedCostMicros: usdToMicros(estimateReanalysisUsd(jobs.length, settings)),
          offerCount: jobs.length,
        })
        .returning()
        .get();
      enqueue(jobs, { plan, runId: row.id });
      const inRun =
        db
          .select({ n: sql<number>`count(distinct ${analysisItems.offerId})` })
          .from(analysisItems)
          .where(eq(analysisItems.runId, row.id))
          .get()?.n ?? 0;
      if (inRun !== jobs.length) {
        db.update(analysisRuns).set({ offerCount: inRun }).where(eq(analysisRuns.id, row.id)).run();
      }
      return row;
    })();
    announceRun(run.id);
    deps.statusChanged?.();
    kick();
    const view = runView(run.id);
    if (view === undefined) throw new Error("the run vanished");
    return { ok: true, run: view };
  }

  const stepArgs = (
    job: AnalysisJob,
    page: Exclude<ReturnType<OfferReader["read"]>, string>,
    plan: AnalysisPlan,
  ): StepArgs => ({
    text: page.text,
    category: job.category,
    ruleFacts: page.facts,
    model: plan.model,
    escalation: plan.escalation,
  });

  function recordUsage(item: AnalysisItemRow, outcome: BatchOutcome): void {
    const usage = outcome.status === "succeeded" ? outcome.response.usage : outcome.usage;
    if (usage === undefined) return;
    const plan = JSON.parse(item.plan) as AnalysisPlan;
    const choice: ModelChoice | null = item.stage === 1 ? plan.model : plan.escalation;
    if (choice === null) return;
    ledger.record({
      model: choice.model,
      effort: choice.effort,
      batch: true,
      usage,
      runId: item.runId ?? undefined,
    });
  }

  function apply(item: AnalysisItemRow, outcome: BatchOutcome): number | undefined {
    recordUsage(item, outcome);
    const job = offers.analysisJob(item.offerId);
    if (job === undefined) {
      state.moveItem(item, { to: "dropped" });
      return undefined;
    }
    if (outcome.status === "failed") {
      // A failure for words the Offer no longer has says nothing about the new ones: it is not
      // an attempt on them and starts no backoff.
      if (job.contentHash !== null && job.contentHash !== item.contentHash) {
        state.moveItem(item, { to: "dropped" });
        return undefined;
      }
      state.moveItem(item, { to: "failed", kind: outcome.kind });
      return undefined;
    }
    const page = reader.read(job);
    if (typeof page === "string") {
      state.moveItem(item, { to: "failed", kind: page });
      return undefined;
    }
    if (contentHash(page.text) !== item.contentHash) {
      state.moveItem(item, { to: "dropped" });
      return undefined;
    }

    const plan = JSON.parse(item.plan) as AnalysisPlan;
    const args = stepArgs(job, page, plan);
    const analyzedAt = now().toISOString();
    try {
      if (item.stage === 1) {
        const step = readFirst(args, outcome.response);
        if (step.kind === "done") {
          offers.saveAnalysis(
            item.offerId,
            step.result.facts,
            makeRun({ plan, result: step.result, analyzedAt, contentHash: item.contentHash }),
          );
        } else {
          if (job.state !== "analyzed") {
            offers.saveAnalysis(
              item.offerId,
              step.provisional.facts,
              makeRun({
                plan,
                result: step.provisional,
                analyzedAt,
                contentHash: item.contentHash,
              }),
              { carry: step.state, plan, contentHash: item.contentHash },
            );
          }
          state.addItem({
            offerId: item.offerId,
            runId: item.runId,
            stage: 2,
            contentHash: item.contentHash,
            plan,
            carry: step.state,
          });
          // As in realtime: on an analyzed Offer nothing is saved, so the queued request is all
          // that carries a click's reading on.
          if (job.state === "analyzed") offers.handOverReanalysis(item.offerId);
        }
      } else {
        const carry = JSON.parse(item.carry ?? "null") as EscalationState | null;
        if (carry === null) throw new Error("no first pass to merge");
        const result = readSecond(args, carry, outcome.response);
        offers.saveAnalysis(
          item.offerId,
          result.facts,
          makeRun({ plan, result, analyzedAt, contentHash: item.contentHash }),
        );
      }
    } catch {
      state.moveItem(item, { to: "failed", kind: "invalid_response" });
      return undefined;
    }
    state.moveItem(item, { to: "applied" });
    return item.offerId;
  }

  function unresolvedSends(): number {
    return (
      db
        .select({ n: sql<number>`count(*)` })
        .from(analysisBatches)
        .where(eq(analysisBatches.state, "submitting"))
        .get()?.n ?? 0
    );
  }

  /**
   * Results whose item is gone (wiped or pruned) were billed all the same; they are priced from
   * the requests the batch row remembers.
   */
  function recordOrphans(batch: AnalysisBatchRow, byItem: Map<number, BatchOutcome>): void {
    const known = new Set(
      db
        .select({ id: analysisItems.id })
        .from(analysisItems)
        .where(eq(analysisItems.batchId, batch.id))
        .all()
        .map((row) => row.id),
    );
    let sent: {
      itemId: number;
      model: string;
      effort: ModelChoice["effort"];
      runId?: number | null;
    }[] = [];
    try {
      sent = JSON.parse(batch.requests);
    } catch {
      // Nothing remembered: the reservation below covers it.
    }
    let missing = 0;
    for (const [itemId, outcome] of byItem) {
      if (known.has(itemId)) continue;
      const usage = outcome.status === "succeeded" ? outcome.response.usage : outcome.usage;
      if (usage === undefined) continue;
      const request = sent.find((entry) => entry.itemId === itemId);
      if (request === undefined) {
        missing++;
        continue;
      }
      ledger.record({
        model: request.model,
        effort: request.effort,
        batch: true,
        usage,
        runId: request.runId ?? undefined,
      });
    }
    if (missing > 0) ledger.recordUnconfirmed(batch.reservedMicros);
  }

  function setBatch(id: number, patch: Pick<typeof analysisBatches.$inferInsert, "checkFailures">) {
    db.update(analysisBatches).set(patch).where(eq(analysisBatches.id, id)).run();
  }

  function announceRunsOf(items: Pick<AnalysisItemRow, "runId">[]): void {
    for (const runId of new Set(
      items.flatMap((item) => (item.runId === null ? [] : [item.runId])),
    )) {
      announceRun(runId);
    }
  }

  /** The reservation counts as spent, so no cap really used is freed. */
  function giveUp(batch: AnalysisBatchRow, kind: AnalysisErrorKind): void {
    ledger.recordUnconfirmed(batch.reservedMicros);
    announceRunsOf(state.moveBatch(batch, { to: "ended", reason: "given_up", kind }));
  }

  /** Until a batch is found or ruled out, its reservation stays and its Offers go nowhere else. */
  async function reconcile(): Promise<void> {
    const all = db
      .select()
      .from(analysisBatches)
      .where(eq(analysisBatches.state, "submitting"))
      .orderBy(asc(analysisBatches.id))
      .all();
    // Past what the API keeps, a batch can never be found: stop holding the money, key or no key.
    const unsure = all.filter((batch) => {
      if (clock() - batch.createdAt.getTime() < MAX_BATCH_AGE_MS) return true;
      giveUp(batch, "expired");
      return false;
    });
    const apiKey = keyOf();
    if (unsure.length === 0 || apiKey === undefined) return;
    const api = providerOf(apiKey);
    const claimed = new Set(
      db
        .select({ id: analysisBatches.providerBatchId })
        .from(analysisBatches)
        .all()
        .flatMap((row) => (row.id === null ? [] : [row.id])),
    );
    for (const batch of unsure) {
      if (stopped) return;
      const age = clock() - batch.createdAt.getTime();
      let found: string | undefined;
      try {
        found = await api.find({
          // The API's clock and ours may differ by a little.
          since: batch.createdAt.getTime() - MINUTE,
          requestCount: batch.requestCount,
          exclude: [...claimed],
        });
      } catch (error) {
        console.error(
          `Looking for a batch failed: ${error instanceof ProviderError ? error.kind : "error"}`,
        );
        continue;
      }
      if (found !== undefined) {
        claimed.add(found);
        state.moveBatch(batch, { to: "in_progress", providerBatchId: found });
        continue;
      }
      if (age < reconcileGraceMs) continue;
      state.moveBatch(batch, { to: "ended", reason: "never_created" });
    }
  }

  /** Canceling stops further billing; a canceled batch's results are read when it ends. */
  async function enforceCap(): Promise<void> {
    if (ledger.headroomMicros() >= 0) return;
    const apiKey = keyOf();
    if (apiKey !== undefined) {
      const api = providerOf(apiKey);
      const live = db
        .select()
        .from(analysisBatches)
        .where(eq(analysisBatches.state, "in_progress"))
        .all();
      for (const batch of live) {
        try {
          await api.cancel(providerIdOf(batch));
          state.moveBatch(batch, { to: "canceling" });
        } catch (error) {
          console.error(
            `Canceling a batch failed: ${error instanceof ProviderError ? error.kind : "error"}`,
          );
        }
      }
    }
    capQueued();
  }

  async function collect(): Promise<void> {
    const open = db
      .select()
      .from(analysisBatches)
      .where(inArray(analysisBatches.state, ["in_progress", "canceling"]))
      .orderBy(asc(analysisBatches.id))
      .all()
      .filter((batch) => {
        if (clock() - batch.createdAt.getTime() < MAX_BATCH_AGE_MS) return true;
        giveUp(batch, "expired");
        return false;
      });
    const apiKey = keyOf();
    if (apiKey === undefined || open.length === 0) return;
    const api = providerOf(apiKey);
    for (const batch of open) {
      if (stopped) continue;
      let outcomes: BatchOutcome[];
      let checkFailures = batch.checkFailures;
      try {
        const providerId = providerIdOf(batch);
        const { ended } = await api.status(providerId);
        if (checkFailures > 0) {
          checkFailures = 0;
          setBatch(batch.id, { checkFailures });
        }
        if (!ended) continue;
        outcomes = await api.results(providerId);
      } catch (error) {
        const kind = error instanceof ProviderError ? error.kind : "server_error";
        // Only the kind is ever logged.
        console.error(`Looking at a batch failed: ${kind}`);
        // An API that answers "no" again and again no longer knows the batch. A refused key is
        // not counted: no other call can be made with it either, and a new key may read it back.
        if (policyOf(kind).batchGone) {
          checkFailures++;
          if (checkFailures >= MAX_CHECK_FAILURES) giveUp(batch, kind);
          else setBatch(batch.id, { checkFailures });
        }
        continue;
      }
      if (stopped) return;
      const byItem = new Map(
        outcomes.flatMap((o) => {
          const id = itemIdOf(batch.id, o.customId);
          return id === undefined ? [] : [[id, o] as const];
        }),
      );
      const items = db
        .select()
        .from(analysisItems)
        .where(and(eq(analysisItems.batchId, batch.id), eq(analysisItems.state, "submitted")))
        .all();
      // Results that match none of this batch's request ids are another batch's: this was not
      // the batch that was sent. Its reservation is counted as spent, not released.
      if (outcomes.length > 0 && byItem.size === 0) {
        ledger.recordUnconfirmed(batch.reservedMicros);
      } else {
        recordOrphans(batch, byItem);
      }
      const runs = new Set<number>();
      // Each result and its cost are written together, so a restart halfway never counts one twice.
      for (const item of items) {
        db.$client.transaction(() => {
          const outcome: BatchOutcome = byItem.get(item.id) ?? {
            customId: customIdOf(batch.id, item.id),
            status: "failed",
            kind: "invalid_response",
          };
          apply(item, outcome);
        })();
        if (item.runId !== null) runs.add(item.runId);
      }
      state.moveBatch(batch, { to: "ended", reason: "completed" });
      announceTouched();
      for (const runId of runs) announceRun(runId);
    }
  }

  function queuedItems(): AnalysisItemRow[] {
    return db
      .select()
      .from(analysisItems)
      .where(eq(analysisItems.state, "queued"))
      .orderBy(asc(analysisItems.id))
      .limit(size)
      .all();
  }

  function capQueued(): void {
    const stuck = db.select().from(analysisItems).where(eq(analysisItems.state, "queued")).all();
    const runs = new Set<number>();
    for (const item of stuck) {
      if (item.runId === null && !state.clickEscalation(item)) {
        // Not in a run and not a click's escalation, so nobody waits on it: the worker's sweep
        // queues it again when there is room.
        state.moveItem(item, { to: "discarded" });
        touched.add(item.offerId);
        continue;
      }
      state.moveItem(item, { to: "capped" });
      if (item.runId !== null) runs.add(item.runId);
    }
    ledger.sync();
    for (const runId of runs) announceRun(runId);
  }

  async function submit(): Promise<void> {
    const apiKey = keyOf();
    if (apiKey === undefined) return;
    const api = providerOf(apiKey);

    while (!stopped) {
      // A send that got no answer may have created a batch. Until it is found or known not to
      // exist, nothing else is sent: a second batch of the same size could be taken for it.
      if (unresolvedSends() > 0) return;
      const chunk = queuedItems();
      if (chunk.length === 0) return;

      const built: {
        item: AnalysisItemRow;
        request: ReturnType<typeof firstRequest>;
        micros: number;
      }[] = [];
      let progressed = false;
      for (const item of chunk) {
        const job = offers.analysisJob(item.offerId);
        if (job === undefined) {
          state.moveItem(item, { to: "dropped" });
          progressed = true;
          continue;
        }
        const page = reader.read(job);
        if (typeof page === "string") {
          state.moveItem(item, { to: "failed", kind: page });
          progressed = true;
          continue;
        }
        if (contentHash(page.text) !== item.contentHash) {
          state.moveItem(item, { to: "dropped" });
          progressed = true;
          continue;
        }
        const plan = JSON.parse(item.plan) as AnalysisPlan;
        const args = stepArgs(job, page, plan);
        const request = item.stage === 1 ? firstRequest(args) : escalationRequest(args);
        const micros = ledger.estimateMicros(request, { batch: true });
        if (micros === undefined) {
          state.moveItem(item, { to: "failed", kind: "unpriced" });
          progressed = true;
          continue;
        }
        built.push({ item, request, micros });
      }

      const headroom = ledger.headroomMicros();
      const fit: typeof built = [];
      let reserved = 0;
      for (const entry of built) {
        // A smaller request further down may still fit where this one does not.
        if (reserved + entry.micros > headroom) continue;
        fit.push(entry);
        reserved += entry.micros;
      }

      if (fit.length === 0) {
        if (built.length === 0) {
          if (progressed) continue;
          return;
        }
        // Nothing fits. If batches are in flight their cost will replace their reservations and
        // may leave room; if not, the cap is spent.
        if (ledger.reservedMicros() === 0) capQueued();
        return;
      }

      const batchRow = state.beginSend({
        items: fit.map(({ item }) => item),
        reservedMicros: reserved,
        requests: fit.map(({ item, request }) => ({
          itemId: item.id,
          model: request.model,
          effort: request.effort,
          runId: item.runId,
        })),
      });

      try {
        const { batchId } = await api.submit(
          fit.map(({ item, request }) => ({
            customId: customIdOf(batchRow.id, item.id),
            request,
          })),
        );
        state.moveBatch(batchRow, { to: "in_progress", providerBatchId: batchId });
      } catch (error) {
        const kind = error instanceof ProviderError ? error.kind : "server_error";
        console.error(`Sending a batch failed: ${kind}`);
        const policy = policyOf(kind);
        if (policy.mayHaveCreatedBatch || !(error instanceof ProviderError)) {
          // The batch may exist, and be billed: it stays reserved and its requests stay with it,
          // not sent anywhere else, until `reconcile` finds it or knows it is not there.
          return;
        }
        announceRunsOf(state.moveBatch(batchRow, { to: "ended", reason: "send_refused", kind }));
        if (policy.stopsQueue) return;
        continue;
      }
      for (const runId of new Set(
        fit.flatMap(({ item }) => (item.runId === null ? [] : [item.runId])),
      )) {
        announceRun(runId);
      }
    }
  }

  function prune(): void {
    const before = new Date(clock() - PRUNE_AFTER_MS);
    db.delete(analysisItems)
      .where(
        and(
          isNull(analysisItems.runId),
          inArray(analysisItems.state, [...SETTLED]),
          lt(analysisItems.finishedAt, before),
        ),
      )
      .run();
    state.pruneEnded(before);
  }

  async function tick(): Promise<void> {
    await reconcile();
    await collect();
    await enforceCap();
    await submit();
    settleIdleRuns();
    prune();
    if (!stopped) ledger.sync();
  }

  function kick(): void {
    if (stopped) return;
    if (running !== undefined) {
      again = true;
      return;
    }
    again = false;
    running = tick()
      .catch((error) => {
        if (!stopped) {
          console.error(
            `Batch analysis stopped on an error: ${error instanceof Error ? error.name : "error"}`,
          );
        }
      })
      .finally(() => {
        running = undefined;
        if (!stopped) announceTouched();
        if (again) kick();
      });
  }

  const idle = async (): Promise<void> => {
    while (running !== undefined) await running;
  };

  return {
    enqueue,
    heldOffers,
    heldBy,
    enqueueEscalation(args: {
      offerId: number;
      contentHash: string;
      plan: AnalysisPlan;
      state: EscalationState;
    }): void {
      // Only a batch request counts here: the realtime worker that asks holds the Offer itself.
      if (batchHeld().has(args.offerId)) return;
      state.addItem({
        offerId: args.offerId,
        runId: null,
        stage: 2,
        contentHash: args.contentHash,
        plan: args.plan,
        carry: args.state,
      });
    },
    outdatedJobs,
    runRefusal,
    startRun,
    run(runId: number): RunView | undefined {
      settleIdleRuns();
      return runView(runId);
    },
    activeRunId,
    interruptRuns,
    planOf,
    kick,
    idle,
    async poll(): Promise<void> {
      await idle();
      kick();
      await idle();
    },
    start(): void {
      stopped = false;
      if (timer !== undefined) clearInterval(timer);
      kick();
      timer = setInterval(kick, pollMs);
      timer.unref();
    },
    stop(): void {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
    },
  };
}
