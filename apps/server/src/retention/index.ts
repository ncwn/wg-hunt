import type { CrawlEngine } from "../crawl/engine.js";
import { readJson, writeJson } from "../crawl/kv.js";
import type { SearchPolling } from "../crawl/search-polls.js";
import type { Db } from "../db/index.js";
import type { StorageCatchUp } from "../offers/catch-up.js";
import { prune } from "./prune.js";
import {
  afterAttempt,
  nextAttemptAt,
  type PruneDeleted,
  type PruneErrorKind,
  type PruneState,
  parsePruneState,
  pruneErrorKind,
} from "./prune-state.js";
import { pruneReadout, readStorage } from "./storage.js";
import { finishInterruptedWipe, readWipeRecord, type WipeResult, wipeOfferData } from "./wipe.js";

export type Retention = ReturnType<typeof createRetention>;

const LAST_PRUNE_KEY = "retention.lastPrune";
const CHECK_EVERY_MS = 60_000;

export function createRetention(deps: {
  db: Db;
  dataDir: string;
  /** Epoch milliseconds. */
  clock: () => number;
  crawl: Pick<CrawlEngine, "whileWiping" | "settleWipePause">;
  polling: Pick<SearchPolling, "sync">;
  freeBytes: () => number | null;
  onWipe?: () => void;
  catchUp: () => StorageCatchUp;
}) {
  const { db, dataDir, clock, crawl, polling, freeBytes, onWipe, catchUp } = deps;
  let timer: NodeJS.Timeout | undefined;
  let wiping: { since: number; done: Promise<WipeResult> } | undefined;

  finishInterruptedWipe(db, dataDir, clock());
  crawl.settleWipePause(readWipeRecord(db)?.at);

  /**
   * Where the prune stands when the database would not take it (a full disk fails that write
   * too). It stands in for the stored value until a write gets through, so the backoff holds.
   */
  let unsaved: PruneState | undefined;

  const pruneState = (): PruneState => unsaved ?? parsePruneState(readJson(db, LAST_PRUNE_KEY));

  function savePruneState(next: PruneState, now: number): void {
    try {
      writeJson(db, LAST_PRUNE_KEY, next, now);
      unsaved = undefined;
    } catch (err) {
      unsaved = next;
      const name = err instanceof Error ? err.name : "error";
      console.error(`Could not store how the nightly prune went, so it is kept in memory: ${name}`);
    }
  }

  function retryNote(): string {
    try {
      const retryAt = nextAttemptAt(pruneState());
      return retryAt === undefined ? "" : `; next attempt ${new Date(retryAt).toISOString()}`;
    } catch {
      return "";
    }
  }

  function pruneNow(): PruneDeleted {
    const before = pruneState();
    const startedAt = clock();
    const record = (outcome: { deleted: PruneDeleted } | { error: PruneErrorKind }) => {
      const finishedAt = clock();
      savePruneState(afterAttempt(before, { startedAt, finishedAt, ...outcome }), finishedAt);
    };
    let deleted: PruneDeleted;
    try {
      deleted = prune(db, dataDir, startedAt);
    } catch (err) {
      record({ error: pruneErrorKind(err) });
      throw err;
    }
    record({ deleted });
    return deleted;
  }

  return {
    prune: pruneNow,

    tick(): PruneDeleted | undefined {
      const dueAt = nextAttemptAt(pruneState());
      if (dueAt !== undefined && clock() < dueAt) return undefined;
      return pruneNow();
    },

    start(): void {
      if (timer !== undefined) return;
      const run = () => {
        try {
          this.tick();
        } catch (err) {
          const name = err instanceof Error ? err.name : "error";
          console.error(`Nightly prune failed: ${name}${retryNote()}`);
        }
      };
      timer = setInterval(run, CHECK_EVERY_MS);
      timer.unref();
      run();
    },

    stop(): void {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },

    storage() {
      const lastWipe = readWipeRecord(db);
      return readStorage({
        db,
        dataDir,
        now: clock(),
        freeBytes: freeBytes(),
        prune: pruneReadout(pruneState()),
        wipe: {
          running: wiping === undefined ? null : { since: new Date(wiping.since).toISOString() },
          last:
            lastWipe === undefined
              ? null
              : {
                  at: new Date(lastWipe.at).toISOString(),
                  deleted: lastWipe.deleted,
                  filesRemoved: lastWipe.filesRemoved,
                },
        },
        catchUp: catchUp(),
      });
    },

    wipe(): Promise<WipeResult> {
      if (wiping !== undefined) return wiping.done;
      const done = wipeOfferData({
        db,
        dataDir,
        clock,
        crawl,
        polling,
        ...(onWipe && { onWipe }),
      }).finally(() => {
        wiping = undefined;
      });
      wiping = { since: clock(), done };
      return done;
    },
  };
}
