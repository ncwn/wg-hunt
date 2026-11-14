import type { Source } from "@wg-hunt/core";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db/index.js";
import {
  type OfferAdRow,
  type OfferPairOverrideRow,
  offerAds,
  offerFactOverrides,
  offerPairOverrides,
  offers,
} from "../db/schema.js";
import { isOfferStale } from "../offers/staleness.js";
import { trackedOfferIds } from "../offers/tracked.js";

/**
 * `stale` wins over `untracked`, which only means no enabled Search matches an Offer that is still
 * active.
 */
export type OfferState = "shown" | "stale" | "untracked";

/**
 * In this order in `keptBecause`. `pair-override`: a merge/split verdict on one of its Ad IDs given
 * after the last release.
 */
export const KEEP_REASONS = [
  "dismissed",
  "shortlisted",
  "contacted",
  "scam-mark",
  "fact-override",
  "pair-override",
] as const;
export type KeepReason = (typeof KEEP_REASONS)[number];

export type Clocks = { quietSince: Date | null; recordClockSince: Date | null };

export type ClassifiedOffer = Clocks & {
  id: number;
  state: OfferState;
  keptBecause: KeepReason[];
  kept: boolean;
  adIds: { source: Source; adId: string }[];
};

export function classifyOffers(db: Db, now: number, onlyOffer?: number): ClassifiedOffer[] {
  const rows = db
    .select()
    .from(offers)
    .where(onlyOffer === undefined ? undefined : eq(offers.id, onlyOffer))
    .all();
  if (rows.length === 0) return [];
  const adsByOffer = new Map<number, OfferAdRow[]>();
  const adRows = db
    .select()
    .from(offerAds)
    .where(onlyOffer === undefined ? undefined : eq(offerAds.offerId, onlyOffer))
    .all();
  for (const ad of adRows) {
    adsByOffer.set(ad.offerId, [...(adsByOffer.get(ad.offerId) ?? []), ad]);
  }
  const tracked = trackedOfferIds(db, onlyOffer);
  const factOverridden = new Set(
    db
      .select({ offerId: offerFactOverrides.offerId })
      .from(offerFactOverrides)
      .where(onlyOffer === undefined ? undefined : eq(offerFactOverrides.offerId, onlyOffer))
      .all()
      .map((row) => row.offerId),
  );
  const lastVerdict = lastVerdicts(
    onlyOffer === undefined
      ? db.select().from(offerPairOverrides).all()
      : pairOverridesOf(db, adRows),
  );
  return rows.map((row) => {
    const ads = adsByOffer.get(row.id) ?? [];
    const state: OfferState = isOfferStale(ads, now)
      ? "stale"
      : tracked.has(row.id)
        ? "shown"
        : "untracked";
    const pinned = pinnedBy(ads, lastVerdict, row.pairPinsReleasedAt);
    const holds: Record<KeepReason, boolean> = {
      dismissed: row.dismissed,
      shortlisted: row.shortlisted,
      contacted: row.contacted,
      "scam-mark": row.scamMark !== null,
      "fact-override": factOverridden.has(row.id),
      "pair-override": pinned,
    };
    const keptBecause = KEEP_REASONS.filter((reason) => holds[reason]);
    return {
      id: row.id,
      state,
      keptBecause,
      kept: keptBecause.length > 0,
      quietSince: row.quietSince,
      recordClockSince: row.recordClockSince,
      adIds: ads.map(({ source, adId }) => ({ source, adId })),
    };
  });
}

function lastVerdicts(pairs: OfferPairOverrideRow[]): Map<string, number> {
  const lastVerdict = new Map<string, number>();
  for (const pair of pairs) {
    for (const adId of [pair.adIdA, pair.adIdB]) {
      const key = `${pair.source}/${adId}`;
      lastVerdict.set(key, Math.max(lastVerdict.get(key) ?? 0, pair.createdAt.getTime()));
    }
  }
  return lastVerdict;
}

function pinnedBy(
  ads: Pick<OfferAdRow, "source" | "adId">[],
  lastVerdict: Map<string, number>,
  releasedAt: Date | null,
): boolean {
  const released = releasedAt?.getTime() ?? -Infinity;
  return ads.some((ad) => (lastVerdict.get(`${ad.source}/${ad.adId}`) ?? -Infinity) > released);
}

export function isPairPinned(db: Db, offerId: number): boolean {
  const row = db
    .select({ releasedAt: offers.pairPinsReleasedAt })
    .from(offers)
    .where(eq(offers.id, offerId))
    .get();
  if (row === undefined) return false;
  const ads = db.select().from(offerAds).where(eq(offerAds.offerId, offerId)).all();
  return pinnedBy(ads, lastVerdicts(pairOverridesOf(db, ads)), row.releasedAt);
}

function pairOverridesOf(db: Db, ads: OfferAdRow[]) {
  const adIds = ads.map((ad) => ad.adId);
  if (adIds.length === 0) return [];
  const sources = new Set(ads.map((ad) => `${ad.source}/${ad.adId}`));
  return [
    ...db.select().from(offerPairOverrides).where(inArray(offerPairOverrides.adIdA, adIds)).all(),
    ...db.select().from(offerPairOverrides).where(inArray(offerPairOverrides.adIdB, adIds)).all(),
  ].filter(
    (pair) =>
      sources.has(`${pair.source}/${pair.adIdA}`) || sources.has(`${pair.source}/${pair.adIdB}`),
  );
}

const later = (a: Date, b: Date) => (a.getTime() >= b.getTime() ? a : b);

export function nextClocks(offer: Clocks & { state: OfferState; kept: boolean }, at: Date): Clocks {
  if (offer.state === "shown") return { quietSince: null, recordClockSince: null };
  const quietSince = offer.quietSince ?? at;
  return {
    quietSince,
    recordClockSince: offer.kept ? null : later(offer.recordClockSince ?? at, quietSince),
  };
}

export function mergedClocks(survivor: Clocks, absorbed: Clocks): Clocks {
  const both = (a: Date | null, b: Date | null) => (a === null || b === null ? null : later(a, b));
  return {
    quietSince: both(survivor.quietSince, absorbed.quietSince),
    recordClockSince: both(survivor.recordClockSince, absorbed.recordClockSince),
  };
}

export type PinSide = { releasedAt: Date | null; pinned: boolean };

/**
 * A merge never frees a record either side still pinned. With neither pinned, the later release
 * covers every verdict of both.
 */
export function mergedPinRelease(survivor: PinSide, absorbed: PinSide): Date | null {
  const pinned = [survivor, absorbed].filter((side) => side.pinned);
  if (pinned.length > 0) {
    const releases = pinned.map((side) => side.releasedAt);
    if (releases.some((at) => at === null)) return null;
    return new Date(Math.min(...releases.map((at) => (at as Date).getTime())));
  }
  const { releasedAt: a } = survivor;
  const { releasedAt: b } = absorbed;
  if (a === null || b === null) return a ?? b;
  return later(a, b);
}

function writeClocks(db: Db, classified: ClassifiedOffer[], at: Date): void {
  for (const offer of classified) {
    const { quietSince, recordClockSince } = nextClocks(offer, at);
    if (
      quietSince?.getTime() === offer.quietSince?.getTime() &&
      recordClockSince?.getTime() === offer.recordClockSince?.getTime()
    ) {
      continue;
    }
    db.update(offers).set({ quietSince, recordClockSince }).where(eq(offers.id, offer.id)).run();
    offer.quietSince = quietSince;
    offer.recordClockSince = recordClockSince;
  }
}

export function refreshClocks(db: Db, now: number): ClassifiedOffer[] {
  const classified = classifyOffers(db, now);
  db.$client.transaction(() => writeClocks(db, classified, new Date(now)))();
  return classified;
}

export function refreshOfferClocks(db: Db, offerId: number, now: number): void {
  writeClocks(db, classifyOffers(db, now, offerId), new Date(now));
}
