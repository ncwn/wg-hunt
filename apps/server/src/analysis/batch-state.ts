import { type AnalysisErrorKind, type EscalationState, policyOf } from "@wg-hunt/core";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import {
  type AnalysisBatchRow,
  type AnalysisBatchState,
  type AnalysisItemRow,
  type AnalysisItemState,
  analysisBatches,
  analysisItems,
  type BatchEndReason,
} from "../db/schema.js";
import type { Offers } from "../offers/offers.js";
import type { AnalysisPlan } from "./record.js";

export type ItemMove =
  | { to: "submitted"; batchId: number }
  | { to: "queued" }
  | { to: "applied" }
  /** A kind that is not a failure of the Offer (the cap, a canceled batch) settles as `capped`. */
  | { to: "failed"; kind: AnalysisErrorKind }
  | { to: "capped" }
  | { to: "dropped" }
  | { to: "discarded" };

export type BatchMove =
  | { to: "in_progress"; providerBatchId: string }
  | { to: "canceling" }
  | { to: "ended"; reason: "completed" }
  | { to: "ended"; reason: "never_created" }
  | { to: "ended"; reason: "send_refused"; kind: AnalysisErrorKind }
  | { to: "ended"; reason: "given_up"; kind: AnalysisErrorKind };

const ITEM_FROM: Record<ItemMove["to"], readonly AnalysisItemState[]> = {
  submitted: ["queued"],
  queued: ["submitted"],
  applied: ["submitted"],
  failed: ["queued", "submitted"],
  capped: ["queued", "submitted"],
  dropped: ["queued", "submitted"],
  discarded: ["queued"],
};

const BATCH_FROM: Record<
  Exclude<BatchMove["to"], "ended"> | BatchEndReason,
  readonly AnalysisBatchState[]
> = {
  in_progress: ["submitting"],
  canceling: ["in_progress"],
  completed: ["in_progress", "canceling"],
  never_created: ["submitting"],
  send_refused: ["submitting"],
  given_up: ["submitting", "in_progress", "canceling"],
};

export const WAITING: readonly AnalysisItemState[] = ["queued", "submitted"];
export const SETTLED: readonly AnalysisItemState[] = ["applied", "failed", "capped", "dropped"];

/**
 * Runs in the merge's transaction, before the absorbed Offer's row goes and takes its other items
 * along. `words`: the merged Offer's `contentHash`. A request for other words stays behind: on the
 * survivor it would hold the Offer until its batch ends, only to be dropped.
 */
export function carryWaiting(
  db: Db,
  absorbedId: number,
  survivorId: number,
  words: string | null,
): void {
  db.update(analysisItems)
    .set({ offerId: survivorId })
    .where(
      and(
        eq(analysisItems.offerId, absorbedId),
        inArray(analysisItems.state, WAITING),
        words === null ? undefined : eq(analysisItems.contentHash, words),
      ),
    )
    .run();
  const waiting = db
    .select()
    .from(analysisItems)
    .where(and(eq(analysisItems.offerId, survivorId), inArray(analysisItems.state, WAITING)))
    // The one furthest along stays, and a run's before one nobody counts.
    .orderBy(
      desc(analysisItems.stage),
      desc(analysisItems.state),
      sql`${analysisItems.runId} is null`,
      asc(analysisItems.id),
    )
    .all();
  const carried = new Set<string>();
  for (const item of waiting) {
    if (!carried.has(item.contentHash)) {
      carried.add(item.contentHash);
      continue;
    }
    // Both Offers were waiting on these words. A second answer would overwrite a newer result or
    // ask for a second escalation; one already sent is still priced, as an orphan of its batch.
    db.delete(analysisItems).where(eq(analysisItems.id, item.id)).run();
  }
}

export type SentRequest = {
  itemId: number;
  model: string;
  effort: string | null;
  runId: number | null;
};

/** The one writer of `analysis_items.state` and `analysis_batches.state`. */
export function createBatchState(deps: {
  db: Db;
  /** Epoch milliseconds. */
  clock: () => number;
  offers: Pick<Offers, "analysisJob" | "failAnalysis">;
  /** Called inside the same transaction; not for a discarded item. */
  onSettled?: (item: AnalysisItemRow) => void;
}) {
  const { db, clock, offers, onSettled } = deps;
  const now = () => new Date(clock());
  // Nested inside another transaction, this is a savepoint.
  const atomically = <T>(fn: () => T): T => db.$client.transaction(fn)();

  function patchOf(move: Exclude<ItemMove, { to: "discarded" }>) {
    switch (move.to) {
      case "submitted":
        return { state: "submitted" as const, batchId: move.batchId };
      case "queued":
        return { state: "queued" as const, batchId: null };
      case "applied":
      case "dropped":
        return { state: move.to, errorKind: null, finishedAt: now() };
      case "capped":
        return { state: "capped" as const, errorKind: "spend_cap_reached", finishedAt: now() };
      case "failed": {
        const state = policyOf(move.kind).perOffer === "not-a-failure" ? "capped" : "failed";
        return { state, errorKind: move.kind, finishedAt: now() } as const;
      }
    }
  }

  /**
   * The escalation of a click on an analyzed Offer. The Offer kept its result rather than the first
   * pass, so it holds nothing for the worker's sweep to send the escalation again from.
   */
  function clickEscalation(item: Pick<AnalysisItemRow, "offerId" | "runId" | "stage">): boolean {
    if (item.runId !== null || item.stage !== 2) return false;
    const job = offers.analysisJob(item.offerId);
    return job?.state === "analyzed" && job.escalation === null;
  }

  function moveItem(item: Pick<AnalysisItemRow, "id" | "offerId">, move: ItemMove): boolean {
    return atomically(() => {
      const where = and(
        eq(analysisItems.id, item.id),
        inArray(analysisItems.state, [...ITEM_FROM[move.to]]),
      );
      if (move.to === "discarded") return db.delete(analysisItems).where(where).run().changes > 0;
      const patch = patchOf(move);
      const moved = db.update(analysisItems).set(patch).where(where).returning().get();
      if (moved === undefined) return false;
      if (patch.state === "failed" && move.to === "failed") {
        offers.failAnalysis(item.offerId, move.kind);
      }
      // However it got here (the cap on the queue, a canceled batch): the click and its paid first
      // pass end with this item. The Offer keeps its previous result and says the click was cut
      // short, so only another click reads it again.
      if (moved.state === "capped" && clickEscalation(moved)) {
        offers.failAnalysis(moved.offerId, "spend_cap_reached");
      }
      if (SETTLED.includes(moved.state)) onSettled?.(moved);
      return true;
    });
  }

  function addItem(args: {
    offerId: number;
    runId: number | null;
    stage: 1 | 2;
    contentHash: string;
    plan: AnalysisPlan;
    carry?: EscalationState;
    failed?: AnalysisErrorKind;
  }): void {
    atomically(() => {
      const row = db
        .insert(analysisItems)
        .values({
          offerId: args.offerId,
          runId: args.runId,
          stage: args.stage,
          state: args.failed === undefined ? "queued" : "failed",
          contentHash: args.contentHash,
          plan: JSON.stringify(args.plan),
          carry: args.carry ? JSON.stringify(args.carry) : null,
          errorKind: args.failed ?? null,
          createdAt: now(),
          finishedAt: args.failed === undefined ? null : now(),
        })
        .returning()
        .get();
      if (args.failed !== undefined) {
        offers.failAnalysis(args.offerId, args.failed);
        onSettled?.(row);
      }
    });
  }

  function beginSend(args: {
    items: Pick<AnalysisItemRow, "id" | "offerId">[];
    reservedMicros: number;
    requests: SentRequest[];
  }): AnalysisBatchRow {
    return atomically(() => {
      const batch = db
        .insert(analysisBatches)
        .values({
          state: "submitting",
          reservedMicros: args.reservedMicros,
          requestCount: args.items.length,
          requests: JSON.stringify(args.requests),
          createdAt: now(),
        })
        .returning()
        .get();
      for (const item of args.items) {
        if (!moveItem(item, { to: "submitted", batchId: batch.id })) {
          throw new Error(`item ${item.id} is no longer queued`);
        }
      }
      return batch;
    });
  }

  function submittedIn(batchId: number): AnalysisItemRow[] {
    return db
      .select()
      .from(analysisItems)
      .where(and(eq(analysisItems.batchId, batchId), eq(analysisItems.state, "submitted")))
      .all();
  }

  function moveBatch(batch: Pick<AnalysisBatchRow, "id">, move: BatchMove): AnalysisItemRow[] {
    return atomically(() => {
      const key = move.to === "ended" ? move.reason : move.to;
      const patch =
        move.to === "in_progress"
          ? { state: move.to, providerBatchId: move.providerBatchId }
          : move.to === "canceling"
            ? { state: move.to, canceledAt: now() }
            : { state: move.to, endReason: move.reason, endedAt: now() };
      const moved = db
        .update(analysisBatches)
        .set(patch)
        .where(
          and(
            eq(analysisBatches.id, batch.id),
            inArray(analysisBatches.state, [...BATCH_FROM[key]]),
          ),
        )
        .run().changes;
      if (moved === 0) throw new Error(`batch ${batch.id} can't move to ${key}`);
      if (move.to !== "ended" || move.reason === "completed") return [];
      const items = submittedIn(batch.id);
      for (const item of items) {
        moveItem(
          item,
          move.reason === "never_created" ? { to: "queued" } : { to: "failed", kind: move.kind },
        );
      }
      return items;
    });
  }

  /** Items stay: a run's history needs them. */
  function pruneEnded(before: Date): void {
    atomically(() => {
      const ids = db
        .select({ id: analysisBatches.id })
        .from(analysisBatches)
        .where(and(eq(analysisBatches.state, "ended"), lt(analysisBatches.endedAt, before)))
        .all()
        .map((row) => row.id);
      if (ids.length === 0) return;
      db.update(analysisItems)
        .set({ batchId: null })
        .where(inArray(analysisItems.batchId, ids))
        .run();
      db.delete(analysisBatches).where(inArray(analysisBatches.id, ids)).run();
    });
  }

  return { addItem, moveItem, beginSend, moveBatch, pruneEnded, clickEscalation };
}
