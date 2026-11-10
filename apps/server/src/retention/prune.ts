import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { SETTLED_WITHOUT_PAGE } from "../crawl/detail-fetch.js";
import { UNEXPECTED_PAGES_DIR } from "../crawl/raw-pages.js";
import { OFFER_PAGES_DIR, snapshotPath } from "../crawl/snapshots.js";
import type { Db } from "../db/index.js";
import { crawlRequests, offerLinks, offers, searchMatches, seenAds } from "../db/schema.js";
import { type ClassifiedOffer, refreshClocks } from "./clocks.js";
import { RECORD_DAYS, REQUEST_LOG_DAYS, SNAPSHOT_DAYS, UNEXPECTED_PAGE_DAYS } from "./constants.js";
import { listFiles, removeFile } from "./data-folder.js";
import type { PruneDeleted } from "./prune-state.js";

const DAY = 24 * 60 * 60_000;

/** `offer-pages/<source>/<adId>.html.gz`, as `snapshotPath` writes it. */
const SNAPSHOT_FILE = /^offer-pages\/([a-z0-9-]{1,40})\/(\d{1,20})\.html\.gz$/;

/** Seen-ad rows and Search matches go too, so a returning Ad ID is a new Offer. */
function deleteOffers(db: Db, dataDir: string, doomed: readonly ClassifiedOffer[]): void {
  if (doomed.length === 0) return;
  db.$client.transaction(() => {
    for (const offer of doomed) {
      for (const { source, adId } of offer.adIds) {
        db.delete(offerLinks)
          .where(
            and(
              eq(offerLinks.source, source),
              or(eq(offerLinks.adId, adId), eq(offerLinks.otherAdId, adId)),
            ),
          )
          .run();
        db.delete(seenAds)
          .where(and(eq(seenAds.source, source), eq(seenAds.adId, adId)))
          .run();
        db.delete(searchMatches)
          .where(and(eq(searchMatches.source, source), eq(searchMatches.adId, adId)))
          .run();
      }
    }
    db.delete(offers)
      .where(
        inArray(
          offers.id,
          doomed.map((offer) => offer.id),
        ),
      )
      .run();
  })();
  for (const offer of doomed) {
    for (const { source, adId } of offer.adIds) {
      try {
        removeFile(dataDir, snapshotPath(source, adId));
      } catch {
        // Not a plain Source and Ad ID: nothing of ours to delete.
      }
    }
  }
}

/**
 * Pages stored but not through the Offers step yet. Kept whatever their age, since the prune can
 * run at boot before the adoption has reached them.
 */
function unadoptedPages(db: Db): Set<string> {
  return new Set(
    db
      .select({ source: seenAds.source, adId: seenAds.adId })
      .from(seenAds)
      .where(and(eq(seenAds.detailState, "fetched"), isNull(seenAds.ingestedAt)))
      .all()
      .map(({ source, adId }) => `${source}/${adId}`),
  );
}

function pruneSnapshots(
  db: Db,
  dataDir: string,
  offersNow: readonly ClassifiedOffer[],
  now: number,
): number {
  const cutoff = now - SNAPSHOT_DAYS * DAY;
  const quietSince = new Map<string, number | null>();
  for (const offer of offersNow) {
    for (const { source, adId } of offer.adIds) {
      quietSince.set(`${source}/${adId}`, offer.quietSince?.getTime() ?? null);
    }
  }
  const unadopted = unadoptedPages(db);
  let removed = 0;
  for (const file of listFiles(dataDir, OFFER_PAGES_DIR)) {
    const match = SNAPSHOT_FILE.exec(file.path);
    const key = match === null ? undefined : `${match[1]}/${match[2]}`;
    if (key !== undefined && unadopted.has(key)) continue;
    // An Ad ID of an Offer ages with the Offer; any other file (an Ad ID no Offer owns, a left
    // over temporary file) by its own age.
    const owned = key !== undefined && quietSince.has(key);
    const since = owned ? quietSince.get(key as string) : file.mtimeMs;
    if (since === null || since === undefined || since > cutoff) continue;
    if (!removeFile(dataDir, file.path)) continue;
    removed++;
  }
  return removed;
}

function pruneUnexpectedPages(dataDir: string, now: number): number {
  const cutoff = now - UNEXPECTED_PAGE_DAYS * DAY;
  let removed = 0;
  for (const file of listFiles(dataDir, UNEXPECTED_PAGES_DIR)) {
    if (file.mtimeMs <= cutoff && removeFile(dataDir, file.path)) removed++;
  }
  return removed;
}

/**
 * Without this they would pile up for ever: a daily Sweep asks only after Ad IDs that have an
 * Offer, so it never drops the match of one that has none.
 */
function pruneOrphanSeenAds(db: Db, now: number): void {
  const settled = SETTLED_WITHOUT_PAGE.map(() => "?").join(", ");
  db.$client.transaction(() => {
    db.$client
      .prepare(
        `DELETE FROM seen_ads
         WHERE lastSeenAt < ?
           AND (ingestedAt IS NOT NULL OR detailState IN (${settled}))
           AND NOT EXISTS (
             SELECT 1 FROM offer_ads a WHERE a.source = seen_ads.source AND a.adId = seen_ads.adId
           )`,
      )
      .run(now - RECORD_DAYS * DAY, ...SETTLED_WITHOUT_PAGE);
    // A card writes its seen-ad row and its matches together, so a match without one is what the
    // delete above left behind.
    db.$client
      .prepare(
        `DELETE FROM search_matches
         WHERE NOT EXISTS (
             SELECT 1 FROM seen_ads s
             WHERE s.source = search_matches.source AND s.adId = search_matches.adId
           )
           AND NOT EXISTS (
             SELECT 1 FROM offer_ads a
             WHERE a.source = search_matches.source AND a.adId = search_matches.adId
           )`,
      )
      .run();
  })();
}

/** An older database file was made without incremental auto-vacuum. */
export function compact(db: Db): void {
  const client = db.$client;
  if (client.pragma("auto_vacuum", { simple: true }) !== 2) {
    client.pragma("auto_vacuum = INCREMENTAL");
    client.exec("VACUUM");
  }
  client.pragma("incremental_vacuum");
  client.pragma("wal_checkpoint(TRUNCATE)");
}

/** Marked Offers keep their records; their snapshots still age. */
export function prune(db: Db, dataDir: string, now: number): PruneDeleted {
  const classified = refreshClocks(db, now);
  const recordCutoff = now - RECORD_DAYS * DAY;
  const doomed = classified.filter(
    (offer) =>
      !offer.kept &&
      offer.recordClockSince !== null &&
      offer.recordClockSince.getTime() <= recordCutoff,
  );
  deleteOffers(db, dataDir, doomed);
  const gone = new Set(doomed.map((offer) => offer.id));
  const snapshots = pruneSnapshots(
    db,
    dataDir,
    classified.filter((offer) => !gone.has(offer.id)),
    now,
  );
  const unexpectedPages = pruneUnexpectedPages(dataDir, now);
  const requests = db
    .delete(crawlRequests)
    .where(lt(crawlRequests.at, new Date(now - REQUEST_LOG_DAYS * DAY)))
    .run().changes;
  pruneOrphanSeenAds(db, now);
  compact(db);
  return { offers: doomed.length, snapshots, unexpectedPages, requests };
}
