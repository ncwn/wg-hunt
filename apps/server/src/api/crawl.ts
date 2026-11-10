import { createRoute, z } from "@hono/zod-openapi";
import { BOT_CHECK_MARKERS } from "../crawl/bot-check.js";
import { CRAWL_CONSTANTS, JOB_KINDS } from "../crawl/constants.js";
import { listRequests, REQUEST_OUTCOMES } from "../crawl/request-log.js";
import { crawlSettingsSchema, loadCrawlSettings } from "../crawl/settings.js";
import {
  CRAWL_HOLDS,
  CRAWL_STATES,
  PAUSE_CAUSES,
  PAUSE_REASONS,
  WAIT_REASONS,
} from "../crawl/status.js";
import { settingsStateSchema } from "../settings-state.js";
import type { ApiModule } from "./context.js";
import { pageSchema, paginationQuery } from "./pagination.js";
import { ProblemError, problemResponses } from "./problem.js";
import { etagHeader, etagOf, ifMatchHeaders, requireRevision } from "./revision.js";

const constantsSchema = z
  .object({
    maxInFlight: z.number().int(),
    gapFloorSeconds: z.number().int(),
    dailyCeiling: z.number().int(),
    rotation: z.string(),
    forbidden: z.string(),
    cooldownLadderHours: z.array(z.number().int()),
    halfBudgetHours: z.number().int(),
  })
  .openapi("CrawlConstants");

const settingsResponse = crawlSettingsSchema
  .extend({ constants: constantsSchema })
  .openapi("CrawlSettingsWithConstants");

const requestSchema = z
  .object({
    id: z.number().int(),
    at: z.string().openapi({ description: "ISO 8601 time the request was sent" }),
    kind: z.enum(JOB_KINDS).openapi({
      example: "poll",
      description: "The kind of the job that sent the request, as in `nextJobs` on `GET /crawl`",
    }),
    path: z.string().openapi({ description: "Path on the Source; no personal or location data" }),
    status: z.number().int().nullable(),
    outcome: z.enum(REQUEST_OUTCOMES).openapi({
      example: "ok",
      description:
        "`pending`: sent, no response yet. `received`: the response is in and its page is being handled. Then what the Source answered (`ok`, `redirect`, `http-error`, `network-error`), or `bot-check` (no page was handled), `unexpected-page` (the page could not be read; the crawl paused), `handler-error` (handling the page failed; the crawl paused). `interrupted`: the server stopped before a response came; the same job is sent again. `handler-interrupted`: the server stopped while the page was being handled; that job is not sent again as such, but whatever its Search or Ad ID still needs is queued again at boot.",
    }),
    marker: z
      .enum(BOT_CHECK_MARKERS)
      .nullable()
      .openapi({ description: "The bot-check marker that fired" }),
  })
  .openapi("CrawlRequest");

const botCheckRecordSchema = z
  .object({
    at: z.string().openapi({ description: "ISO 8601 time of the Bot check" }),
    path: z.string().openapi({ description: "Path on the Source; no personal or location data" }),
    marker: z.enum(BOT_CHECK_MARKERS),
    hourCount: z.number().int().openapi({ description: "Requests in the hour up to this one" }),
    dayCount: z
      .number()
      .int()
      .openapi({ description: "Requests in the Berlin day up to this one" }),
  })
  .openapi("BotCheckRecord");

const crawlStatusSchema = z
  .object({
    state: z.enum(CRAWL_STATES).openapi({
      description:
        '`cooling-down`: a Bot check Cooldown runs and cannot be cut short. `needs-resume`: the Cooldown is over but two Bot checks within 24 h need a manual Resume. `layout-changed`: a page wg-hunt could not read, or a failure while handling one, paused the crawl; `paused.cause` says which. `disk-full`: under 1 GB is free on the data folder\'s disk, which paused the crawl. `wiped`: "Delete all Offer data" paused the crawl; the next Resume backfills every Search. A Cooldown wins over a stop, and only the first stop is named: `holds` lists them all.',
    }),
    cooldown: z
      .object({
        until: z.string().openapi({ description: "ISO 8601 end of the Cooldown" }),
        level: z
          .number()
          .int()
          .openapi({ description: "1 for 2 h, 2 for 4 h, 3 for 8 h, 4 for 24 h" }),
        needsResume: z.boolean(),
      })
      .nullable()
      .openapi({
        description:
          "The latest Cooldown, until the probe after it has been answered or a Resume ended it. With `needsResume`, the crawl does not carry on by itself when it ends.",
      }),
    paused: z
      .object({
        reason: z.enum(PAUSE_REASONS),
        cause: z.enum(PAUSE_CAUSES).nullable().openapi({
          description:
            "Why a `layout-changed` pause happened. `unexpected-page`: the Source showed a page wg-hunt could not read; an update may be needed before a Resume helps. `handler-error`: wg-hunt failed while handling a page; the cause can be the disk, the database, or a page it cannot handle. A Resume tries again; if it pauses again, the server's log has the error's class and code, and the newest `handler-error` row of `GET /crawl/requests` names the page. Null for every other reason, and for a `layout-changed` pause stored before the cause was recorded.",
        }),
        since: z.string(),
        path: z.string().nullable(),
        savedAs: z.string().nullable().openapi({
          description:
            "Where the raw page is, relative to the data folder. Null when it could not be kept, or once a wipe or the 30-day prune deleted it",
        }),
      })
      .nullable(),
    holds: z.array(z.enum(CRAWL_HOLDS)).openapi({
      description:
        'Every stop that only a person ends, with a Resume, now or once the Cooldown is over: `paused` (a Pause), `layout-changed`, `disk-full`, `wiped` ("Delete all Offer data"; a Resume is refused while it still runs), `needs-resume` (two Bot checks within 24 h). One Resume lifts them all. Empty when the crawl carries on by itself.',
    }),
    nextRequest: z
      .object({
        at: z.iso.datetime().nullable().openapi({
          description:
            "When the next request is expected to go out: the earliest instant the gap, caps, active hours and any Cooldown allow, or the first queued job's due time if that is later. Null while only a Resume lets requests go (`holds` says which, including during a Cooldown that a Resume has to follow), or while nothing is queued.",
        }),
        waitingFor: z.enum(WAIT_REASONS).nullable().openapi({
          description:
            "What holds the next request back now; null when the limits let it go and it only waits for a job to be due.",
        }),
      })
      .openapi("NextRequest"),
    actions: z
      .object({
        pause: z.boolean().openapi({ description: "`POST /crawl/pause` would stop the crawl" }),
        resume: z.boolean().openapi({
          description:
            '`POST /crawl/resume` would lift the `holds`. False during a Cooldown or while "Delete all Offer data" runs, which refuse it, and when nothing waits for a Resume.',
        }),
      })
      .openapi("CrawlActions"),
    halfBudgetUntil: z.string().nullable().openapi({ description: "Caps are halved until then" }),
    counts: z.object({
      hour: z.object({ used: z.number().int(), cap: z.number().int() }),
      day: z.object({ used: z.number().int(), cap: z.number().int() }),
    }),
    nextJobs: z.array(z.object({ kind: z.enum(JOB_KINDS), path: z.string(), dueAt: z.string() })),
    lastBotCheck: botCheckRecordSchema.nullable(),
    settings: settingsStateSchema,
  })
  .openapi("CrawlStatus");

const getCrawlRoute = createRoute({
  method: "get",
  path: "/crawl",
  tags: ["Crawling"],
  summary: "The crawl state, today's and this hour's counts, and the next due jobs",
  responses: {
    200: {
      description: "The crawl status",
      content: { "application/json": { schema: crawlStatusSchema } },
    },
    ...problemResponses("unauthorized"),
  },
});

const pauseRoute = createRoute({
  method: "post",
  path: "/crawl/pause",
  tags: ["Crawling"],
  summary: "Stop after the request in flight, until Resume",
  responses: {
    200: {
      description: "The crawl status after pausing",
      content: { "application/json": { schema: crawlStatusSchema } },
    },
    ...problemResponses("unauthorized", "origin-not-allowed"),
  },
});

const resumeRoute = createRoute({
  method: "post",
  path: "/crawl/resume",
  tags: ["Crawling"],
  summary:
    "Lift a Pause, a layout-changed, disk-full or wiped pause, or the Resume owed after two Bot checks",
  description:
    'Refused with `bot-check-cooldown` while a Cooldown runs: neither Pause nor Resume cuts a Cooldown short. Refused with `wipe-running` while "Delete all Offer data" runs; it leaves the crawl paused as `wiped`, and the Resume after it starts a fresh backfill.',
  responses: {
    200: {
      description: "The crawl status after resuming",
      content: { "application/json": { schema: crawlStatusSchema } },
    },
    ...problemResponses("unauthorized", "bot-check-cooldown", "wipe-running", "origin-not-allowed"),
  },
});

const getSettingsRoute = createRoute({
  method: "get",
  path: "/settings/crawl",
  tags: ["Crawling"],
  summary: "Editable pacing and Recheck settings, with the read-only constants",
  responses: {
    200: {
      description:
        "The saved settings, or the defaults. A saved field that no longer parses is shown at its default: `settings` on `GET /crawl` names it",
      headers: etagHeader,
      content: { "application/json": { schema: settingsResponse } },
    },
    ...problemResponses("unauthorized"),
  },
});

const putSettingsRoute = createRoute({
  method: "put",
  path: "/settings/crawl",
  tags: ["Crawling"],
  summary: "Replace the editable settings; values outside the constants are refused",
  request: {
    headers: ifMatchHeaders,
    body: { content: { "application/json": { schema: crawlSettingsSchema } }, required: true },
  },
  responses: {
    200: {
      description: "The stored settings",
      headers: etagHeader,
      content: { "application/json": { schema: settingsResponse } },
    },
    ...problemResponses(
      "unauthorized",
      "validation-error",
      "invalid-body",
      "stale-revision",
      "origin-not-allowed",
    ),
  },
});

const listRequestsRoute = createRoute({
  method: "get",
  path: "/crawl/requests",
  tags: ["Crawling"],
  summary: "The request log, newest first",
  request: { query: paginationQuery },
  responses: {
    200: {
      description: "A page of the request log",
      content: { "application/json": { schema: pageSchema("CrawlRequestPage", requestSchema) } },
    },
    ...problemResponses("unauthorized", "validation-error", "invalid-cursor"),
  },
});

export const registerCrawl: ApiModule = (api, { db, crawl }) => {
  api.openapi(getCrawlRoute, (c) => c.json(crawl.status(), 200));

  api.openapi(pauseRoute, (c) => {
    crawl.pause();
    return c.json(crawl.status(), 200);
  });

  api.openapi(resumeRoute, (c) => {
    const result = crawl.resume();
    if (!result.ok && result.reason === "wipe-running") {
      throw new ProblemError(
        "wipe-running",
        "Offer data is being deleted. Resume once it is done: that starts a fresh backfill.",
      );
    }
    if (!result.ok) {
      throw new ProblemError(
        "bot-check-cooldown",
        `Cooling down after a Bot check until ${new Date(result.until).toISOString()}.`,
      );
    }
    return c.json(crawl.status(), 200);
  });

  // The revision covers the editable settings only; the constants are not the client's to write.
  api.openapi(getSettingsRoute, (c) => {
    const settings = loadCrawlSettings(db);
    return c.json({ ...settings, constants: CRAWL_CONSTANTS }, 200, { ETag: etagOf(settings) });
  });

  api.openapi(putSettingsRoute, (c) => {
    requireRevision(c.req.valid("header")["if-match"], loadCrawlSettings(db));
    const saved = crawl.saveSettings(c.req.valid("json"));
    return c.json({ ...saved, constants: CRAWL_CONSTANTS }, 200, { ETag: etagOf(saved) });
  });

  api.openapi(listRequestsRoute, (c) => {
    const { cursor, limit } = c.req.valid("query");
    return c.json(listRequests(db, { cursor, limit }), 200);
  });
};
