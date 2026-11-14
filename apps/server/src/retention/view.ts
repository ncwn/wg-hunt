import type { Db } from "../db/index.js";
import { type ClassifiedOffer, classifyOffers, type KeepReason, nextClocks } from "./clocks.js";
import { RECORD_DAYS, SNAPSHOT_DAYS } from "./constants.js";
import { nextScheduledPrune } from "./schedule.js";

const DAY = 24 * 60 * 60_000;

type RetentionState = "not-quiet" | "expiring" | "kept";

export type OfferRetention = {
  state: RetentionState;
  keptBecause: KeepReason[];
  /** The nightly prune after that deletes it; null while no record clock runs. */
  recordExpiresAt: string | null;
  /** Marks or not; null while the Offer is not quiet. */
  snapshotExpiresAt: string | null;
};

const plus = (since: Date | null, days: number) =>
  since === null ? null : new Date(since.getTime() + days * DAY).toISOString();

/**
 * A clock no sample has started yet is read as the next nightly prune will start it, which is the
 * latest it starts.
 */
function retentionOf(offer: ClassifiedOffer, now: number): OfferRetention {
  const clocks = nextClocks(offer, new Date(nextScheduledPrune(now)));
  return {
    state: offer.state === "shown" ? "not-quiet" : offer.kept ? "kept" : "expiring",
    keptBecause: offer.keptBecause,
    recordExpiresAt: plus(clocks.recordClockSince, RECORD_DAYS),
    snapshotExpiresAt: plus(clocks.quietSince, SNAPSHOT_DAYS),
  };
}

export function offerRetention(db: Db, offerId: number, now: number): OfferRetention | undefined {
  const [offer] = classifyOffers(db, now, offerId);
  return offer && retentionOf(offer, now);
}
