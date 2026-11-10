import type { ProviderErrorKind } from "./provider.js";

/** Trying again fails the same way until that page reads; a Recheck stores one. */
export const PAGE_FAILURE_KINDS = ["no_stored_page", "unreadable_page"] as const;
export type PageFailureKind = (typeof PAGE_FAILURE_KINDS)[number];

export function isPageFailure(kind: string): kind is PageFailureKind {
  return (PAGE_FAILURE_KINDS as readonly string[]).includes(kind);
}

export type AnalysisErrorKind = ProviderErrorKind | PageFailureKind;

export type ErrorKindPolicy = {
  /**
   * `yes`: the model answered, so its usage comes with the error. `no`: an HTTP answer says nothing
   * was done, or nothing was sent. `unknown`: the request may have reached the server and been
   * billed with no usage to read, so the reservation counts as spent.
   */
  billed: "yes" | "no" | "unknown";
  retryInCall: boolean;
  /**
   * When a `failed` Offer may be sent again.
   * - `free`: at once. It cost nothing and may clear by itself (a new key, a page stored again).
   * - `needs-click`: only once the words change or the seeker clicks Re-analyse, because the same
   *   call would fail the same way and every try is billed.
   * - `not-a-failure`: the Offer is not failed at all. It waits as it was until there is room.
   */
  perOffer: "free" | "backoff" | "needs-click" | "not-a-failure";
  countsAsAttempt: boolean;
  mayHaveCreatedBatch: boolean;
  stopsQueue: boolean;
  batchGone: boolean;
};

const transient: ErrorKindPolicy = {
  billed: "no",
  retryInCall: true,
  perOffer: "backoff",
  countsAsAttempt: true,
  mayHaveCreatedBatch: false,
  stopsQueue: false,
  batchGone: false,
};

const answeredBadly: ErrorKindPolicy = {
  ...transient,
  billed: "yes",
  retryInCall: false,
  perOffer: "needs-click",
};

const notSent: ErrorKindPolicy = {
  ...transient,
  retryInCall: false,
  perOffer: "free",
  countsAsAttempt: false,
};

const capped: ErrorKindPolicy = {
  ...notSent,
  perOffer: "not-a-failure",
};

/** Nothing else may treat error kinds differently. */
export const ERROR_KINDS: Record<AnalysisErrorKind, ErrorKindPolicy> = {
  rate_limited: transient,
  overloaded: transient,
  // A 5xx to a batch send can come after the batch was made.
  server_error: { ...transient, mayHaveCreatedBatch: true },
  network: { ...transient, billed: "unknown", mayHaveCreatedBatch: true },
  timeout: { ...transient, billed: "unknown", mayHaveCreatedBatch: true },
  // An answer that doesn't parse was billed like any other, so it isn't tried again at once (that
  // would bill each try within seconds). Another read later may parse, so the Offer backs off.
  invalid_response: { ...transient, billed: "yes", retryInCall: false },
  refused: answeredBadly,
  truncated: answeredBadly,
  unauthorized: { ...notSent, stopsQueue: true },
  // The API turned the request down (4xx); a look at a batch it answers this way no longer finds it.
  rejected: { ...transient, retryInCall: false, batchGone: true },
  // Fixed by a newer price table or another model, so it never counts as an attempt.
  unpriced: notSent,
  expired: { ...transient, retryInCall: false },
  // The only canceller is the cap being lowered under what a batch reserved.
  canceled: capped,
  spend_cap_reached: { ...capped, stopsQueue: true },
  no_stored_page: notSent,
  unreadable_page: notSent,
};

/** A string no longer in the table (an older row) backs off. */
export function policyOf(kind: string): ErrorKindPolicy {
  return Object.hasOwn(ERROR_KINDS, kind) ? ERROR_KINDS[kind as AnalysisErrorKind] : transient;
}
