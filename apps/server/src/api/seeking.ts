import { createRoute, z } from "@hono/zod-openapi";
import {
  BANDS,
  CATEGORIES,
  examplePreset,
  type Filters,
  filtersSchema,
  findPlace,
  RENT_TYPES,
  type SeekerProfile,
  type Seeking,
  seekerProfileSchema,
} from "@wg-hunt/core";
import {
  loadFilters,
  loadProfile,
  loadSeeking,
  saveFilters,
  saveProfile,
  saveSeeking,
} from "../seeking.js";
import type { ApiModule } from "./context.js";
import { ProblemError, problemResponses } from "./problem.js";
import { bandSchema } from "./ranking-schemas.js";
import { etagHeader, etagOf, ifMatchHeaders, isCurrent, requireRevision } from "./revision.js";

const tags = ["Seeking"];

const profileSchema = seekerProfileSchema.meta({
  id: "SeekerProfile",
  description:
    "Who is looking. Every personal value ships unset (null); a Filter that needs a value the seeker has not given is not evaluated.",
});
const filterSetSchema = filtersSchema.meta({
  id: "Filters",
  description:
    "The active Filter set: each Filter can be switched off and is a Dealbreaker (hides) or a Want (moves to Near match). A numeric Filter with no limit set is not evaluated; its margin keeps a near miss in Near match.",
});

const bandCounts = z.object(Object.fromEntries(BANDS.map((band) => [band, z.number().int()])));

const previewBody = z
  .object({
    profile: profileSchema.optional().openapi({
      description: "A draft Seeker Profile. Left out, the saved one is used.",
    }),
    filters: filterSetSchema.optional().openapi({
      description: "A draft Filter set. Left out, the saved one is used.",
    }),
  })
  .openapi("RankingPreviewRequest");

const previewSchema = z
  .object({
    changes: z
      .array(
        z.object({
          offerId: z.number().int(),
          title: z.string(),
          from: bandSchema,
          to: bandSchema,
        }),
      )
      .openapi({
        description:
          "The Offers that would change band, newest first. Compared with the saved Profile and Filters.",
      }),
    counts: z.object({ before: bandCounts, after: bandCounts }),
  })
  .openapi("RankingPreview");

const presetSchema = z
  .object({
    profile: profileSchema,
    filters: filterSetSchema,
    search: z
      .object({
        city: z.string(),
        categories: z.array(z.enum(CATEGORIES)),
        rentTypes: z.array(z.enum(RENT_TYPES)),
        priceCeiling: z.number().int(),
        recencyDays: z.number().int(),
      })
      .openapi("ExamplePresetSearch", {
        description: "The fields of a new Search (`POST /searches`); it is not created.",
      }),
  })
  .openapi("ExamplePreset", {
    description:
      "A fictional Seeker Profile, Filter set and Search to start from. Nothing here is saved.",
  });

const revisionField = (document: string) =>
  z
    .string()
    .optional()
    .openapi({
      description: `The ${document}'s revision when it was read: its \`ETag\`, or the one this route answered. If it has changed since, nothing is saved. Left out, it is not checked.`,
      example: '"3f2a9c0d1b7e4a56"',
    });

const seekingChanges = z
  .object({
    profile: profileSchema.optional().openapi({
      description: "The whole new Seeker Profile. Left out, the saved one stays.",
    }),
    filters: filterSetSchema.optional().openapi({
      description: "The whole new Filter set. Left out, the saved one stays.",
    }),
    revisions: z
      .object({ profile: revisionField("Seeker Profile"), filters: revisionField("Filter set") })
      .strict()
      .optional()
      .openapi({
        description:
          "Each revision given is checked, also for a document the write leaves out, before anything is written.",
      }),
  })
  .strict()
  .openapi("SeekingChanges", {
    description:
      "At least one of `profile` and `filters`. The same keys as `RankingPreviewRequest`, so a previewed draft can be saved as it is.",
  });

const seekingSchema = z
  .object({
    profile: profileSchema,
    filters: filterSetSchema,
    revisions: z.object({
      profile: z.string().openapi({
        description: "Send it back as `revisions.profile`, or as `If-Match` on `PUT /profile`.",
      }),
      filters: z.string().openapi({
        description: "Send it back as `revisions.filters`, or as `If-Match` on `PUT /filters`.",
      }),
    }),
  })
  .openapi("Seeking", {
    description: "The saved Seeker Profile and Filter set, with their revisions.",
  });

const profileResponse = {
  200: {
    description: "The Seeker Profile",
    headers: etagHeader,
    content: { "application/json": { schema: profileSchema } },
  },
};
const filtersResponse = {
  200: {
    description: "The Filters",
    headers: etagHeader,
    content: { "application/json": { schema: filterSetSchema } },
  },
};

const getProfile = createRoute({
  method: "get",
  path: "/profile",
  tags,
  summary: "The Seeker Profile (the neutral defaults on a fresh install)",
  responses: { ...profileResponse, ...problemResponses("unauthorized") },
});

const putProfile = createRoute({
  method: "put",
  path: "/profile",
  tags,
  summary: "Replace the Seeker Profile and rank every Offer again",
  description:
    "Costs no crawling and no model call: the Offers are ranked again at once, and `offer-band-changed` is emitted for each that moved. A Profile that drops or renames the Place the saved distance Filter measures from is refused at `places`; save both with `PUT /seeking` instead.",
  request: {
    headers: ifMatchHeaders,
    body: { content: { "application/json": { schema: profileSchema } }, required: true },
  },
  responses: {
    ...profileResponse,
    ...problemResponses(
      "unauthorized",
      "validation-error",
      "invalid-body",
      "origin-not-allowed",
      "stale-revision",
    ),
  },
});

const getFilters = createRoute({
  method: "get",
  path: "/filters",
  tags,
  summary: "The active Filter set (the neutral defaults on a fresh install)",
  responses: { ...filtersResponse, ...problemResponses("unauthorized") },
});

const putFilters = createRoute({
  method: "put",
  path: "/filters",
  tags,
  summary: "Replace the Filter set and rank every Offer again",
  description:
    "Costs no crawling and no model call: the Offers are ranked again at once, and `offer-band-changed` is emitted for each that moved.",
  request: {
    headers: ifMatchHeaders,
    body: { content: { "application/json": { schema: filterSetSchema } }, required: true },
  },
  responses: {
    ...filtersResponse,
    ...problemResponses(
      "unauthorized",
      "validation-error",
      "invalid-body",
      "origin-not-allowed",
      "stale-revision",
    ),
  },
});

const putSeeking = createRoute({
  method: "put",
  path: "/seeking",
  tags,
  summary:
    "Replace the Seeker Profile, the Filter set or both in one write, and rank every Offer again",
  description:
    "Both revisions are checked and the pair is validated before anything is written: a Place the distance Filter names must be in the resulting Profile. Then both are written together and the Offers are ranked again once, so an Offer that ends in the band it started in gets no `offer-band-changed`. This is how a Place the distance Filter measures from is renamed or removed. Costs no crawling and no model call.",
  request: {
    body: { content: { "application/json": { schema: seekingChanges } }, required: true },
  },
  responses: {
    200: {
      description: "Both documents as saved now",
      content: { "application/json": { schema: seekingSchema } },
    },
    ...problemResponses(
      "unauthorized",
      "validation-error",
      "invalid-body",
      "origin-not-allowed",
      "stale-revision",
    ),
  },
});

const previewRoute = createRoute({
  method: "post",
  path: "/ranking/preview",
  tags,
  summary: "Which Offers would change band under a draft Profile and Filters",
  description:
    "Saves nothing of the draft and makes no request to the Source or a model. `before` is ranked as `GET /offers/counts` is: a move that only time caused is recorded and announced with `offer-band-changed` first.",
  request: { body: { content: { "application/json": { schema: previewBody } }, required: true } },
  responses: {
    200: {
      description: "The band changes",
      content: { "application/json": { schema: previewSchema } },
    },
    ...problemResponses("unauthorized", "validation-error", "invalid-body", "origin-not-allowed"),
  },
});

const getPreset = createRoute({
  method: "get",
  path: "/presets/example",
  tags,
  summary: "The fictional example preset, as a draft",
  description:
    "Never applies itself and saves nothing: the client shows it as a draft, and the seeker saves the Profile and the Filters together (`PUT /seeking`), and then the Search. The move-in window is the 1st to the 15th of the month two months after today (Europe/Berlin).",
  responses: {
    200: {
      description: "The example preset",
      content: { "application/json": { schema: presetSchema } },
    },
    ...problemResponses("unauthorized"),
  },
});

const BERLIN_MONTH = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "numeric",
});

function berlinMonth(ms: number): { year: number; month: number } {
  const part = (type: "year" | "month") =>
    Number(BERLIN_MONTH.formatToParts(ms).find((p) => p.type === type)?.value);
  return { year: part("year"), month: part("month") };
}

function measuresFromMissingPlace({ profile, filters }: Seeking): boolean {
  const { place } = filters.distance;
  return place !== null && findPlace(profile.places, place) === undefined;
}

function requirePlace(filters: Filters, profile: SeekerProfile, path = "distance.place"): void {
  if (measuresFromMissingPlace({ profile, filters })) {
    throw new ProblemError(
      "validation-error",
      "The distance Filter measures from a Place that the Seeker Profile does not have.",
      [{ path, message: "The Seeker Profile has no Place with this name" }],
    );
  }
}

/** A Place's name stays out of every error. */
function refusePlaceLost(path: string): never {
  throw new ProblemError(
    "validation-error",
    "The distance Filter measures from a Place this Seeker Profile does not have. To rename or remove that Place, save the Seeker Profile and the Filters together.",
    [
      {
        path,
        message: "The distance Filter measures from a Place this Seeker Profile does not have",
      },
    ],
  );
}

const STALE: Record<"profile" | "filters" | "both", string> = {
  profile: "The Seeker Profile was changed after you read it",
  filters: "The Filters were changed after you read them",
  both: "The Seeker Profile and the Filters were changed after you read them",
};

export const registerSeeking: ApiModule = (api, { db, offers, clock }) => {
  const profileReply = () => {
    const profile = loadProfile(db);
    return [profile, { ETag: etagOf(profile) }] as const;
  };
  const filtersReply = () => {
    const filters = loadFilters(db);
    return [filters, { ETag: etagOf(filters) }] as const;
  };

  api.openapi(getProfile, (c) => {
    const [profile, headers] = profileReply();
    return c.json(profile, 200, headers);
  });

  api.openapi(putProfile, (c) => {
    // Checked and written in one synchronous step, so no other write can land in between.
    const saved = loadSeeking(db);
    requireRevision(c.req.valid("header")["if-match"], saved.profile);
    const next = c.req.valid("json");
    if (!measuresFromMissingPlace(saved) && measuresFromMissingPlace({ ...saved, profile: next })) {
      refusePlaceLost("places");
    }
    saveProfile(db, next);
    offers.rebandAll();
    const [profile, headers] = profileReply();
    return c.json(profile, 200, headers);
  });

  api.openapi(getFilters, (c) => {
    const [filters, headers] = filtersReply();
    return c.json(filters, 200, headers);
  });

  api.openapi(putFilters, (c) => {
    requireRevision(c.req.valid("header")["if-match"], loadFilters(db));
    const filters = c.req.valid("json");
    requirePlace(filters, loadProfile(db));
    saveFilters(db, filters);
    offers.rebandAll();
    const [saved, headers] = filtersReply();
    return c.json(saved, 200, headers);
  });

  api.openapi(putSeeking, (c) => {
    const { profile, filters, revisions } = c.req.valid("json");
    if (profile === undefined && filters === undefined) {
      throw new ProblemError("validation-error", "Give a Seeker Profile, Filters or both.", [
        { path: "", message: "Give profile, filters or both" },
      ]);
    }
    const saved = loadSeeking(db);
    const profileStale = !isCurrent(revisions?.profile, saved.profile);
    const filtersStale = !isCurrent(revisions?.filters, saved.filters);
    if (profileStale || filtersStale) {
      const which = profileStale && filtersStale ? "both" : profileStale ? "profile" : "filters";
      throw new ProblemError(
        "stale-revision",
        `${STALE[which]}, so nothing was saved. Read both again, make the change to what is there now, and save that.`,
      );
    }
    const next = { profile: profile ?? saved.profile, filters: filters ?? saved.filters };
    if (filters) requirePlace(next.filters, next.profile, "filters.distance.place");
    else if (measuresFromMissingPlace(next)) refusePlaceLost("profile.places");
    saveSeeking(db, { profile, filters });
    offers.rebandAll();
    const now = loadSeeking(db);
    return c.json(
      { ...now, revisions: { profile: etagOf(now.profile), filters: etagOf(now.filters) } },
      200,
    );
  });

  api.openapi(previewRoute, (c) => {
    const draft = c.req.valid("json");
    const profile = draft.profile ?? loadProfile(db);
    const filters = draft.filters ?? loadFilters(db);
    if (draft.filters) requirePlace(filters, profile);
    return c.json(offers.preview({ profile, filters }), 200);
  });

  api.openapi(getPreset, (c) => c.json(examplePreset(berlinMonth(clock())), 200));
};
