import { policyOf } from "@wg-hunt/core";
import type { AnalysisJob } from "../offers/offers.js";

const MINUTE = 60_000;
const RETRY_BASE_MS = 10 * MINUTE;
const RETRY_CAP_MS = 6 * 60 * MINUTE;
export const MAX_ATTEMPTS = 5;

/** Epoch ms, possibly past; `"never"` until new words or a click. */
export function retryAt(job: Pick<AnalysisJob, "failure" | "contentHash">): number | "never" {
  const failure = job.failure;
  if (failure === null) return 0;
  const policy = policyOf(failure.kind);
  if (policy.perOffer === "free" || policy.perOffer === "not-a-failure") return 0;
  // The words changed since it failed: this is a different Offer to the model.
  if (
    failure.contentHash !== null &&
    job.contentHash !== null &&
    failure.contentHash !== job.contentHash
  ) {
    return 0;
  }
  if (policy.perOffer === "needs-click" || failure.attempts >= MAX_ATTEMPTS) return "never";
  return failure.at + Math.min(RETRY_BASE_MS * 2 ** (failure.attempts - 1), RETRY_CAP_MS);
}

export function mayRetry(job: Pick<AnalysisJob, "failure" | "contentHash">, now: number): boolean {
  const at = retryAt(job);
  return at !== "never" && now >= at;
}

/**
 * On top of the Offer's own backoff: a resend that fails before sending (unpriced model, page gone)
 * or is capped leaves no attempt on the Offer, and would otherwise be queued every cycle.
 */
export function mayResendEscalation(
  job: Pick<AnalysisJob, "failure" | "contentHash" | "escalation">,
  now: number,
): boolean {
  const owed = job.escalation;
  if (owed === null) return false;
  const resends = owed.resends ?? 0;
  if (resends >= MAX_ATTEMPTS) return false;
  if (resends > 0) {
    const wait = Math.min(RETRY_BASE_MS * 2 ** (resends - 1), RETRY_CAP_MS);
    if (now < (owed.resentAt ?? 0) + wait) return false;
  }
  return mayRetry(job, now);
}
