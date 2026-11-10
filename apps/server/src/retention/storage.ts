import { statSync } from "node:fs";
import { join } from "node:path";
import { count } from "drizzle-orm";
import { DATABASE_FILE } from "../config.js";
import { UNEXPECTED_PAGES_DIR } from "../crawl/raw-pages.js";
import { OFFER_PAGES_DIR } from "../crawl/snapshots.js";
import type { Db } from "../db/index.js";
import { crawlRequests } from "../db/schema.js";
import type { StorageCatchUp } from "../offers/catch-up.js";
import { classifyOffers } from "./clocks.js";
import { RETENTION_CONSTANTS } from "./constants.js";
import { listFiles, sumBytes } from "./data-folder.js";
import {
  nextAttemptAt,
  type PruneDeleted,
  type PruneErrorKind,
  type PruneFailure,
  type PruneState,
  type PruneSuccess,
} from "./prune-state.js";

function databaseBytes(dataDir: string): number {
  let bytes = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      bytes += statSync(join(dataDir, `${DATABASE_FILE}${suffix}`)).size;
    } catch {
      // WAL and shared-memory files exist only while the database is open.
    }
  }
  return bytes;
}

export type StorageWipe = {
  /** ISO 8601. */
  running: { since: string } | null;
  last: {
    /** ISO 8601. */
    at: string;
    deleted: { offers: number; snapshots: number; unexpectedPages: number; requests: number };
    filesRemoved: boolean;
  } | null;
};

/** Times are ISO 8601. */
type StoragePruneAttempt = {
  startedAt: string;
  finishedAt: string;
  /** Null when it failed, and for a prune of a version that kept only when it ran. */
  deleted: PruneDeleted | null;
  /** Null when it finished. */
  error: PruneErrorKind | null;
};

export type StoragePrune = {
  state: PruneState["state"];
  lastAttempt: StoragePruneAttempt | null;
  lastSuccess: StoragePruneAttempt | null;
  /** ISO 8601; null unless `failing`. */
  failingSince: string | null;
  /** 0 unless `failing`. */
  failures: number;
  /** ISO 8601; null when it never ran, which the next check makes up for. */
  nextAttemptAt: string | null;
};

const iso = (ms: number) => new Date(ms).toISOString();

const attemptReadout = (attempt: PruneSuccess | PruneFailure): StoragePruneAttempt => ({
  startedAt: iso(attempt.startedAt),
  finishedAt: iso(attempt.finishedAt),
  deleted: "error" in attempt ? null : attempt.deleted,
  error: "error" in attempt ? attempt.error : null,
});

export function pruneReadout(state: PruneState): StoragePrune {
  const next = nextAttemptAt(state);
  const lastSuccess =
    state.state === "never" || state.lastSuccess === null
      ? null
      : attemptReadout(state.lastSuccess);
  return {
    state: state.state,
    lastAttempt: state.state === "failing" ? attemptReadout(state.lastFailure) : lastSuccess,
    lastSuccess,
    failingSince: state.state === "failing" ? iso(state.failingSince) : null,
    failures: state.state === "failing" ? state.failures : 0,
    nextAttemptAt: next === undefined ? null : iso(next),
  };
}

export function readStorage(input: {
  db: Db;
  dataDir: string;
  now: number;
  freeBytes: number | null;
  prune: StoragePrune;
  wipe: StorageWipe;
  catchUp: StorageCatchUp;
}) {
  const { db, dataDir, now } = input;
  const snapshots = listFiles(dataDir, OFFER_PAGES_DIR);
  const unexpected = listFiles(dataDir, UNEXPECTED_PAGES_DIR);
  const offers = classifyOffers(db, now);
  const quiet = offers.filter((offer) => offer.state !== "shown");
  return {
    database: { bytes: databaseBytes(dataDir) },
    snapshots: { files: snapshots.length, bytes: sumBytes(snapshots) },
    unexpectedPages: { files: unexpected.length, bytes: sumBytes(unexpected) },
    freeBytes: input.freeBytes,
    offers: {
      total: offers.length,
      shown: offers.length - quiet.length,
      stale: offers.filter((offer) => offer.state === "stale").length,
      untracked: offers.filter((offer) => offer.state === "untracked").length,
      keptForMarks: quiet.filter((offer) => offer.kept).length,
    },
    requestLog: { rows: db.select({ n: count() }).from(crawlRequests).get()?.n ?? 0 },
    retention: RETENTION_CONSTANTS,
    lastPrune: input.prune.lastSuccess?.startedAt ?? null,
    prune: input.prune,
    wipe: input.wipe,
    catchUp: input.catchUp,
  };
}
