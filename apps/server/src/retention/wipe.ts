import { berlinDayStart } from "../crawl/berlin-time.js";
import type { CrawlEngine } from "../crawl/engine.js";
import { readJson, writeJson } from "../crawl/kv.js";
import { UNEXPECTED_PAGES_DIR } from "../crawl/raw-pages.js";
import type { SearchPolling } from "../crawl/search-polls.js";
import { OFFER_PAGES_DIR } from "../crawl/snapshots.js";
import type { Db } from "../db/index.js";
import { listFiles, removeFile } from "./data-folder.js";
import { compact } from "./prune.js";

const HOUR = 3_600_000;
const LAST_WIPE_KEY = "retention.lastWipe";

export type WipeResult = {
  offers: number;
  snapshots: number;
  unexpectedPages: number;
  requests: number;
};

/**
 * Written in the transaction that deletes the rows, so it exists exactly when that committed.
 * `filesRemoved` is false after a crash between the two: the next start removes them.
 */
export type WipeRecord = {
  /** Epoch milliseconds. */
  at: number;
  deleted: WipeResult;
  filesRemoved: boolean;
};

export function readWipeRecord(db: Db): WipeRecord | undefined {
  const stored = readJson(db, LAST_WIPE_KEY) as Partial<WipeRecord> | undefined;
  if (typeof stored?.at !== "number" || typeof stored.deleted !== "object") return undefined;
  return { at: stored.at, deleted: stored.deleted, filesRemoved: stored.filesRemoved === true };
}

function removeStoredPages(dataDir: string) {
  let snapshots = 0;
  for (const file of listFiles(dataDir, OFFER_PAGES_DIR)) {
    if (removeFile(dataDir, file.path)) snapshots++;
  }
  let unexpectedPages = 0;
  for (const file of listFiles(dataDir, UNEXPECTED_PAGES_DIR)) {
    if (removeFile(dataDir, file.path)) unexpectedPages++;
  }
  return { snapshots, unexpectedPages };
}

/**
 * Called at start: the `wiped` pause outlives the crash, so nothing has crawled since and every
 * stored page is still an orphan.
 */
export function finishInterruptedWipe(db: Db, dataDir: string, now: number): void {
  const record = readWipeRecord(db);
  if (record === undefined || record.filesRemoved) return;
  const removed = removeStoredPages(dataDir);
  const deleted = {
    ...record.deleted,
    snapshots: record.deleted.snapshots + removed.snapshots,
    unexpectedPages: record.deleted.unexpectedPages + removed.unexpectedPages,
  };
  writeJson(db, LAST_WIPE_KEY, { ...record, deleted, filesRemoved: true }, now);
}

/**
 * Profile, Filters, Searches, settings, secrets, token and spend ledger stay. Request-log rows the
 * hourly and daily caps still count stay too, so a wipe can't reset the caps.
 */
export async function wipeOfferData(deps: {
  db: Db;
  dataDir: string;
  /** Epoch milliseconds. */
  clock: () => number;
  crawl: Pick<CrawlEngine, "whileWiping">;
  polling: Pick<SearchPolling, "sync">;
  /** Runs inside the wipe's transaction, before anything is deleted. */
  onWipe?: () => void;
}): Promise<WipeResult> {
  const { db, dataDir, clock, crawl, polling, onWipe } = deps;
  const work = () => {
    const now = clock();
    const countedFrom = Math.min(berlinDayStart(now), now - HOUR);
    const client = db.$client;
    let offers = 0;
    let requests = 0;
    client.transaction(() => {
      onWipe?.();
      offers = (client.prepare("SELECT COUNT(*) AS n FROM offers").get() as { n: number }).n;
      // Offers cascade to their Ad IDs, prices and analysis items.
      for (const table of [
        "offer_links",
        "offer_pair_overrides",
        "offers",
        "seen_ads",
        "search_matches",
        "search_sweeps",
        "crawl_jobs",
      ]) {
        client.prepare(`DELETE FROM ${table}`).run();
      }
      requests = client.prepare("DELETE FROM crawl_requests WHERE at < ?").run(countedFrom).changes;
      const record: WipeRecord = {
        at: now,
        deleted: { offers, snapshots: 0, unexpectedPages: 0, requests },
        filesRemoved: false,
      };
      writeJson(db, LAST_WIPE_KEY, record, now);
    })();

    // The rows are gone and recorded; a failure from here on is healed at the next start.
    const { snapshots, unexpectedPages } = removeStoredPages(dataDir);
    const deleted = { offers, snapshots, unexpectedPages, requests };
    writeJson(db, LAST_WIPE_KEY, { at: now, deleted, filesRemoved: true }, clock());

    // Nothing is sent while crawling is paused.
    polling.sync();
    compact(db);
    return deleted;
  };
  return crawl.whileWiping(work, () => readWipeRecord(db)?.at);
}
