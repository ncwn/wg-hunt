export const RUN_STATUSES = ["running", "succeeded", "partial", "failed", "stopped"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_STOP_REASONS = ["spend-cap-reached", "interrupted"] as const;
export type RunStopReason = (typeof RUN_STOP_REASONS)[number];

export type RunTally = { applied: number; failed: number; capped: number; dropped: number };

/** `interrupted`: "Delete all Offer data" removed the Offers it was still reading. */
export function settledOutcome(
  tally: RunTally,
  interrupted = false,
): { status: Exclude<RunStatus, "running">; stopReason: RunStopReason | null } {
  if (interrupted) return { status: "stopped", stopReason: "interrupted" };
  if (tally.capped > 0) return { status: "stopped", stopReason: "spend-cap-reached" };
  if (tally.failed > 0)
    return { status: tally.applied > 0 ? "partial" : "failed", stopReason: null };
  return { status: "succeeded", stopReason: null };
}
