import type { Source } from "@wg-hunt/core";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { seenAds } from "../db/schema.js";
import { errorKind } from "../error-kind.js";
import type { SnapshotStore } from "./snapshots.js";

/**
 * - `skipped`: the card was already older than 7 days.
 * - `priced-out`: the card's monthly price was above the ceiling of the Search that saw it.
 *
 * `fetched` stays: a Recheck rereads the page without leaving it.
 */
export const DETAIL_STATES = ["pending", "fetched", "failed", "skipped", "priced-out"] as const;
export type DetailState = (typeof DETAIL_STATES)[number];

/** No Offer is made of them. */
export const SETTLED_WITHOUT_PAGE = [
  "skipped",
  "failed",
  "priced-out",
] as const satisfies readonly DetailState[];

export const MAX_DETAIL_ATTEMPTS = 3;

export function firstDetailState(card: { tooOld: boolean; pricedOut: boolean }): DetailState {
  if (card.tooOld) return "skipped";
  if (card.pricedOut) return "priced-out";
  return "pending";
}

export function wantsRefetch(
  state: DetailState,
  card: { bumped: boolean; fresh: boolean; pricedOut: boolean },
): boolean {
  if (!card.fresh) return false;
  if (state === "skipped" || state === "failed") return card.bumped;
  if (state === "priced-out") return !card.pricedOut;
  return false;
}

export const requeued = { detailState: "pending", detailAttempts: 0 } as const satisfies {
  detailState: DetailState;
  detailAttempts: number;
};

export function afterFailedFetch(attempts: number): {
  detailState: Extract<DetailState, "pending" | "failed">;
  detailAttempts: number;
} {
  const detailAttempts = attempts + 1;
  return {
    detailState: detailAttempts >= MAX_DETAIL_ATTEMPTS ? "failed" : "pending",
    detailAttempts,
  };
}

/**
 * The one writer for a fetched detail page, whichever crawl fetched it. A new page that only says
 * "deleted" keeps the stored one: it has nothing the stored one lacks.
 */
export function storeFetchedPage(
  deps: {
    db: Db;
    snapshots: SnapshotStore;
    beforeReplace: (ad: { source: Source; adId: string }) => void;
  },
  page: {
    source: Source;
    adId: string;
    html: string;
    deleted: boolean;
    fetchedAt: number;
  },
): void {
  const { db, snapshots, beforeReplace } = deps;
  if (!page.deleted) {
    try {
      beforeReplace({ source: page.source, adId: page.adId });
    } catch (err) {
      // What could still be read from the old page is worth less than the page just fetched.
      console.error(`Reading the stored page before replacing it failed: ${errorKind(err)}`);
    }
  }
  const kept = page.deleted && snapshots.has(page.source, page.adId);
  if (!kept) snapshots.write(page.source, page.adId, page.html);
  db.update(seenAds)
    .set({
      detailState: "fetched",
      detailFetchedAt: new Date(page.fetchedAt),
      // A new page is not through the Offers step yet, so the next boot adopts it if that fails. A
      // kept old page is no answer to adopt: should the Offers step fail on the deletion, the Ad ID
      // is read again later (a Recheck, a Sweep or a returning card).
      ...(!kept && { ingestedAt: null }),
    })
    .where(and(eq(seenAds.source, page.source), eq(seenAds.adId, page.adId)))
    .run();
}
