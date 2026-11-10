import type { Source } from "@wg-hunt/core";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { offerAds, searches, searchMatches } from "../db/schema.js";

export const adKey = (source: Source, adId: string) => `${source}:${adId}`;

export function trackedAds(db: Db, onlyOffer?: number): { offers: Set<number>; ads: Set<string> } {
  const rows = db
    .selectDistinct({ offerId: offerAds.offerId, source: offerAds.source, adId: offerAds.adId })
    .from(offerAds)
    .innerJoin(
      searchMatches,
      and(eq(searchMatches.source, offerAds.source), eq(searchMatches.adId, offerAds.adId)),
    )
    .innerJoin(searches, and(eq(searches.id, searchMatches.searchId), eq(searches.enabled, true)))
    .where(onlyOffer === undefined ? undefined : eq(offerAds.offerId, onlyOffer))
    .all();
  return {
    offers: new Set(rows.map((r) => r.offerId)),
    ads: new Set(rows.map((r) => adKey(r.source, r.adId))),
  };
}

export function trackedOfferIds(db: Db, onlyOffer?: number): Set<number> {
  return trackedAds(db, onlyOffer).offers;
}

export function isAdTracked(db: Db, source: Source, adId: string): boolean {
  return (
    db
      .select({ id: searchMatches.searchId })
      .from(searchMatches)
      .innerJoin(searches, and(eq(searches.id, searchMatches.searchId), eq(searches.enabled, true)))
      .where(and(eq(searchMatches.source, source), eq(searchMatches.adId, adId)))
      .limit(1)
      .get() !== undefined
  );
}
