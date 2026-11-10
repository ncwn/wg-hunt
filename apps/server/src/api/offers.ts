import { createRoute, z } from "@hono/zod-openapi";
import {
  CATEGORIES,
  DEFAULT_SOURCE,
  findPlace,
  originSchema,
  PAGE_STATUSES,
  SCAM_SIGNAL_KINDS_ALL,
  SORTS,
  SOURCES,
  type Source,
} from "@wg-hunt/core";
import { RECHECK_RETRY_HOURS, RECHECK_STATES } from "../crawl/rechecks.js";
import { SOURCE_ADAPTERS } from "../crawl/sources.js";
import type { Db } from "../db/index.js";
import { KEEP_REASONS } from "../retention/clocks.js";
import { RECORD_DAYS, SNAPSHOT_DAYS } from "../retention/constants.js";
import { loadProfile } from "../seeking.js";
import { analysisStatusSchema } from "./analysis-status.js";
import type { ApiModule } from "./context.js";
import { cursorKey, DEFAULT_SORT, offerCursor } from "./offers-cursor.js";
import { pageSchema, paginationQuery } from "./pagination.js";
import { ProblemError, problemResponses } from "./problem.js";
import { bandSchema, rankingFields, visibilitySchema } from "./ranking-schemas.js";

const category = z.enum(CATEGORIES);
const pageStatus = z.enum(PAGE_STATUSES);
const analysisState = z.enum(["pending", "analyzed", "failed"]);
const money = z.object({ amount: z.number(), converted: z.boolean() });

const marksSchema = z
  .object({
    dismissed: z.boolean().openapi({
      description:
        '"Not for me": the Offer is Hidden (`hiddenBecause` is `dismissed`), and stays so when it is re-posted, because a Duplicate collapses into it.',
    }),
    shortlisted: z.boolean().openapi({ description: "Display only." }),
    contacted: z.boolean().openapi({ description: "Display only." }),
  })
  .openapi("OfferMarks");

const offerSummarySchema = z
  .object({
    id: z.number().int().openapi({ description: "wg-hunt's own id for the room." }),
    category,
    title: z.string(),
    url: z.string().openapi({
      description: "The Offer's most recently active Ad ID, as a page on the Source.",
    }),
    firstSeenAt: z.iso.datetime().openapi({
      description:
        "When wg-hunt first saw the room on a search card: the earliest of its Ad IDs. For display; it is not when the Offer appeared.",
    }),
    createdAt: z.iso.datetime().openapi({
      description:
        "When the Offer was made, after its detail page was fetched (possibly hours after `firstSeenAt`). `since` follows this (as it follows `bandChangedAt`); the list order does not: it is the band, then the chosen `sort`.",
    }),
    updatedAt: z.iso.datetime().openapi({
      description:
        "When anything wg-hunt stores about the Offer last changed: a page read (a Recheck's too), a card, a mark, a correction or an analysis.",
    }),
    lastBumpAt: z.iso.datetime().nullable().openapi({
      description:
        "When the most recently active Ad ID was last published or Bumped, as far as its card says. Null when no age was shown.",
    }),
    pageStatus: pageStatus.openapi({
      description: "`active` while any Ad ID's page is; `deleted` only when every Ad ID's page is.",
    }),
    stale: z.boolean().openapi({
      description:
        "Deactivated, deleted, or no Bump for more than 7 days (every Ad ID counted). Stale Offers are hidden from ranking.",
    }),
    tracked: z.boolean().openapi({
      description:
        "At least one enabled Search currently matches the Offer. An Offer that is not Tracked is hidden from ranking like a Stale one, but is not Stale: it may still be active on its Source. It is never polled, Swept or Rechecked, and becomes Tracked again when a Search finds it.",
    }),
    analysisState: analysisState.openapi({
      description:
        "What the stored model facts come from: `pending` until a model pass has read the free text, `analyzed` once it has, `failed` when its calls failed. `analysisStatus` says what happens next and why.",
    }),
    analysisStatus: analysisStatusSchema,
    ...rankingFields,
    visibility: visibilitySchema,
    marks: marksSchema,
    distance: z
      .object({
        place: z.string(),
        km: z.number().openapi({ description: "Straight-line kilometres, to two decimals." }),
        approximate: z.boolean().openapi({
          description:
            "True when the Offer gives no coordinates and the centre of its PLZ stood in for them.",
        }),
      })
      .nullable()
      .openapi({
        description:
          "Distance to the Place the list is sorted by (`sort=distance`); null in any other list, and when the Offer's location is not known.",
      }),
    keyFacts: z.object({
      warmRent: money.nullable().openapi({
        description:
          "Euros per month. `converted` marks a per-night or per-day price multiplied by 30.",
      }),
      size: z.number().nullable().openapi({
        description: "Square metres: the room for a flatshare, the whole home otherwise.",
      }),
      district: z.string().nullable(),
      availableFrom: z.string().nullable().openapi({ description: "An ISO date." }),
    }),
  })
  .openapi("OfferSummary");

const confidenceSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("confident") }),
  z.object({ status: z.literal("doubtful"), reasons: z.array(z.string()) }),
]);

const factSchema = z
  .object({
    value: z.unknown().openapi({
      description: "The fact's value, or the string `unknown` when the Offer does not say.",
    }),
    origin: originSchema,
    quote: z.string().openapi({
      description:
        "An exact piece of the Offer, or the field label plus its value, that the value was read from.",
    }),
    alternatives: z
      .array(z.object({ value: z.unknown(), origin: originSchema, quote: z.string() }))
      .optional(),
    confidence: confidenceSchema.optional().openapi({
      description:
        "Only model facts carry one: confident, or Doubtful with the reasons its checks failed.",
    }),
  })
  .openapi("OfferFact");

const modelChoice = z.object({ model: z.string(), effort: z.string().nullable() });

const analysisSchema = z
  .object({
    state: analysisState,
    model: z.string().nullable().openapi({
      description: "The model the last successful analysis ran with; null before one succeeded.",
    }),
    effort: z.string().nullable(),
    escalation: modelChoice.nullable().openapi({
      description: "The escalation setting at the time; null when escalation was off.",
    }),
    escalated: z.boolean().openapi({
      description: "A Doubtful fact made the whole Offer be read again at the escalation setting.",
    }),
    analyzedAt: z.iso.datetime().nullable(),
    analysisVersion: z.string().nullable().openapi({
      description:
        "The analysis version (a hash of the prompt, the output schema, the model and the effort) the stored result was read with; null before one succeeded. Compare it with `version` of `GET /analysis`.",
    }),
    olderVersion: z.boolean().openapi({
      description:
        "The stored result is on an older analysis version than the current settings would make. Nothing is re-read until a re-analysis run is started.",
    }),
    log: z
      .array(
        z.object({
          tier: z.number().int(),
          fact: z.string(),
          event: z.string(),
          value: z.string(),
          quote: z.string(),
          note: z.string().optional(),
        }),
      )
      .openapi({
        description:
          "What the checks noticed: a quote that was not found, a tiers disagreement and so on. Includes the attempts whose value was turned `unknown`.",
      }),
  })
  .openapi("OfferAnalysis");

const offerAdSchema = z
  .object({
    source: z.enum(SOURCES),
    adId: z.string(),
    url: z.string(),
    firstSeenAt: z.iso.datetime(),
    lastBumpAt: z.iso.datetime().nullable(),
    pageStatus,
    current: z.boolean().openapi({
      description:
        "The most recently active Ad ID: an active page before a deactivated one before a deleted one, then the latest Bump. The Offer's facts, link and Recheck follow it.",
    }),
    textHash: z.string().nullable().openapi({
      description:
        "A fingerprint of the Ad ID's own words. Ad IDs of one Offer with different hashes had their text edited between the posts.",
    }),
  })
  .openapi("OfferAd");

const textVersionSchema = z
  .object({
    source: z.enum(SOURCES),
    adId: z.string(),
    seenAt: z.iso.datetime().openapi({ description: "When wg-hunt first saw these words." }),
    hash: z.string().openapi({
      description:
        "The words' fingerprint: equal to the Ad ID's `textHash` while they are current.",
    }),
    title: z.string(),
    sections: z
      .array(z.object({ label: z.string(), text: z.string() }))
      .openapi({ description: "The free-text sections, in page order." }),
  })
  .openapi("TextVersion", {
    description:
      "The title and free-text sections of one Ad ID exactly as the Advertiser wrote them, never the translation.",
  });

const relatedOfferShape = {
  offer: offerSummarySchema,
  sharedImages: z
    .number()
    .int()
    .openapi({ description: "Photos both Offers show, by original file name (photo key)." }),
  textSimilarity: z.number().nullable().openapi({
    description:
      "0 (nothing alike) to 1 (the same words); null when either text was too short to compare.",
  }),
};

const relatedOfferSchema = z.object(relatedOfferShape).openapi("RelatedOffer");

const clonedOfferSchema = z
  .object({
    ...relatedOfferShape,
    role: z.enum(["original", "copy"]).openapi({
      description:
        "Which side this Offer is: the `copy` first appeared after the `original`. The two are never merged.",
    }),
  })
  .openapi("ClonedOffer");

const scamSignalSchema = z
  .object({
    kind: z.enum(SCAM_SIGNAL_KINDS_ALL),
    strength: z.enum(["strong", "soft"]).openapi({
      description:
        "A strong signal is enough for a Likely scam on its own; three soft ones are. A Doubtful reading is always soft.",
    }),
    origin: z.enum(["text", "derived"]).openapi({
      description:
        "`text`: the model read it in the Offer's words. `derived`: the rules worked it out from the facts and the other Offers.",
    }),
    message: z.string().openapi({ description: "A sentence for the seeker." }),
    quote: z.string().optional().openapi({
      description: "The Offer's own words (or field and value) behind the signal.",
    }),
    evidence: z.string().optional().openapi({
      description:
        'What a rule compared, such as the baseline: "district median €18.40/m² from 23 Offers".',
    }),
    doubtful: z.boolean().openapi({
      description: "The model's reading is Doubtful, so the signal counts as soft.",
    }),
  })
  .openapi("ScamSignal");

const scamSchema = z
  .object({
    likelyScam: z.boolean().openapi({
      description:
        "The verdict ranking uses: the seeker's mark when there is one, else the computed verdict. A Likely scam is in the Warned band.",
    }),
    computedLikelyScam: z.boolean().openapi({
      description: "What the signals alone say: one strong or three soft signals.",
    }),
    mark: z.enum(["scam", "not"]).nullable().openapi({
      description: "The seeker's override: `scam`, `not` (not a scam), or null.",
    }),
    signals: z.array(scamSignalSchema).openapi({
      description: "Every signal found, strong first: the reasons behind the verdict.",
    }),
    cautions: z.array(scamSignalSchema).openapi({
      description:
        "The soft signals shown as caution chips: below the threshold and not overridden by a mark.",
    }),
    strong: z.number().int(),
    soft: z.number().int(),
    summary: z.string().openapi({ description: "One sentence on how the verdict came about." }),
  })
  .openapi("ScamVerdict");

const offerRecheckSchema = z
  .object({
    state: z.enum(RECHECK_STATES).openapi({
      description: `\`queued\`: a Recheck is due and waits its turn. A pressed or automatic one goes last; the re-read of a Stale Ad ID that shows up on a search card again goes where a new Offer's page does. A pressed one or such a re-read that a Bot check dropped is put back and stays \`queued\`. \`in-flight\`: its request is out. \`failed\`: the last Recheck brought no usable page (no answer, an error, a page the rules could not read); automatic Rechecks and a returning Stale Ad ID's re-read wait until \`retryAfter\`. \`idle\`: none of these. A returning Stale Ad ID's re-read also waits ${RECHECK_RETRY_HOURS} hours after a Recheck that read the page fine, and shows \`idle\` meanwhile, with nothing else on the Offer saying it waits, until it is due and turns \`queued\`. A press is \`queued\` at once, during either wait too. A Recheck has finished when the state leaves \`queued\` and \`in-flight\`; \`pageFetchedAt\` then moved if it got a page.`,
    }),
    manual: z.boolean().openapi({
      description: "The queued or in-flight Recheck was asked for with the Recheck button.",
    }),
    pageFetchedAt: z.iso.datetime().nullable().openapi({
      description: "When the page was last fetched, by a Recheck or otherwise.",
    }),
    lastFailedAt: z.iso.datetime().nullable().openapi({
      description:
        "When the last Recheck that brought no usable page was answered; null once a fetched page was stored.",
    }),
    retryAfter: z.iso.datetime().nullable().openapi({
      description: "While `failed`: when an automatic Recheck may try the page again.",
    }),
  })
  .openapi("OfferRecheck");
const retentionSchema = z
  .object({
    state: z.enum(["not-quiet", "expiring", "kept"]).openapi({
      description: `\`not-quiet\`: neither Stale nor Untracked, so no clock runs. \`expiring\`: quiet, and the record is deleted ${RECORD_DAYS} days after it went quiet. \`kept\`: quiet, but \`keptBecause\` keeps the record; the snapshots still age.`,
    }),
    keptBecause: z.array(z.enum(KEEP_REASONS)).openapi({
      description:
        "What keeps the record from being pruned, in this order: the marks `dismissed`, `shortlisted`, `contacted`, a `scam-mark` (scam or not a scam), a manual `fact-override`, and `pair-override`: a same-room or not-the-same-room verdict on one of its Ad IDs. Clear the mark or override to let the record expire; release a `pair-override` with `POST /offers/{id}/retention/release`. Named even while the Offer is not quiet.",
    }),
    recordExpiresAt: z.iso.datetime().nullable().openapi({
      description:
        "When the record (facts, Ad IDs, history, links) falls due: the nightly prune at 03:00 Berlin after it deletes it. Null while it is not quiet or something keeps it. A clock not yet started counts from the next prune, which starts it.",
    }),
    snapshotExpiresAt: z.iso
      .datetime()
      .nullable()
      .openapi({
        description: `When the raw snapshots of its Ad IDs' pages fall due, ${SNAPSHOT_DAYS} days after it went quiet, marks or not. Null while it is not quiet.`,
      }),
  })
  .openapi("OfferRetention");

const correctionPageSchemas = {
  madeOn: z
    .object({
      source: z.enum(SOURCES),
      adId: z.string(),
      textHash: z.string().nullable().openapi({
        description:
          "The fingerprint of the words that page showed, as in an Ad ID's `textHash`. Null when they were not known.",
      }),
    })
    .nullable()
    .openapi({
      description:
        "The Ad ID whose page was current when the correction was made. It can be one that is no longer the current one, or no longer the Offer's. Null for a correction made before this was recorded.",
    }),
  wordsChanged: z.boolean().nullable().openapi({
    description:
      "Whether the current Ad ID's words differ from those the correction was made on. Words alike on another Ad ID read `false`. Null when either is not known. Correcting the fact again makes it `false`.",
  }),
};

const offerDetailSchema = offerSummarySchema
  .extend({
    ads: z.array(offerAdSchema).openapi({
      description: "Every `(Source, Ad ID)` pair the Offer is known under, oldest first.",
    }),
    advertiser: z.object({
      name: z.string().nullable(),
      avatarUrl: z.string().nullable(),
      kind: z.enum(["private", "pro", "company"]).nullable(),
    }),
    photos: z.array(z.string()).openapi({
      description:
        "Addresses of the photos on the Source. The browser loads them directly; wg-hunt never downloads an image.",
    }),
    facts: z.record(z.string(), z.union([factSchema, z.array(factSchema)])).openapi({
      description:
        "The Offer Facts by name: the rule-parsed ones with the model's beside them once it has read the text. `requirements`, `scamSignals` and `conflicts` are lists of facts. Facts that do not apply to the Offer's category are left out. A model fact carries `confidence`: confident, or Doubtful with its reasons.",
    }),
    analysis: analysisSchema,
    priceHistory: z
      .array(
        z.object({
          observedAt: z.iso.datetime(),
          source: z.enum(SOURCES),
          adId: z.string(),
          warmRent: z.number(),
          converted: z.boolean(),
        }),
      )
      .openapi({ description: "Warm rent over time, oldest first; a point only when it changed." }),
    textHistory: z.array(textVersionSchema).openapi({
      description:
        "Every Text version of the Offer's Ad IDs, oldest first. A version is kept whenever an Ad ID's page shows words it has not shown before, including an edit a Recheck finds. Ad IDs stored before text history existed start theirs at their next read.",
    }),
    rulesVersion: z.number().int(),
    siblings: z.array(relatedOfferSchema).openapi({
      description:
        'Other rooms of the same flat by the same Advertiser: linked as "same flat", never merged.',
    }),
    cloned: z.array(clonedOfferSchema).openapi({
      description:
        "Offers of other Advertisers that reuse this one's photos or text, or that it reuses.",
    }),
    scam: scamSchema.openapi({
      description:
        "The Scam signals with their quotes or evidence, and the verdict. Derived signals are worked out on every read.",
    }),
    overrides: z.array(z.string()).openapi({
      description:
        "The names of the facts the seeker corrected by hand: each shows in `facts` with origin `manual`. A list fact corrected to an empty list has no fact left to show, so it is named here.",
    }),
    corrections: z
      .array(z.object({ key: z.string(), createdAt: z.iso.datetime(), ...correctionPageSchemas }))
      .openapi({
        description:
          "The same corrections as `overrides`, by name, with when each was made and on which page.",
      }),
    recheck: offerRecheckSchema.openapi({
      description:
        "Where a Recheck of the current Ad ID's page stands: the page `POST /offers/{id}/recheck` asks for. Poll this after asking to see when it finished.",
    }),
    retention: retentionSchema.openapi({
      description:
        "What the nightly prune will do with the Offer: what keeps its record, and when the record and the snapshots fall due.",
    }),
  })
  .openapi("Offer");

const tags = ["Offers"];

const listQuery = paginationQuery.extend({
  cursor: z.string().optional().openapi({
    description:
      "The `nextCursor` of the previous page. It continues the list it came from: with another `sort`, or a distance sort to another Place, it is refused as `invalid-cursor`.",
  }),
  since: z.iso.datetime({ offset: true }).optional().openapi({
    description:
      "Only Offers that are new or entered their current band after this time (`createdAt` or `bandChangedAt`): what's new since a client last looked.",
  }),
  category: category.optional(),
  band: bandSchema.optional().openapi({
    description:
      "Only this band. Without it the list holds Match, Near match and Warned; Hidden Offers are listed only with `band=hidden` or `includeHidden=true`.",
  }),
  sort: z.enum(SORTS).default(DEFAULT_SORT).openapi({
    description:
      "The order inside each band. `recency` (the default) is the last Bump, else first seen, and a Near match puts its fewest misses before that. The others put Offers that lack the fact last. `distance` puts the nearest to a Place first (see `place`) and fills in each Offer's `distance`.",
  }),
  place: z.string().min(1).optional().openapi({
    description:
      "With `sort=distance`: the name of a Place of the Seeker Profile, whatever its case. The first Place when left out. Ignored for any other sort.",
  }),
  includeHidden: z.enum(["true", "false"]).default("false").openapi({
    description: "Also list the Hidden band after the others.",
  }),
  shortlisted: z.enum(["true", "false"]).default("false").openapi({
    description:
      "Only the Offers the seeker shortlisted, from every band, Hidden too (or only `band`'s when it is given): the shortlist in one read.",
  }),
});

const listRoute = createRoute({
  method: "get",
  path: "/offers",
  tags,
  summary: "List the ranked Offers, band by band",
  description:
    "Offers come in band order (Match, Near match, Warned, Hidden), each with its reasons, and inside a band in the chosen `sort`. Each Offer is in the band it was last ranked into: saving the Profile or Filters, a stored page, a mark or a fact correction re-band at once, and every Offer is ranked again every few minutes and after each Sweep, so a move that only time causes (such as going Stale) shows then. A read records a move that only time caused and announces it with `offer-band-changed`; it changes nothing else.",
  request: { query: listQuery },
  responses: {
    200: {
      description: "A page of Offers",
      content: { "application/json": { schema: pageSchema("OfferPage", offerSummarySchema) } },
    },
    ...problemResponses("unauthorized", "validation-error", "invalid-cursor"),
  },
});

const countsQuery = z.object({
  since: z.iso.datetime({ offset: true }).optional().openapi({
    description:
      "Counts as `new` the Offers that are new or entered their current band after this time, as `since` does on the list. Without it every Offer that is not Hidden is new.",
  }),
});

const countsRoute = createRoute({
  method: "get",
  path: "/offers/counts",
  tags,
  summary: "How many Offers each band holds, and how many are new",
  description:
    "The numbers the nav rail shows. `bands` counts what `GET /offers?band=` lists for each band (Stale, Untracked and Dismissed Offers are in Hidden); `new` counts the Offers that are not Hidden and are new since `since`.",
  request: { query: countsQuery },
  responses: {
    200: {
      description: "The counts",
      content: {
        "application/json": {
          schema: z
            .object({
              bands: z.object({
                match: z.number().int(),
                "near-match": z.number().int(),
                warned: z.number().int(),
                hidden: z.number().int(),
              }),
              new: z.number().int(),
            })
            .openapi("OfferCounts"),
        },
      },
    },
    ...problemResponses("unauthorized", "validation-error"),
  },
});
function sortPlace(db: Db, place: string | undefined): string {
  const { places } = loadProfile(db);
  const chosen = place === undefined ? places[0] : findPlace(places, place);
  if (chosen === undefined) {
    const message =
      place === undefined
        ? "Add a Place to the Seeker Profile to sort by distance"
        : "The Seeker Profile has no Place with this name";
    throw new ProblemError("validation-error", "There is no Place to sort by distance to.", [
      { path: "place", message },
    ]);
  }
  return chosen.name;
}

const lookupQuery = z.object({
  url: z.string().optional().openapi({
    description: "The address of an Offer page on a Source, as pasted from a browser.",
  }),
  source: z
    .enum(SOURCES)
    .optional()
    .openapi({
      description: `With \`adId\`: the Source the Ad ID belongs to. Defaults to \`${DEFAULT_SOURCE}\`.`,
    }),
  adId: z.string().optional().openapi({ description: "A bare Ad ID, as the Source numbers it." }),
});

const lookupRoute = createRoute({
  method: "get",
  path: "/offers/lookup",
  tags,
  summary: "Find the Offer known under a pasted URL or an Ad ID",
  description:
    "Give either `url` or `adId` (with `source` when it is not wg-gesucht). An Ad ID wg-hunt has never stored as an Offer answers `not-known`.",
  request: { query: lookupQuery },
  responses: {
    200: {
      description: "The Offer, as `GET /offers/{id}` returns it",
      content: { "application/json": { schema: offerDetailSchema } },
    },
    ...problemResponses("unauthorized", "validation-error", "not-known"),
  },
});

const idParam = z.object({
  id: z.coerce
    .number()
    .int()
    .min(1)
    .openapi({ param: { name: "id", in: "path" }, example: 1 }),
});

const getRoute = createRoute({
  method: "get",
  path: "/offers/{id}",
  tags,
  summary: "Read one Offer with its facts, Ad IDs and photo addresses",
  request: { params: idParam },
  responses: {
    200: {
      description: "The Offer",
      content: { "application/json": { schema: offerDetailSchema } },
    },
    ...problemResponses("unauthorized", "validation-error", "not-found", "offer-merged"),
  },
});

const marksRoute = createRoute({
  method: "patch",
  path: "/offers/{id}/marks",
  tags,
  summary: "Mark an Offer: dismissed, shortlisted, contacted, or a scam or not",
  description:
    "Send only the marks to change; the others stay as they are. At least one is needed. `dismissed` hides the Offer at once and it stays hidden through re-posts; `shortlisted` and `contacted` are for display. `scam` makes the Offer a Likely scam (Warned) whatever its signals say; `not` makes it not one even with strong signals; `clear` takes the scam mark away so the computed verdict stands again. The Offer is ranked again at once.",
  request: {
    params: idParam,
    body: {
      content: {
        "application/json": {
          schema: marksSchema
            .partial()
            .extend({
              scam: z.enum(["scam", "not", "clear"]).optional().openapi({
                description:
                  "The seeker's override of the Likely scam verdict; `clear` takes it away.",
              }),
            })
            .refine((marks) => Object.keys(marks).length > 0, "Give at least one mark to change")
            .openapi("OfferMarksChange"),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: "The Offer, with its marks and the band they put it in",
      content: { "application/json": { schema: offerDetailSchema } },
    },
    ...problemResponses(
      "unauthorized",
      "validation-error",
      "invalid-body",
      "not-found",
      "offer-merged",
      "origin-not-allowed",
    ),
  },
});

const factParam = idParam.extend({
  fact: z
    .string()
    .min(1)
    .openapi({
      param: { name: "fact", in: "path" },
      example: "anmeldung",
      description:
        "The fact's name, as in `facts`: `anmeldung`, `warmRent`, `genderSought`, `requirements` and so on. Not `conflicts` or `imageUrls`.",
    }),
});

const overrideRoute = createRoute({
  method: "put",
  path: "/offers/{id}/facts/{fact}",
  tags,
  summary: "Correct a fact by hand",
  description:
    'Sets the fact\'s value with origin `manual`. It wins over the rules\' and the model\'s reading, is never Doubtful, survives a re-analysis, a Recheck and a re-parse, and the Offer is ranked again at once. The reading it replaced stays in the fact\'s `alternatives`. `value` is the fact\'s value as `facts` shows it: `"possible"` for `anmeldung`, `{"amount": 550, "converted": false}` for a rent, `["woman"]` for `genderSought`, `"unknown"` to say the Offer does not say. A list fact (`requirements`, `scamSignals`) takes the list of its items\' values, which may be empty.',
  request: {
    params: factParam,
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              value: z.unknown().openapi({
                description: "The corrected value; its shape depends on the fact.",
              }),
            })
            .refine((body) => body.value !== undefined, {
              message: "Give the value",
              path: ["value"],
            })
            .openapi("FactOverride"),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: "The Offer, with the fact corrected and the band it is now in",
      content: { "application/json": { schema: offerDetailSchema } },
    },
    ...problemResponses(
      "unauthorized",
      "validation-error",
      "invalid-body",
      "not-found",
      "offer-merged",
      "origin-not-allowed",
    ),
  },
});

const revertRoute = createRoute({
  method: "delete",
  path: "/offers/{id}/facts/{fact}",
  tags,
  summary: "Take a manual correction away",
  description:
    "The rules' or the model's value is the fact's again, and the Offer is ranked again at once. A fact with no correction is left as it is.",
  request: { params: factParam },
  responses: {
    200: {
      description: "The Offer as it is now",
      content: { "application/json": { schema: offerDetailSchema } },
    },
    ...problemResponses(
      "unauthorized",
      "validation-error",
      "not-found",
      "offer-merged",
      "origin-not-allowed",
    ),
  },
});

const overridesListRoute = createRoute({
  method: "get",
  path: "/offers/overrides",
  tags,
  summary: "Every manual fact correction, as evaluation labels",
  description:
    "Each correction with the Offer's current Source and Ad ID (`source`, `adId`), the page it was made on (`madeOn`), and how many Ad IDs the Offer has. This is the shape `pnpm eval export-overrides <file>` reads: save the `items` there to turn your corrections into labels of the local evaluation set. The export labels the page in `madeOn`; for a correction whose `madeOn` is null it labels the current page only when the Offer has one Ad ID.",
  responses: {
    200: {
      description: "The corrections",
      content: {
        "application/json": {
          schema: z
            .object({
              items: z.array(
                z.object({
                  offerId: z.number().int(),
                  source: z.enum(SOURCES),
                  adId: z.string(),
                  key: z.string(),
                  value: z.unknown(),
                  createdAt: z.iso.datetime(),
                  ...correctionPageSchemas,
                  adCount: z.number().int().openapi({ description: "The Offer's Ad IDs." }),
                }),
              ),
            })
            .openapi("FactOverrideList"),
        },
      },
    },
    ...problemResponses("unauthorized"),
  },
});

const recheckSchema = z
  .object({
    queued: z.literal(true),
    alreadyQueued: z.boolean().openapi({
      description: "A Recheck of this Offer was already waiting; no second one was queued.",
    }),
    message: z.string().openapi({
      example: "Queued. Rechecks go last: this one runs when nothing else is waiting.",
    }),
  })
  .openapi("RecheckQueued");

const recheckRoute = createRoute({
  method: "post",
  path: "/offers/{id}/recheck",
  tags,
  summary: "Queue one Recheck of the Offer's page",
  description:
    "Fetches the page of the Offer's most recently active Ad ID again, to catch edits or deactivation. It is queued at the lowest priority and keeps to the pacing and the caps. It runs even when automatic Rechecks are switched off. Only a Tracked Ad ID is crawled: when the current one is not, it is refused with `offer-untracked`, as `visibility.actions.recheck` says beforehand.",
  request: { params: idParam },
  responses: {
    202: {
      description: "The Recheck is queued",
      content: { "application/json": { schema: recheckSchema } },
    },
    ...problemResponses(
      "unauthorized",
      "validation-error",
      "not-found",
      "offer-merged",
      "offer-untracked",
      "origin-not-allowed",
    ),
  },
});

const mergeRoute = createRoute({
  method: "post",
  path: "/offers/{id}/merge",
  tags,
  summary: "Say another Offer is the same room as this one",
  description:
    "Every Ad ID of `offerId` joins this Offer, which keeps its id; the other Offer is gone. The verdict is kept: later dedupe passes never split the two apart. A 404 is about the first of the two ids that has no Offer, the one in the address before `offerId`, and its `detail` names it: `offer-merged` when a merge absorbed that Offer, else `not-found`. An `offer-merged` whose `mergedInto` is this Offer's id says the two are one room already.",
  request: {
    params: idParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            offerId: z
              .number()
              .int()
              .min(1)
              .openapi({ description: "The Offer to fold into this one." }),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: "The merged Offer",
      content: { "application/json": { schema: offerDetailSchema } },
    },
    ...problemResponses(
      "unauthorized",
      "validation-error",
      "invalid-body",
      "not-found",
      "offer-merged",
      "origin-not-allowed",
    ),
  },
});

const splitRoute = createRoute({
  method: "post",
  path: "/offers/{id}/split",
  tags,
  summary: "Say an Ad ID is not the same room as the rest of this Offer",
  description:
    "The Ad ID becomes an Offer of its own, with its price points. The verdict is kept: later dedupe passes never join it to this Offer again.",
  request: {
    params: idParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            adId: z.string().min(1).openapi({ description: "The Ad ID to take out of the Offer." }),
            source: z
              .enum(SOURCES)
              .optional()
              .openapi({
                description: `The Ad ID's Source. Defaults to \`${DEFAULT_SOURCE}\`.`,
              }),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    201: {
      description: "The new Offer made of the Ad ID",
      content: { "application/json": { schema: offerDetailSchema } },
    },
    ...problemResponses(
      "unauthorized",
      "validation-error",
      "invalid-body",
      "not-found",
      "offer-merged",
      "offer-has-one-ad",
      "origin-not-allowed",
    ),
  },
});

const releaseRoute = createRoute({
  method: "post",
  path: "/offers/{id}/retention/release",
  tags,
  summary: "Let the record expire despite its merge and split verdicts",
  description:
    "Same-room and not-the-same-room verdicts keep an Offer's record (`retention.keptBecause` has `pair-override`). This releases that pin for the verdicts given so far: the record ages like any other quiet Offer's, unless a mark or fact override keeps it. The verdicts stay, so the merge or split is not undone, and the other Offer of a split keeps its own pin. A verdict given later pins the record again. Releasing an Offer with no such pin changes nothing.",
  request: { params: idParam },
  responses: {
    200: {
      description: "The Offer, with its `retention` as it stands now",
      content: { "application/json": { schema: offerDetailSchema } },
    },
    ...problemResponses(
      "unauthorized",
      "validation-error",
      "not-found",
      "offer-merged",
      "origin-not-allowed",
    ),
  },
});

const reanalyzeRoute = createRoute({
  method: "post",
  path: "/offers/{id}/reanalyze",
  tags,
  summary: "Run the model pass on one Offer again",
  description:
    "Queues the model pass for the Offer, whatever its state. Its previous result stays current until the new one succeeds. Progress arrives as `analysis-progress` events. Refused with `api-key-refused` while the API refuses the key that is set (`key: refused` on `GET /analysis`), and with `analysis-in-batch` while the Offer's request waits for, or is inside, a batch: that request is already paid for, and its result arrives when the batch ends. When what is left of the spend cap pays for the Offer's call as a batch and not in realtime, the click is sent as a batch: the Offer reads `in-batch`, and its result arrives when the batch ends. A click the spend cap stops after the `202` is kept, reads `waiting-for-cap`, and is read once there is room.",
  request: { params: idParam },
  responses: {
    202: {
      description: "The analysis is queued",
      content: {
        "application/json": {
          schema: z
            .object({ offerId: z.number().int(), queued: z.literal(true) })
            .openapi("ReanalyzeAccepted"),
        },
      },
    },
    ...problemResponses(
      "unauthorized",
      "validation-error",
      "not-found",
      "offer-merged",
      "no-api-key",
      "api-key-refused",
      "analysis-in-batch",
      "spend-cap-reached",
      "origin-not-allowed",
    ),
  },
});

function lookupTarget(query: z.infer<typeof lookupQuery>): { source: Source; adId: string } {
  const { url, source, adId } = query;
  if ((url === undefined) === (adId === undefined)) {
    throw new ProblemError("validation-error", "Give either url or adId.", [
      { path: "", message: "Give either url or adId" },
    ]);
  }
  if (url !== undefined) {
    if (source !== undefined) {
      throw new ProblemError("validation-error", "source goes with adId, not with url.", [
        { path: "source", message: "source goes with adId, not with url" },
      ]);
    }
    for (const adapter of Object.values(SOURCE_ADAPTERS)) {
      const found = adapter.adIdFromUrl(url);
      if (found !== null) return { source: adapter.id, adId: found };
    }
    throw new ProblemError("validation-error", "That is not the address of an Offer page.", [
      { path: "url", message: "This is not the address of an Offer on a Source wg-hunt crawls" },
    ]);
  }
  const bare = (adId ?? "").trim();
  if (!/^\d{1,20}$/.test(bare)) {
    throw new ProblemError("validation-error", "An Ad ID is a number.", [
      { path: "adId", message: "An Ad ID is a number, such as 1234567" },
    ]);
  }
  return { source: source ?? DEFAULT_SOURCE, adId: bare };
}

export const registerOffers: ApiModule = (api, { db, offers, analysis, rechecks }) => {
  const noOffer = (id: number): ProblemError => {
    const into = offers.mergedInto(id);
    return into === undefined
      ? new ProblemError("not-found", `There is no Offer with id ${id}.`)
      : new ProblemError(
          "offer-merged",
          `Offer ${id} was merged into Offer ${into}: read that one.`,
          undefined,
          { mergedInto: into },
        );
  };

  api.openapi(listRoute, (c) => {
    const { cursor, limit, since, category, band, sort, place, includeHidden, shortlisted } =
      c.req.valid("query");
    const order = { sort, place: sort === "distance" ? sortPlace(db, place) : null };
    const { items, nextKey } = offers.list({
      since: since === undefined ? undefined : new Date(since),
      category,
      band,
      includeHidden: includeHidden === "true",
      shortlisted: shortlisted === "true",
      sort,
      place: order.place ?? undefined,
      after: cursorKey(cursor, order),
      limit,
    });
    return c.json(
      { items, nextCursor: nextKey === null ? null : offerCursor(nextKey, order) },
      200,
    );
  });

  // Registered before `/offers/{id}`, which would otherwise take "counts", "overrides" and
  // "lookup" for an id.
  api.openapi(countsRoute, (c) => {
    const { since } = c.req.valid("query");
    return c.json(offers.counts(since === undefined ? undefined : new Date(since)), 200);
  });

  api.openapi(overridesListRoute, (c) => c.json({ items: offers.listFactOverrides() }, 200));

  api.openapi(lookupRoute, (c) => {
    const { source, adId } = lookupTarget(c.req.valid("query"));
    const offer = offers.findByAd(source, adId);
    if (offer === undefined) {
      throw new ProblemError("not-known", `wg-hunt has no Offer for Ad ID ${adId} on ${source}.`);
    }
    return c.json(offer, 200);
  });

  api.openapi(getRoute, (c) => {
    const { id } = c.req.valid("param");
    const offer = offers.get(id);
    if (offer === undefined) throw noOffer(id);
    return c.json(offer, 200);
  });

  api.openapi(marksRoute, (c) => {
    const { id } = c.req.valid("param");
    const offer = offers.setMarks(id, c.req.valid("json"));
    if (offer === undefined) {
      throw noOffer(id);
    }
    return c.json(offer, 200);
  });

  api.openapi(overrideRoute, (c) => {
    const { id, fact } = c.req.valid("param");
    const { value } = c.req.valid("json");
    const result = offers.setFactOverride(id, fact, value);
    if (result.ok) return c.json(result.offer, 200);
    if (result.problem === "not-found") {
      throw noOffer(id);
    }
    throw new ProblemError("validation-error", "That value can't be set for this fact.", [
      { path: "value", message: result.problem.invalid },
    ]);
  });

  api.openapi(revertRoute, (c) => {
    const { id, fact } = c.req.valid("param");
    const result = offers.clearFactOverride(id, fact);
    if (!result.ok) throw noOffer(id);
    return c.json(result.offer, 200);
  });

  api.openapi(recheckRoute, (c) => {
    const { id } = c.req.valid("param");
    const offer = offers.get(id);
    if (offer === undefined) throw noOffer(id);
    if (!offer.visibility.actions.recheck) {
      throw new ProblemError(
        "offer-untracked",
        offer.tracked
          ? "No enabled Search lists this Offer's current ad, so wg-hunt doesn't crawl it. It is checked again when a Search finds it."
          : "No enabled Search matches this Offer, so wg-hunt doesn't crawl it. It is checked again when a Search finds it.",
      );
    }
    const ad = offer.ads.find((each) => each.current);
    if (ad === undefined) throw new Error("an Offer always has a current Ad ID");
    const { alreadyQueued } = rechecks.request(ad.source, ad.adId);
    return c.json(
      {
        queued: true as const,
        alreadyQueued,
        message: "Queued. Rechecks go last: this one runs when nothing else is waiting.",
      },
      202,
    );
  });

  api.openapi(mergeRoute, (c) => {
    const { id } = c.req.valid("param");
    const { offerId } = c.req.valid("json");
    const result = offers.mergeOffers(id, offerId);
    if (result.ok) return c.json(result.offer, 200);
    if (result.problem === "same-offer") {
      throw new ProblemError("validation-error", "An Offer is already the same room as itself.", [
        { path: "offerId", message: "Give a different Offer than the one in the address" },
      ]);
    }
    throw noOffer(result.missing);
  });

  api.openapi(splitRoute, (c) => {
    const { id } = c.req.valid("param");
    const { adId, source } = c.req.valid("json");
    const result = offers.splitOffer(id, source ?? DEFAULT_SOURCE, adId);
    if (result.ok) return c.json(result.offer, 201);
    if (result.problem === "only-ad") {
      throw new ProblemError(
        "offer-has-one-ad",
        `Offer ${id} has only one Ad ID, so there is nothing to take it away from.`,
      );
    }
    if (result.problem === "not-found") throw noOffer(id);
    throw new ProblemError("not-found", `Offer ${id} is not known under Ad ID ${adId}.`);
  });

  api.openapi(releaseRoute, (c) => {
    const { id } = c.req.valid("param");
    const offer = offers.releasePairPins(id);
    if (offer === undefined) throw noOffer(id);
    return c.json(offer, 200);
  });

  // A record, so an outcome added to `reanalyze` fails to compile here until it has an answer.
  const reanalyzeRefusals: Record<
    Exclude<ReturnType<typeof analysis.reanalyze>, "queued">,
    (id: number) => ProblemError
  > = {
    "not-found": noOffer,
    "no-key": () =>
      new ProblemError(
        "no-api-key",
        "Set an Anthropic API key in Settings first. The model pass needs one.",
      ),
    "key-refused": () =>
      new ProblemError(
        "api-key-refused",
        "The Anthropic API refused the key that is set, so the model pass would fail. Replace the key in Settings.",
      ),
    "in-batch": () =>
      new ProblemError(
        "analysis-in-batch",
        "This Offer is already being read in a batch. Its result arrives when the batch ends; reading it again now would be billed twice.",
      ),
    "spend-cap-reached": () =>
      new ProblemError(
        "spend-cap-reached",
        "The spend cap has no room for this call now (see `spend` on GET /analysis). Raise the cap in Settings, or wait for the analysis in flight to settle or for the next month.",
      ),
  };

  api.openapi(reanalyzeRoute, (c) => {
    const { id } = c.req.valid("param");
    const outcome = analysis.reanalyze(id);
    if (outcome !== "queued") throw reanalyzeRefusals[outcome](id);
    return c.json({ offerId: id, queued: true as const }, 202);
  });
};
