import { createRoute, z } from "@hono/zod-openapi";
import {
  CATEGORIES,
  DEFAULT_SOURCE,
  MAX_POLL_MINUTES,
  MAX_RECENCY_DAYS,
  MIN_POLL_MINUTES,
  RENT_TYPES,
} from "@wg-hunt/core";
import { eq } from "drizzle-orm";
import { type ForecastSearch, forecastDay, storedForecastSearches } from "../crawl/budget.js";
import { crawlSettingsSchema, loadCrawlSettings } from "../crawl/settings.js";
import { searches } from "../db/schema.js";
import type { ApiModule } from "./context.js";
import { problemResponses } from "./problem.js";

const waitMinutes = z.number().int().min(MIN_POLL_MINUTES).max(MAX_POLL_MINUTES);

const draftSearchSchema = z
  .object({
    id: z.number().int().optional().openapi({
      description:
        "The Search this draft changes; echoed back in the forecast. Leave out for a new Search.",
    }),
    city: z.string().optional().openapi({
      description:
        "The city as the draft would have it. Left out, a Search named by `id` keeps its stored city, and a new Search is taken as one the Source can read. Not checked as on a Search: a city the Source cannot resolve is not refused, its row reports `unknown-city` and costs nothing.",
    }),
    cityId: z.string().nullable().optional().openapi({
      description:
        "The Source's own number for the city, as on a Search; null for none. Left out, a Search named by `id` keeps its stored one.",
    }),
    categories: z.array(z.enum(CATEGORIES)).min(1),
    recencyDays: z.number().int().min(1).max(MAX_RECENCY_DAYS),
    enabled: z.boolean(),
    pollInterval: z
      .object({ minMinutes: waitMinutes, maxMinutes: waitMinutes })
      .refine((i) => i.minMinutes <= i.maxMinutes, {
        message: "The longest wait can't be shorter than the shortest",
        path: ["maxMinutes"],
      }),
  })
  .strict()
  .openapi("DraftSearch");

const draftSchema = z
  .object({
    settings: crawlSettingsSchema.optional().openapi({
      description: "Draft pacing and Recheck settings. Leave out to use the stored ones.",
    }),
    searches: z.array(draftSearchSchema).optional().openapi({
      description:
        "The complete list of Searches as the draft would have them (a changed one replaced, a new one added). Leave out to use the stored Searches.",
    }),
  })
  .strict()
  .openapi("ForecastDraft");

const intervalSchema = z.object({ minMinutes: z.number(), maxMinutes: z.number() });

const forecastSchema = z
  .object({
    dailyCap: z.number().int().openapi({
      description:
        "The daily cap the forecast is worked from: the one in force now, halved for a day after a Cooldown (see `halfBudget`).",
    }),
    requests: z
      .object({
        polls: z
          .number()
          .int()
          .openapi({ description: "Page requests of polls, after stretching." }),
        sweeps: z.number().int().openapi({ description: "Page requests of the daily Sweeps." }),
        newOffers: z
          .number()
          .int()
          .openapi({ description: "Detail fetches of expected new Offers." }),
        confirmations: z.number().int().openapi({
          description: "Stale confirmation fetches for Offers a Sweep did not see.",
        }),
        rechecks: z.number().int().openapi({
          description: "What the cap leaves for Rechecks after the four above; never negative.",
        }),
      })
      .openapi({ description: "Expected requests in one day." }),
    halfBudget: z
      .object({
        until: z.string().openapi({ description: "When the full caps apply again." }),
        fullDailyCap: z
          .number()
          .int()
          .openapi({ description: "The configured daily cap, in force again from `until`." }),
      })
      .nullable()
      .openapi({
        description:
          "Set while the caps are halved after a Cooldown: the forecast is worked from the halved cap until then. Null otherwise.",
      }),
    recheck: z.object({ enabled: z.boolean() }),
    stretch: z.object({
      factor: z.number().openapi({
        description:
          "What every poll interval is multiplied by so polls plus Sweeps fit in half the cap.",
      }),
      applied: z
        .boolean()
        .openapi({ description: "True when polls plus Sweeps would pass half the cap." }),
    }),
    searches: z.array(
      z.object({
        id: z.number().int().nullable(),
        enabled: z.boolean(),
        problem: z.enum(["unknown-city"]).nullable().openapi({
          description:
            "Why an enabled Search costs nothing here, as the Search itself reports it (`poll.problem`). `unknown-city`: the Source's adapter has no id for the city, so nothing is sent for the Search. Null when the Source can read it.",
        }),
        polls: z.number().int().openapi({
          description:
            "Poll requests a day, after stretching. 0 for a Search that is not crawled: disabled, or with a `problem`.",
        }),
        sweeps: z.number().int().openapi({
          description: "Sweep page requests a day. 0 for a Search that is not crawled.",
        }),
        pollInterval: intervalSchema,
        effectiveInterval: intervalSchema.openapi({
          description: "The interval after stretching.",
        }),
      }),
    ),
    warnings: z.array(
      z.object({
        type: z.enum(["polls-below-one-per-2h", "over-budget", "no-room-for-polls"]),
        message: z.string(),
      }),
    ),
  })
  .openapi("Forecast");

const tags = ["Crawling"];

const getRoute = createRoute({
  method: "get",
  path: "/crawl/forecast",
  tags,
  summary: "The budget forecast for the stored Searches and settings",
  description:
    "Expected requests in a day: polls, Sweeps, new Offers and Stale confirmations, and what is left for Rechecks. Only Searches the crawler reads are charged: a disabled Search, or an enabled one the Source cannot read (its row's `problem` says why), costs nothing. If polls plus Sweeps would take more than half the daily cap, every poll interval is stretched evenly until they fit, and the forecast warns when polls drop below one per 2 h. For a day after a Cooldown the caps are halved, and the forecast is worked from the halved cap (`halfBudget` says until when).",
  responses: {
    200: {
      description: "The forecast",
      content: { "application/json": { schema: forecastSchema } },
    },
    ...problemResponses("unauthorized"),
  },
});

const postRoute = createRoute({
  method: "post",
  path: "/crawl/forecast",
  tags,
  summary: "The budget forecast for draft Searches and settings; saves nothing",
  request: {
    body: { content: { "application/json": { schema: draftSchema } }, required: true },
  },
  responses: {
    200: {
      description: "The forecast",
      content: { "application/json": { schema: forecastSchema } },
    },
    ...problemResponses("unauthorized", "validation-error", "invalid-body", "origin-not-allowed"),
  },
});

export const registerForecast: ApiModule = (api, { db, crawl, polling }) => {
  function fromDraft(input: z.infer<typeof draftSearchSchema>): ForecastSearch {
    const { city: draftCity, cityId: draftCityId, ...draft } = input;
    const stored =
      draft.id === undefined
        ? undefined
        : db.select().from(searches).where(eq(searches.id, draft.id)).get();
    const city = draftCity ?? stored?.city;
    const problem =
      city === undefined
        ? null
        : polling.problemOf({
            source: stored?.source ?? DEFAULT_SOURCE,
            city,
            cityId: draftCityId === undefined ? (stored?.cityId ?? null) : draftCityId,
            categories: draft.categories,
            rentTypes: stored?.rentTypes ?? RENT_TYPES,
            priceCeiling: stored?.priceCeiling ?? null,
            recencyDays: draft.recencyDays,
          });
    return { ...draft, problem };
  }

  api.openapi(getRoute, (c) => {
    const settings = loadCrawlSettings(db);
    return c.json(
      forecastDay({
        searches: storedForecastSearches(db, polling.problemOf),
        settings,
        caps: crawl.caps(settings.pacing),
      }),
      200,
    );
  });

  api.openapi(postRoute, (c) => {
    const draft = c.req.valid("json");
    const settings = draft.settings ?? loadCrawlSettings(db);
    // A draft's caps are halved too while the half budget lasts, so it compares with what runs.
    return c.json(
      forecastDay({
        searches: draft.searches?.map(fromDraft) ?? storedForecastSearches(db, polling.problemOf),
        settings,
        caps: crawl.caps(settings.pacing),
      }),
      200,
    );
  });
};
