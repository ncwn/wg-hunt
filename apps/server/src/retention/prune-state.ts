import { PRUNE_RETRY } from "./constants.js";
import { nextScheduledPrune } from "./schedule.js";

const MINUTE = 60_000;

export type PruneDeleted = {
  offers: number;
  snapshots: number;
  unexpectedPages: number;
  requests: number;
};

/** Only the kind is kept: an error's message can name files in the data folder. */
export const PRUNE_ERROR_KINDS = [
  "disk-full",
  "database-busy",
  "database-error",
  "unknown",
] as const;
export type PruneErrorKind = (typeof PRUNE_ERROR_KINDS)[number];

/** Epoch milliseconds. */
export type PruneSuccess = { startedAt: number; finishedAt: number; deleted: PruneDeleted | null };
/** Epoch milliseconds. */
export type PruneFailure = { startedAt: number; finishedAt: number; error: PruneErrorKind };

export type PruneState =
  | { state: "never" }
  | { state: "ok"; lastSuccess: PruneSuccess }
  /** `lastSuccess` is null when none ever finished. */
  | {
      state: "failing";
      lastFailure: PruneFailure;
      failures: number;
      failingSince: number;
      lastSuccess: PruneSuccess | null;
    };

/** The one place the state changes. */
export function afterAttempt(prev: PruneState, attempt: PruneSuccess | PruneFailure): PruneState {
  if (!("error" in attempt)) return { state: "ok", lastSuccess: attempt };
  return {
    state: "failing",
    lastFailure: attempt,
    failures: prev.state === "failing" ? prev.failures + 1 : 1,
    failingSince: prev.state === "failing" ? prev.failingSince : attempt.startedAt,
    lastSuccess: prev.state === "never" ? null : prev.lastSuccess,
  };
}

export function retryDelayMs(failures: number): number {
  const doubled = PRUNE_RETRY.firstMinutes * 2 ** Math.max(0, failures - 1);
  return Math.min(doubled, PRUNE_RETRY.maxMinutes) * MINUTE;
}

/**
 * Epoch milliseconds; undefined when the next check starts it. After a success it is the next
 * 03:00 Berlin, so a night the host was off is made up.
 */
export function nextAttemptAt(state: PruneState): number | undefined {
  switch (state.state) {
    case "never":
      return undefined;
    case "ok":
      return nextScheduledPrune(state.lastSuccess.startedAt + 1);
    case "failing":
      return state.lastFailure.finishedAt + retryDelayMs(state.failures);
  }
}

export function pruneErrorKind(err: unknown): PruneErrorKind {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== "string") return "unknown";
  if (code === "SQLITE_FULL" || code === "ENOSPC") return "disk-full";
  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) return "database-busy";
  if (code.startsWith("SQLITE_")) return "database-error";
  return "unknown";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function parseDeleted(value: unknown): PruneDeleted | null {
  if (!isRecord(value)) return null;
  const { offers, snapshots, unexpectedPages, requests } = value;
  return isTime(offers) && isTime(snapshots) && isTime(unexpectedPages) && isTime(requests)
    ? { offers, snapshots, unexpectedPages, requests }
    : null;
}

function parseSuccess(value: unknown): PruneSuccess | null {
  if (!isRecord(value) || !isTime(value.startedAt) || !isTime(value.finishedAt)) return null;
  return {
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    deleted: parseDeleted(value.deleted),
  };
}

function parseFailure(value: unknown): PruneFailure | null {
  if (!isRecord(value) || !isTime(value.startedAt) || !isTime(value.finishedAt)) return null;
  // A kind only a later version knows is still a failure.
  const error = PRUNE_ERROR_KINDS.find((kind) => kind === value.error) ?? "unknown";
  return { startedAt: value.startedAt, finishedAt: value.finishedAt, error };
}

/** Anything that fits no state is `never`. */
export function parsePruneState(stored: unknown): PruneState {
  if (!isRecord(stored)) return { state: "never" };
  const lastSuccess = parseSuccess(stored.lastSuccess);
  if (stored.state === "ok" && lastSuccess !== null) return { state: "ok", lastSuccess };
  const lastFailure = stored.state === "failing" ? parseFailure(stored.lastFailure) : null;
  if (lastFailure === null) return { state: "never" };
  const { failures, failingSince } = stored;
  return {
    state: "failing",
    lastFailure,
    failures:
      typeof failures === "number" && Number.isInteger(failures) && failures >= 1 ? failures : 1,
    failingSince: isTime(failingSince) ? failingSince : lastFailure.startedAt,
    lastSuccess,
  };
}
