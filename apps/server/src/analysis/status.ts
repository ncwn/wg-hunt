import { isPageFailure } from "@wg-hunt/core";
import type { AnalysisJob, AnalysisState } from "../offers/offers.js";
import type { KeyState } from "./key.js";
import { MAX_ATTEMPTS, retryAt } from "./retry.js";
import type { CapState } from "./spend.js";

/** Not the stored `analysisState`, which the facts come from: what happens next and why. */
export const ANALYSIS_STATUSES = [
  "reading",
  "queued",
  "in-batch",
  "provisional",
  "words-changed",
  "retry-at",
  "needs-click",
  "waiting-for-page",
  "waiting-for-key",
  "key-refused",
  "waiting-for-cap",
  "waiting-for-in-flight",
  "kept-previous",
  "escalation-lost",
  "older-version",
  "analyzed",
  "stale",
] as const;
export type AnalysisStatusKind = (typeof ANALYSIS_STATUSES)[number];

export const ANALYSIS_NEXT = [
  "none",
  "wait",
  "add-key",
  "replace-key",
  "raise-cap",
  "reanalyze",
  "start-run",
  "recheck",
] as const;
type AnalysisNext = (typeof ANALYSIS_NEXT)[number];

export type AnalysisStatus = {
  status: AnalysisStatusKind;
  next: AnalysisNext;
  reason: string | null;
  at: string | null;
  willRead: boolean;
};

export type AnalysisStatusInput = {
  state: AnalysisState;
  stale: boolean;
  wordsChanged: boolean;
  olderVersion: boolean;
  provisional: boolean;
  escalationResends: number;
  failure: AnalysisJob["failure"];
  contentHash: string | null;
  held: { stage: 1 | 2; since: Date } | null;
  reading: boolean;
  /**
   * Its call went out and its outcome could not be stored, so the worker sends it again only after
   * a new click.
   */
  unstored: boolean;
  /** A Re-analyse click answered `202` whose read has not ended. */
  owed: boolean;
  /** The worker last found that what is left of the cap pays for neither of this Offer's calls. */
  noRoom: boolean;
  key: KeyState;
  /** `fitsRun`: what is left of the cap pays for one Offer's whole read in a run. */
  cap: { state: CapState; resetsAt: string | null; fitsRun: boolean };
  /** Epoch ms. */
  now: number;
};

/** A `reason` that is no error kind: nothing failed that a stored failure could name. */
const OUTCOME_NOT_STORED = "outcome_not_stored";

const NEXT: Record<AnalysisStatusKind, AnalysisNext> = {
  reading: "wait",
  queued: "wait",
  "in-batch": "wait",
  provisional: "wait",
  "words-changed": "wait",
  "retry-at": "wait",
  "needs-click": "reanalyze",
  "waiting-for-page": "recheck",
  "waiting-for-key": "add-key",
  "key-refused": "replace-key",
  "waiting-for-cap": "raise-cap",
  "waiting-for-in-flight": "wait",
  "kept-previous": "reanalyze",
  "escalation-lost": "reanalyze",
  "older-version": "start-run",
  analyzed: "none",
  stale: "none",
};

/** A backoff is left out: its wait can be hours. What is in flight settles within minutes. */
const WILL_READ: readonly AnalysisStatusKind[] = [
  "reading",
  "queued",
  "in-batch",
  "provisional",
  "words-changed",
  "waiting-for-in-flight",
];

function make(
  status: AnalysisStatusKind,
  extra: { reason?: string | null; at?: string | Date | number | null } = {},
): AnalysisStatus {
  const at = extra.at ?? null;
  return {
    status,
    next: NEXT[status],
    reason: extra.reason ?? null,
    at: at === null ? null : new Date(at).toISOString(),
    willRead: WILL_READ.includes(status),
  };
}

/** On a page failure a click would read the same stored page and fail at once. */
function afterFailure(
  status: "kept-previous" | "escalation-lost",
  failure: AnalysisJob["failure"],
): AnalysisStatus {
  const kept = make(status, { reason: failure?.kind ?? null });
  return failure !== null && isPageFailure(failure.kind) ? { ...kept, next: "recheck" } : kept;
}

/** A failure that waits for a click is left to the caller. */
function blocker(input: AnalysisStatusInput): AnalysisStatus | undefined {
  if (input.key === "absent") return make("waiting-for-key");
  if (input.key === "refused") return make("key-refused", { reason: "unauthorized" });
  const failure = input.failure;
  // A click runs whatever the Offer's state: no backoff holds it.
  if (failure !== null && !input.owed) {
    const at = retryAt(input);
    if (at !== "never" && at > input.now) return make("retry-at", { reason: failure.kind, at });
  }
  if (input.cap.state === "reached") return make("waiting-for-cap", { at: input.cap.resetsAt });
  if (input.cap.state === "waiting-for-in-flight") return make("waiting-for-in-flight");
  if (input.noRoom) return make("waiting-for-cap", { at: input.cap.resetsAt });
  return undefined;
}

/** A Recheck needs neither a key nor room under the cap, so `recheck` stands. */
function untilClicked(status: AnalysisStatus, input: AnalysisStatusInput): AnalysisStatus {
  if (status.next !== "reanalyze" && status.next !== "start-run") return status;
  if (input.key === "absent") return { ...status, next: "add-key" };
  if (input.key === "refused") return { ...status, next: "replace-key" };
  if (input.cap.state === "reached")
    return { ...status, next: "raise-cap", at: input.cap.resetsAt };
  if (input.cap.state === "waiting-for-in-flight") return { ...status, next: "raise-cap" };
  if (status.next === "start-run" && !input.cap.fitsRun) {
    return { ...status, next: "raise-cap", at: input.cap.resetsAt };
  }
  return status;
}

export function deriveAnalysisStatus(input: AnalysisStatusInput): AnalysisStatus {
  return untilClicked(statusOf(input), input);
}

function statusOf(input: AnalysisStatusInput): AnalysisStatus {
  if (input.reading) return make("reading");
  if (input.stale) return make("stale");
  // A request a batch holds is read whatever the cap says now: its money is reserved. Not without
  // a key, though: no batch is sent or read back then, and a refused key is refused again.
  if (input.key === "absent" && input.held !== null) return make("waiting-for-key");
  if (input.key === "refused" && input.held !== null) {
    return make("key-refused", { reason: "unauthorized" });
  }
  if (input.held !== null) {
    return input.held.stage === 2 && input.provisional
      ? make("provisional", { at: input.held.since })
      : make("in-batch", { at: input.held.since });
  }
  if (input.unstored) {
    return make(input.state === "analyzed" ? "kept-previous" : "needs-click", {
      reason: OUTCOME_NOT_STORED,
    });
  }
  if (input.owed) return blocker(input) ?? make("queued");
  const failure = input.failure;
  if (input.state === "analyzed") {
    if (input.wordsChanged) return make("words-changed");
    if (input.provisional) {
      if (retryAt(input) === "never" || input.escalationResends >= MAX_ATTEMPTS) {
        return afterFailure("escalation-lost", failure);
      }
      return blocker(input) ?? make("provisional");
    }
    if (failure !== null) return afterFailure("kept-previous", failure);
    if (input.olderVersion) return make("older-version");
    return make("analyzed");
  }
  if (failure !== null && isPageFailure(failure.kind)) {
    return make("waiting-for-page", { reason: failure.kind });
  }
  if (input.key === "absent") return make("waiting-for-key");
  if (input.key === "refused") return make("key-refused", { reason: "unauthorized" });
  if (failure !== null && retryAt(input) === "never") {
    return make("needs-click", { reason: failure.kind });
  }
  return blocker(input) ?? make("queued");
}

export function countByStatus(
  statuses: Iterable<AnalysisStatus>,
): Record<AnalysisStatusKind, number> {
  const counts = Object.fromEntries(ANALYSIS_STATUSES.map((status) => [status, 0])) as Record<
    AnalysisStatusKind,
    number
  >;
  for (const { status } of statuses) counts[status]++;
  return counts;
}
