import { createRoute, z } from "@hono/zod-openapi";
import { ADOPT_RETRY_DAYS, CATCH_UP_PHASE_STATES, CATCH_UP_STATES } from "../offers/catch-up.js";
import { WIPE_CONFIRMATION } from "../retention/constants.js";
import { PRUNE_ERROR_KINDS } from "../retention/prune-state.js";
import type { ApiModule } from "./context.js";
import { problemResponses } from "./problem.js";

const files = z.object({ files: z.number().int(), bytes: z.number().int() });

const deletedCounts = {
  offers: z.number().int(),
  snapshots: z.number().int(),
  unexpectedPages: z.number().int(),
  requests: z.number().int(),
};

const wipeDeleted = z.object(deletedCounts).openapi("WipeDeleted");

const pruneDeleted = z.object(deletedCounts).openapi("PruneDeleted");

// A description on a nullable use of a named schema would land on the schema itself, so what null
// means is said on the schema or on the member's parent.
const pruneAttempt = z
  .object({
    startedAt: z.string().openapi({ description: "ISO 8601" }),
    finishedAt: z.string().openapi({ description: "ISO 8601 time it finished or failed" }),
    deleted: pruneDeleted.nullable(),
    error: z.enum(PRUNE_ERROR_KINDS).nullable().openapi({
      description:
        "The kind of error that stopped it; null when it finished. `disk-full`: the disk or the database had no room left. `database-busy`: something else held the database. `database-error`: another error from the database. `unknown`: anything else.",
    }),
  })
  .openapi("PruneAttempt", {
    description:
      "One attempt of the nightly prune. `deleted` is what it deleted: null when it failed.",
  });

const storagePrune = z
  .object({
    state: z.enum(["never", "ok", "failing"]).openapi({
      description:
        "`never`: no attempt has ended yet; the next check, within a minute of the server starting, prunes. `ok`: the last attempt finished. `failing`: the last attempt failed, and so did every one since `failingSince`.",
    }),
    lastAttempt: pruneAttempt.nullable(),
    lastSuccess: pruneAttempt.nullable(),
    failingSince: z.string().nullable().openapi({
      description:
        "ISO 8601 start of the first of the failed attempts in a row; null unless `failing`",
    }),
    failures: z
      .number()
      .int()
      .openapi({ description: "Failed attempts in a row; 0 unless `failing`" }),
    nextAttemptAt: z.string().nullable().openapi({
      description:
        "ISO 8601. The first check at or after this starts the next attempt; checks run every minute, so a time already past means within a minute. After a success it is the next 03:00 Berlin. After a failure it is 15 minutes after that attempt ended, twice as long after each further failure in a row, up to a day. Null when `never`.",
    }),
  })
  .openapi("StoragePrune", {
    description:
      "The nightly prune: how its last attempt went and when the next one starts. `lastAttempt` is null when `never`; `lastSuccess` is the last attempt that finished, null if none ever did. A prune that fails is tried again after a backoff, not every minute; what it deleted before it failed is not counted.",
  });

const catchUpPhase = z
  .object({
    state: z.enum(CATCH_UP_PHASE_STATES).openapi({
      description:
        "`pending`: not reached, and never will be once the catch-up has ended. `finished`: every item was looked at, and the counts say how each went. `stopped`: a shutdown cut it short. `failed`: it broke off, on an error outside any one item or on one that is the whole database's (locked, full, read-only, unreadable); its counts stop there.",
    }),
    startedAt: z.string().nullable().openapi({ description: "ISO 8601; null while `pending`" }),
    finishedAt: z.string().nullable().openapi({
      description: "ISO 8601 time it ended, however it ended; null until then",
    }),
    done: z.number().int().openapi({ description: "Items brought up to date" }),
    skipped: z.number().int().openapi({
      description:
        "Items left as they are because it can't be done: their page is deleted, gone from the data folder or unreadable",
    }),
    failed: z.number().int().openapi({
      description:
        "Items that threw for a reason of their own. Each is left as it is and tried again at the next start, and the phase went on with the next item.",
    }),
  })
  .openapi("CatchUpPhase", {
    description:
      "One phase of the catch-up after a start. An item with nothing to catch up on is in none of the counts.",
  });

const storageCatchUp = z
  .object({
    state: z.enum(CATCH_UP_STATES).openapi({
      description:
        "`running`: under way in the background. `finished`: every phase ran to its end; items may still have been skipped or have failed. `stopped`: a shutdown came first; the next start begins again. `failed`: at least one phase broke off; the others still ran.",
    }),
    startedAt: z.string().openapi({ description: "ISO 8601" }),
    finishedAt: z.string().nullable().openapi({
      description: "ISO 8601 time it ended, however it ended; null while `running`",
    }),
    phases: z
      .object({
        adoptPages: catchUpPhase,
        backfillProfiles: catchUpPhase,
        followCurrent: catchUpPhase,
        reparse: catchUpPhase,
      })
      .openapi({
        description: `In the order they run; each runs whatever became of the one before. \`adoptPages\`: stored pages whose Offers step never finished become Offers. One that is gone or unreadable is settled, counted as skipped and not looked at again. One whose Offers step threw is counted as failed and tried again at each start, for ${ADOPT_RETRY_DAYS} days from the first start that failed on it; a later start that still throws settles it too, as skipped. \`backfillProfiles\`: Ad IDs with a missing or outdated dedupe profile get one from their stored page; a skipped one keeps the profile it has. \`followCurrent\`: an Offer whose card names another Ad ID than its current one takes the current one's page; a skipped one stays on the older page. \`reparse\`: Offers whose facts an older rules version read are read again from their stored pages; a skipped one keeps the facts the older rules read. What these three skip is counted again at each start.`,
      }),
  })
  .openapi("StorageCatchUp", {
    description:
      "The catch-up this start ran on the Offers already stored: what an earlier start or an older rules version left behind. It runs once per start, in the background, and is always this start's, also when the database would not store it.",
  });

const storageSchema = z
  .object({
    database: z.object({
      bytes: z.number().int().openapi({
        description:
          "The database file with its write-ahead log and shared-memory files, as they are on disk",
      }),
    }),
    snapshots: files.openapi({
      description: "The raw Offer pages in `offer-pages/`: how many files and their bytes",
    }),
    unexpectedPages: files.openapi({
      description: "Pages saved for 'page layout changed?' in `unexpected-pages/`",
    }),
    freeBytes: z.number().int().nullable().openapi({
      description: "Free space on the data folder's disk; null when the system can't say",
    }),
    offers: z
      .object({
        total: z.number().int(),
        shown: z
          .number()
          .int()
          .openapi({ description: "Neither Stale nor Untracked: they take part in ranking" }),
        stale: z.number().int(),
        untracked: z
          .number()
          .int()
          .openapi({ description: "Not Stale, but no enabled Search matches them" }),
        keptForMarks: z.number().int().openapi({
          description:
            "Stale or Untracked Offers whose record a mark or override keeps from being pruned (also counted above)",
        }),
      })
      .openapi({ description: "Offers by state" }),
    requestLog: z.object({ rows: z.number().int() }),
    retention: z
      .object({
        recordDays: z.number().int().openapi({
          description:
            "An Offer record is deleted this long after it went Stale or Untracked, or after nothing kept the record any more if that came later",
        }),
        snapshotDays: z.number().int(),
        unexpectedPageDays: z.number().int(),
        requestLogDays: z.number().int(),
        lowDiskBytes: z
          .number()
          .int()
          .openapi({ description: "Crawling pauses with 'disk nearly full' under this much free" }),
        pruneAt: z.string(),
      })
      .openapi({ description: "Fixed constants, not settings" }),
    lastPrune: z.string().nullable().openapi({
      description:
        "ISO 8601 time the last prune that finished started; null if none ever did. `prune` says how the last attempt went.",
    }),
    prune: storagePrune,
    wipe: z
      .object({
        running: z
          .object({ since: z.string().openapi({ description: "ISO 8601" }) })
          .nullable()
          .openapi({
            description:
              '"Delete all Offer data" is under way: it waits for the request in flight, then deletes. The counts above are from before it until it is done. Null otherwise.',
          }),
        last: z
          .object({
            at: z.string().openapi({ description: "ISO 8601 time the rows were deleted" }),
            deleted: wipeDeleted,
            filesRemoved: z.boolean().openapi({
              description:
                "False while the stored pages are still being removed, or after the process stopped before it could: the next start removes them",
            }),
          })
          .nullable()
          .openapi({ description: "The latest wipe; null if there never was one" }),
      })
      .openapi("StorageWipe"),
    catchUp: storageCatchUp,
  })
  .openapi("Storage");

const wipeBody = z
  .object({
    confirm: z
      .literal(WIPE_CONFIRMATION, {
        error: `Type "${WIPE_CONFIRMATION}" to confirm.`,
      })
      .openapi({
        description: `Must be exactly "${WIPE_CONFIRMATION}". Without it nothing is deleted.`,
      }),
  })
  .openapi("WipeRequest");

const wipeResultSchema = z
  .object({
    deleted: wipeDeleted,
    storage: storageSchema,
  })
  .openapi("WipeResult");

const getStorageRoute = createRoute({
  method: "get",
  path: "/storage",
  tags: ["Data"],
  summary: "Database and snapshot sizes, Offer counts by state, and the retention constants",
  responses: {
    200: {
      description: "The storage readout",
      content: { "application/json": { schema: storageSchema } },
    },
    ...problemResponses("unauthorized"),
  },
});

const wipeRoute = createRoute({
  method: "post",
  path: "/storage/wipe",
  tags: ["Data"],
  summary: "Delete all Offer data",
  description:
    "Deletes Offers (with their Ad IDs, prices, history and links), every stored page, the seeker's marks (Dismissed, Shortlisted, Contacted, scam marks), manual fact overrides and merge/split pair overrides, the crawl queue and the request log. Crawling pauses as `wiped` first: the wipe waits for the request in flight, `GET /storage` shows it under `wipe.running`, and `POST /crawl/resume` is refused with `wipe-running` until it is done. Keeps the Seeker Profile, Filters, Searches, settings and secrets. The next Resume after it runs a fresh backfill of every Search. A second request while one runs gets the same result. It can't be undone, so the body must carry the typed confirmation. The request log rows the hourly and daily request caps still count are kept, so a wipe can't reset those caps.",
  request: {
    body: { content: { "application/json": { schema: wipeBody } }, required: true },
  },
  responses: {
    200: {
      description: "What was deleted, and the storage readout afterwards",
      content: { "application/json": { schema: wipeResultSchema } },
    },
    ...problemResponses("unauthorized", "validation-error", "invalid-body", "origin-not-allowed"),
  },
});

export const registerStorage: ApiModule = (api, { retention }) => {
  api.openapi(getStorageRoute, (c) => c.json(retention.storage(), 200));

  api.openapi(wipeRoute, async (c) => {
    const deleted = await retention.wipe();
    return c.json({ deleted, storage: retention.storage() }, 200);
  });
};
