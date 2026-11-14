import { createRoute, z } from "@hono/zod-openapi";
import {
  CATEGORIES,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_SOURCE,
  MAX_POLL_MINUTES,
  MAX_RECENCY_DAYS,
  MIN_POLL_MINUTES,
  pageOf,
  RENT_TYPES,
  SOURCES,
} from "@wg-hunt/core";
import { asc, eq, gt } from "drizzle-orm";
import { ACTIVE_HOURS_ZONE } from "../crawl/constants.js";
import type { CrawlNowResult, SearchPolling } from "../crawl/search-polls.js";
import { type PauseCause, WAIT_REASONS, type WaitReason } from "../crawl/status.js";
import { sweepView } from "../crawl/sweep-state.js";
import type { Db } from "../db/index.js";
import { type SearchRow, searches } from "../db/schema.js";
import type { ApiModule } from "./context.js";
import { cursorPosition, pageSchema, paginationQuery } from "./pagination.js";
import { ProblemError, problemResponses } from "./problem.js";

const MAX_PRICE_CEILING = 100_000;

const distinct = (items: readonly unknown[]) => new Set(items).size === items.length;

const categories = z
  .array(z.enum(CATEGORIES, { error: "Pick from the listed categories" }))
  .min(1, "Pick at least one category")
  .refine(distinct, "Each category can be listed once");

const rentTypes = z
  .array(z.enum(RENT_TYPES, { error: "Pick from the listed rent types" }))
  .min(1, "Pick at least one rent type")
  .refine(distinct, "Each rent type can be listed once");

const minutes = (what: string) =>
  z
    .number({ error: `${what} must be a whole number of minutes` })
    .int(`${what} must be a whole number of minutes`)
    .min(MIN_POLL_MINUTES, `${what} must be at least ${MIN_POLL_MINUTES} minutes`)
    .max(MAX_POLL_MINUTES, `${what} must be at most ${MAX_POLL_MINUTES} minutes (a day)`);

const pollInterval = z
  .object({
    minMinutes: minutes("The shortest wait"),
    maxMinutes: minutes("The longest wait"),
  })
  .strict()
  .refine((interval) => interval.minMinutes <= interval.maxMinutes, {
    message: "The longest wait can't be shorter than the shortest",
    path: ["maxMinutes"],
  })
  .openapi("PollInterval", {
    description: "Each poll of the Search comes a random time in this range after the last one.",
  });

const fields = {
  city: z
    .string({ error: "Enter a city" })
    .trim()
    .min(1, "Enter a city")
    .max(100, "A city name can be at most 100 characters"),
  cityId: z
    .string({ error: "The city id is a number" })
    .regex(/^\d{1,6}$/, "The city id is a number, such as 55")
    .nullable()
    .openapi({
      description:
        "The Source's own number for the city, needed for cities the Source's adapter doesn't know by name. On wg-gesucht.de it is the first number after the city in a search URL (`wg-zimmer-in-Hamburg.55.0.1.0.html` -> 55). Null when the adapter knows the city.",
    }),
  categories,
  rentTypes,
  priceCeiling: z
    .number({ error: "Enter a whole number of euros, or leave it empty" })
    .int("Enter a whole number of euros")
    .min(1, "The price ceiling must be at least €1")
    .max(MAX_PRICE_CEILING, `The price ceiling can be at most €${MAX_PRICE_CEILING}`)
    .nullable()
    .openapi({ description: "Loose ceiling on warm rent per month, in euros; null for none." }),
  recencyDays: z
    .number({ error: "Enter a whole number of days" })
    .int("Enter a whole number of days")
    .min(1, "The window must be at least 1 day")
    .max(MAX_RECENCY_DAYS, `The window can be at most ${MAX_RECENCY_DAYS} days (1 week)`)
    .openapi({ description: "How recent Offers must be, in days. Capped at 1 week." }),
  enabled: z.boolean({ error: "Enabled is true or false" }),
  pollInterval,
};

const searchSchema = z
  .object({
    id: z.number().int(),
    source: z.enum(SOURCES),
    ...fields,
    poll: z
      .object({
        nextAt: z.iso.datetime().nullable().openapi({
          description:
            "When the next poll is due; it still waits for the pacing. Null while disabled or when the city is not recognised.",
        }),
        problem: z.enum(["unknown-city"]).nullable().openapi({
          description:
            "`unknown-city`: the Source's adapter has no id for the city. Give `cityId`, or the Search is never polled.",
        }),
      })
      .openapi("SearchPoll"),
    sweep: z
      .object({
        status: z.enum(["idle", "scheduled", "running"]).openapi({
          description:
            "`idle`: nothing is swept (the Search is disabled or not readable). `scheduled`: the next Sweep starts at `startAt`. `running`: its pages are being read.",
        }),
        mode: z.enum(["backfill", "daily"]).nullable().openapi({
          description:
            "`backfill`: the first full read since the Search was made, edited or became readable; Offers it does not see stop being matched. `daily`: a later Sweep; each Offer it misses gets one confirmation fetch. Null while idle.",
        }),
        startAt: z.iso.datetime().nullable().openapi({
          description:
            "When the scheduled Sweep starts; it still waits for the pacing. Null unless scheduled.",
        }),
        pagesRead: z.number().int().openapi({
          description: "Result pages the running Sweep has read so far; 0 unless running.",
        }),
        lastFinishedAt: z.iso.datetime().nullable().openapi({
          description:
            "When a Sweep of this Search last finished, of either mode. Null if none has.",
        }),
      })
      .openapi("SearchSweep", {
        description:
          "The Search's Sweep: a full read of its window at deeper-page priority, once a day, that keeps the matched Offers honest.",
      }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("Search");

const crawlNowSchema = z
  .object({
    queued: z.number().int().openapi({
      description: "How many polls were made due: one per category of the Search.",
    }),
    runsAt: z.iso.datetime().nullable().openapi({
      description:
        "When the first request may go out, under the gap, caps, active hours and any Cooldown. Null while only a Resume helps, including during a Cooldown that a Resume has to follow. Other polls already due may go first.",
    }),
    waiting: z.enum(WAIT_REASONS).nullable().openapi({
      description: "What holds the request back; null when it may go right away.",
    }),
    message: z
      .string()
      .openapi({ example: "Queued for 07:00 (Europe/Berlin): outside active hours." }),
  })
  .openapi("CrawlNow");

// Optional rather than `.default(...)`, so the generated client types them as optional too.
const createSearchSchema = z
  .object({
    source: z
      .enum(SOURCES, { error: `Source must be one of: ${SOURCES.join(", ")}` })
      .optional()
      .openapi({ description: `Defaults to \`${DEFAULT_SOURCE}\`.` }),
    city: fields.city,
    cityId: fields.cityId.optional().openapi({ description: "Defaults to none." }),
    categories,
    rentTypes: rentTypes.optional().openapi({ description: "Defaults to all rent types." }),
    priceCeiling: fields.priceCeiling
      .optional()
      .openapi({ description: "Defaults to no ceiling." }),
    recencyDays: fields.recencyDays
      .optional()
      .openapi({ description: `Defaults to ${MAX_RECENCY_DAYS}, the longest allowed.` }),
    enabled: fields.enabled.optional().openapi({ description: "Defaults to true." }),
    pollInterval: pollInterval.optional(),
  })
  .strict()
  .openapi("NewSearch");

// The Source is fixed once a Search exists: a different Source is a different Search.
const updateSearchSchema = z.object(fields).partial().strict().openapi("SearchChanges");

const idParam = z.object({
  id: z.coerce
    .number()
    .int()
    .min(1)
    .openapi({ param: { name: "id", in: "path" }, example: 1 }),
});

const tags = ["Searches"];

const listRoute = createRoute({
  method: "get",
  path: "/searches",
  tags,
  summary: "List the Searches, oldest first",
  request: { query: paginationQuery },
  responses: {
    200: {
      description: "A page of Searches",
      content: { "application/json": { schema: pageSchema("SearchPage", searchSchema) } },
    },
    ...problemResponses("unauthorized", "validation-error", "invalid-cursor"),
  },
});

const createRouteDef = createRoute({
  method: "post",
  path: "/searches",
  tags,
  summary: "Create a Search",
  request: {
    body: { content: { "application/json": { schema: createSearchSchema } }, required: true },
  },
  responses: {
    201: {
      description: "The new Search",
      content: { "application/json": { schema: searchSchema } },
    },
    ...problemResponses("unauthorized", "validation-error", "invalid-body", "origin-not-allowed"),
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/searches/{id}",
  tags,
  summary: "Read one Search",
  request: { params: idParam },
  responses: {
    200: { description: "The Search", content: { "application/json": { schema: searchSchema } } },
    ...problemResponses("unauthorized", "validation-error", "not-found"),
  },
});

const patchRoute = createRoute({
  method: "patch",
  path: "/searches/{id}",
  tags,
  summary: "Change a Search; only the fields sent change",
  request: {
    params: idParam,
    body: { content: { "application/json": { schema: updateSearchSchema } }, required: true },
  },
  responses: {
    200: {
      description: "The Search as changed",
      content: { "application/json": { schema: searchSchema } },
    },
    ...problemResponses(
      "unauthorized",
      "validation-error",
      "invalid-body",
      "not-found",
      "origin-not-allowed",
    ),
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/searches/{id}",
  tags,
  summary: "Delete a Search",
  request: { params: idParam },
  responses: {
    204: { description: "The Search is gone" },
    ...problemResponses("unauthorized", "validation-error", "not-found", "origin-not-allowed"),
  },
});

const crawlNowRoute = createRoute({
  method: "post",
  path: "/searches/{id}/crawl-now",
  tags,
  summary: "Make the Search's poll due now",
  description:
    "The poll still waits for the gap between requests, the hourly and daily caps, the active hours and any Cooldown, and never cuts a Cooldown short. The answer says when it will run.",
  request: { params: idParam },
  responses: {
    202: {
      description: "The poll is queued",
      content: { "application/json": { schema: crawlNowSchema } },
    },
    ...problemResponses(
      "unauthorized",
      "validation-error",
      "not-found",
      "search-disabled",
      "unknown-city",
      "origin-not-allowed",
    ),
  },
});

const WAIT_PHRASES: Record<WaitReason, string> = {
  gap: "the pause between requests",
  "hourly-cap": "the hourly request cap",
  "daily-cap": "the daily request cap",
  "active-hours": "outside active hours",
  cooldown: "cooling down after a Bot check",
  "needs-resume": "two Bot checks within a day need a manual Resume",
  paused: "the crawl is paused",
  "layout-changed": "a page the crawler didn't understand paused it",
  "disk-full": "the disk is nearly full, which paused the crawl",
  wiped: "the Offer data was deleted, which paused the crawl until a Resume",
};

function waitPhrase(waiting: WaitReason, cause: PauseCause | null): string {
  if (waiting === "layout-changed" && cause === "handler-error") {
    return "wg-hunt failed while handling a page, which paused the crawl";
  }
  return WAIT_PHRASES[waiting];
}

const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: ACTIVE_HOURS_ZONE });
const timeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: ACTIVE_HOURS_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function crawlNowMessage(
  result: Extract<CrawlNowResult, { ok: true }>,
  now: number,
  cause: PauseCause | null,
): string {
  if (result.waiting === null) return "Polling as soon as the request queue gets to it.";
  const why = waitPhrase(result.waiting, cause);
  if (result.runsAt === null) {
    const after = result.waiting === "cooldown" ? "the break is over and " : "";
    return `Queued, but nothing is sent until ${after}you press Resume: ${why}.`;
  }
  const day = dayFormat.format(result.runsAt) === dayFormat.format(now) ? "" : "tomorrow ";
  const when = `${day}${timeFormat.format(result.runsAt)}`;
  return `Queued for ${when} (${ACTIVE_HOURS_ZONE}): ${why}.`;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function toApi(row: SearchRow, db: Db, polling: SearchPolling): z.infer<typeof searchSchema> {
  const nextAt = row.enabled ? polling.nextPollAt(row) : null;
  const sweep = sweepView(db, row);
  return {
    id: row.id,
    source: row.source,
    city: row.city,
    cityId: row.cityId,
    poll: {
      nextAt: nextAt === null ? null : new Date(nextAt).toISOString(),
      problem: polling.problemOf(row),
    },
    sweep: {
      status: sweep.status,
      mode: sweep.mode,
      startAt: iso(sweep.startAt),
      pagesRead: sweep.pagesRead,
      lastFinishedAt: iso(sweep.lastFinishedAt),
    },
    categories: row.categories,
    rentTypes: row.rentTypes,
    priceCeiling: row.priceCeiling,
    recencyDays: row.recencyDays,
    enabled: row.enabled,
    pollInterval: { minMinutes: row.pollMinMinutes, maxMinutes: row.pollMaxMinutes },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function findSearch(db: Db, id: number): SearchRow {
  const row = db.select().from(searches).where(eq(searches.id, id)).get();
  if (!row) throw new ProblemError("not-found", `There is no Search with id ${id}.`);
  return row;
}

export const registerSearches: ApiModule = (api, { db, polling, crawl, clock }) => {
  api.openapi(listRoute, (c) => {
    const { cursor, limit } = c.req.valid("query");
    const position = cursorPosition(cursor);
    if (position !== undefined && typeof position.id !== "number") {
      throw new ProblemError("invalid-cursor");
    }
    const rows = db
      .select()
      .from(searches)
      .where(position ? gt(searches.id, position.id as number) : undefined)
      .orderBy(asc(searches.id))
      .limit(limit + 1)
      .all();
    const page = pageOf(rows, limit, (row) => ({ id: row.id }));
    return c.json(
      { items: page.items.map((row) => toApi(row, db, polling)), nextCursor: page.nextCursor },
      200,
    );
  });

  api.openapi(createRouteDef, (c) => {
    const input = c.req.valid("json");
    const now = new Date(clock());
    const interval = input.pollInterval ?? DEFAULT_POLL_INTERVAL;
    const row = db
      .insert(searches)
      .values({
        source: input.source ?? DEFAULT_SOURCE,
        city: input.city,
        cityId: input.cityId ?? null,
        categories: input.categories,
        rentTypes: input.rentTypes ?? [...RENT_TYPES],
        priceCeiling: input.priceCeiling ?? null,
        recencyDays: input.recencyDays ?? MAX_RECENCY_DAYS,
        enabled: input.enabled ?? true,
        pollMinMinutes: interval.minMinutes,
        pollMaxMinutes: interval.maxMinutes,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    polling.sync();
    return c.json(toApi(row, db, polling), 201);
  });

  api.openapi(getRoute, (c) =>
    c.json(toApi(findSearch(db, c.req.valid("param").id), db, polling), 200),
  );

  api.openapi(patchRoute, (c) => {
    const { id } = c.req.valid("param");
    const { pollInterval: interval, ...changes } = c.req.valid("json");
    const current = findSearch(db, id);
    const set: Partial<typeof searches.$inferInsert> = {
      ...changes,
      ...(interval && {
        pollMinMinutes: interval.minMinutes,
        pollMaxMinutes: interval.maxMinutes,
      }),
    };
    if (Object.keys(set).length === 0) return c.json(toApi(current, db, polling), 200);
    const row = db
      .update(searches)
      .set({ ...set, updatedAt: new Date(clock()) })
      .where(eq(searches.id, id))
      .returning()
      .get();
    polling.sync();
    return c.json(toApi(row, db, polling), 200);
  });

  api.openapi(deleteRoute, (c) => {
    const { id } = c.req.valid("param");
    findSearch(db, id);
    db.delete(searches).where(eq(searches.id, id)).run();
    polling.sync();
    return c.body(null, 204);
  });

  api.openapi(crawlNowRoute, (c) => {
    const { id } = c.req.valid("param");
    const search = findSearch(db, id);
    const result = polling.crawlNow(search);
    if (!result.ok) {
      if (result.reason === "disabled") {
        throw new ProblemError(
          "search-disabled",
          `The Search for ${search.city} is disabled. Enable it to poll it.`,
        );
      }
      throw new ProblemError(
        "unknown-city",
        "The Source's adapter doesn't know this city. Give the Search the Source's own number for it (cityId).",
      );
    }
    const now = clock();
    return c.json(
      {
        queued: result.queued,
        runsAt: result.runsAt === null ? null : new Date(result.runsAt).toISOString(),
        waiting: result.waiting,
        message: crawlNowMessage(result, now, crawl.status().paused?.cause ?? null),
      },
      202,
    );
  });
};
