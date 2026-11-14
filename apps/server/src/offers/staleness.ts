import type { PageStatus } from "@wg-hunt/core";

export const STALE_AFTER_DAYS = 7;
const DAY = 24 * 60 * 60_000;

export type AdStaleness = {
  pageStatus: PageStatus;
  lastBumpAt: Date | null;
  firstSeenAt: Date;
};

/**
 * An Ad ID whose cards never showed an age counts from its first sighting, so it cannot stay in
 * view for ever.
 */
export function isAdStale(ad: AdStaleness, now: number): boolean {
  if (ad.pageStatus !== "active") return true;
  return agedOutAt(ad) < now;
}

export function agedOutAt(ad: Pick<AdStaleness, "lastBumpAt" | "firstSeenAt">): number {
  return (ad.lastBumpAt ?? ad.firstSeenAt).getTime() + STALE_AFTER_DAYS * DAY;
}

export function isOfferStale(ads: readonly AdStaleness[], now: number): boolean {
  return ads.every((ad) => isAdStale(ad, now));
}
