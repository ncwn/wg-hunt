import type { RunProgress } from "./analysis.js";

export type EndedRun = RunProgress & { status: Exclude<RunProgress["status"], "running"> };

export type RunState =
  | { status: "none" }
  | { status: "following"; runId: number; progress?: RunProgress; problem?: string }
  | { status: "ended"; outcome: EndedRun };

export const NO_RUN: RunState = { status: "none" };

export function seen(progress: RunProgress): RunState {
  return progress.status === "running"
    ? { status: "following", runId: progress.runId, progress }
    : { status: "ended", outcome: { ...progress, status: progress.status } };
}

export function unread(run: RunState, runId: number, problem: string): RunState {
  const progress = run.status === "following" && run.runId === runId ? run.progress : undefined;
  return { status: "following", runId, progress, problem };
}

export type Lookup = { found: RunProgress } | { problem: string };

export function looked(
  run: RunState,
  runId: number,
  activeRunId: number | null,
  lookup: Lookup,
): RunState {
  // An ended run never runs again, so a record saying it does is older than its end.
  if (run.status === "ended" && run.outcome.runId === runId) return run;
  if ("found" in lookup) return seen(lookup.found);
  // Nothing is going, so there is no progress to retry for; how the run ended is lost.
  if (activeRunId === null) return NO_RUN;
  return unread(run, runId, lookup.problem);
}

/**
 * `activeRunId` comes from a status read, which says nothing of a run's progress. An ended run with
 * the same id stays ended, since its own record is newer than the read.
 */
export function shown(run: RunState, activeRunId: number | null): RunState {
  if (activeRunId === null) return run;
  if (run.status === "following" && run.runId === activeRunId) return run;
  if (run.status === "ended" && run.outcome.runId === activeRunId) return run;
  return { status: "following", runId: activeRunId };
}
