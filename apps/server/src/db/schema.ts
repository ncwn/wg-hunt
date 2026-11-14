import type { Band, Category, PageStatus, RentType, Source } from "@wg-hunt/core";
import {
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { RunStatus, RunStopReason } from "../analysis/run-status.js";
import type { BotCheckMarker } from "../crawl/bot-check.js";
import type { JobKind } from "../crawl/constants.js";
import type { DetailState } from "../crawl/detail-fetch.js";
import type { RequestOutcome } from "../crawl/request-log.js";

export const settings = sqliteTable("settings", {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedAt: integer({ mode: "timestamp_ms" }).notNull(),
});

export const searches = sqliteTable("searches", {
  id: integer().primaryKey({ autoIncrement: true }),
  source: text().$type<Source>().notNull(),
  city: text().notNull(),
  /** Null when the Source's adapter knows the city by name. */
  cityId: text(),
  categories: text({ mode: "json" }).$type<Category[]>().notNull(),
  rentTypes: text({ mode: "json" }).$type<RentType[]>().notNull(),
  /** Warm rent per month in euros; null means no ceiling. */
  priceCeiling: integer(),
  recencyDays: integer().notNull(),
  enabled: integer({ mode: "boolean" }).notNull(),
  pollMinMinutes: integer().notNull(),
  pollMaxMinutes: integer().notNull(),
  createdAt: integer({ mode: "timestamp_ms" }).notNull(),
  updatedAt: integer({ mode: "timestamp_ms" }).notNull(),
});

export type SearchRow = typeof searches.$inferSelect;

/** An Ad ID is fetched once, whichever Search saw it first. */
export const seenAds = sqliteTable(
  "seen_ads",
  {
    source: text().$type<Source>().notNull(),
    adId: text().notNull(),
    firstSeenAt: integer({ mode: "timestamp_ms" }).notNull(),
    lastSeenAt: integer({ mode: "timestamp_ms" }).notNull(),
    category: text().$type<Category>().notNull(),
    /** The card's "Online" age is rounded down to a unit; null when the card showed none. */
    onlineEarliest: integer({ mode: "timestamp_ms" }),
    onlineLatest: integer({ mode: "timestamp_ms" }),
    card: text().notNull(),
    detailState: text().$type<DetailState>().notNull(),
    /** Failed detail fetches since the fetch was last queued from a card; a success leaves it. */
    detailAttempts: integer().notNull().default(0),
    detailFetchedAt: integer({ mode: "timestamp_ms" }),
    /** An Offer removed later (merged or pruned) does not come back from it. */
    ingestedAt: integer({ mode: "timestamp_ms" }),
  },
  (t) => [primaryKey({ columns: [t.source, t.adId] })],
);

export type SeenAdRow = typeof seenAds.$inferSelect;

/** An Offer is Tracked while any of its Ad IDs has a row here. */
export const searchMatches = sqliteTable(
  "search_matches",
  {
    searchId: integer()
      .notNull()
      .references(() => searches.id, { onDelete: "cascade" }),
    source: text().$type<Source>().notNull(),
    adId: text().notNull(),
    lastSeenAt: integer({ mode: "timestamp_ms" }).notNull(),
    /** When a finished Sweep did not see the Ad ID and a Stale confirmation was queued for it. */
    missingAt: integer({ mode: "timestamp_ms" }),
  },
  (t) => [
    primaryKey({ columns: [t.searchId, t.source, t.adId] }),
    index("search_matches_ad").on(t.source, t.adId),
  ],
);

export const searchSweeps = sqliteTable("search_sweeps", {
  searchId: integer()
    .primaryKey()
    .references(() => searches.id, { onDelete: "cascade" }),
  /** What the Search matches on, and whether it is enabled. */
  specKey: text().notNull(),
  /** Raised whenever the Sweep starts over, so a job of an earlier Sweep can be told apart. */
  generation: integer().notNull(),
  /**
   * `idle`: the Search is disabled or not readable. Read and written only through
   * `crawl/sweep-state.ts`, which refuses the combinations that can't happen.
   */
  status: text().$type<"idle" | "scheduled" | "running">().notNull(),
  /** Null while idle. */
  mode: text().$type<"backfill" | "daily">(),
  /** Set only while scheduled. */
  startAt: integer({ mode: "timestamp_ms" }),
  /** Cards last seen before this are what the Sweep did not see. */
  startedAt: integer({ mode: "timestamp_ms" }),
  /** For each category, the next page to read; null once its results ended. Set only while running. */
  cursors: text({ mode: "json" }).$type<Partial<Record<Category, number | null>>>(),
  /** Organic cards read so far; a Sweep that saw none is not trusted to judge anything. */
  cardCount: integer().notNull().default(0),
  pagesRead: integer().notNull().default(0),
  /** Shown only; it decides nothing. */
  finishedAt: integer({ mode: "timestamp_ms" }),
});

export type SearchSweepRow = typeof searchSweeps.$inferSelect;

/** A job stays here while it is in flight, so a restart keeps it. */
export const crawlJobs = sqliteTable(
  "crawl_jobs",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    kind: text().notNull(),
    /** Lower is served first: its kind's own, unless the job was queued in another kind's place. */
    priority: integer().notNull(),
    /** A path on the Source, never a full URL. */
    path: text().notNull(),
    /** JSON for the feature that queued the job; the engine never reads it. */
    payload: text(),
    dueAt: integer({ mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("crawl_jobs_kind_path").on(t.kind, t.path),
    index("crawl_jobs_order").on(t.priority, t.dueAt, t.id),
  ],
);

export const crawlRequests = sqliteTable(
  "crawl_requests",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    at: integer({ mode: "timestamp_ms" }).notNull(),
    kind: text().$type<JobKind>().notNull(),
    /** Path and allow-listed query only; see `loggedPath`. */
    path: text().notNull(),
    status: integer(),
    outcome: text().$type<RequestOutcome>().notNull(),
    marker: text().$type<BotCheckMarker>(),
  },
  (t) => [index("crawl_requests_at").on(t.at)],
);

/** Its facts are the rule-parsed ones of its most recently active Ad ID's page (see `offerAds`). */
export const offers = sqliteTable("offers", {
  id: integer().primaryKey({ autoIncrement: true }),
  category: text().$type<Category>().notNull(),
  title: text().notNull(),
  /** `RuleFacts` as JSON. Local database only: they hold the location. */
  facts: text().notNull(),
  card: text().notNull(),
  rulesVersion: integer().notNull(),
  analysisState: text().$type<"pending" | "analyzed" | "failed">().notNull(),
  /**
   * `ModelFacts` as JSON; null until `analyzed`. Kept apart from `facts` so a re-parse of the
   * page never loses it.
   */
  modelFacts: text(),
  /** `StoredAnalysis` as JSON. */
  analysis: text(),
  firstSeenAt: integer({ mode: "timestamp_ms" }).notNull(),
  /**
   * When the Offer was made, possibly hours after `firstSeenAt`. "What's new" follows this, so a
   * client never misses an Offer that appeared after it last looked.
   */
  createdAt: integer({ mode: "timestamp_ms" }).notNull(),
  updatedAt: integer({ mode: "timestamp_ms" }).notNull(),
  /**
   * Null until first ranked. An Untracked Offer stores the band it would have if Tracked, so a
   * Search losing and regaining its matches is no band change.
   */
  band: text().$type<Band>(),
  bandChangedAt: integer({ mode: "timestamp_ms" }),
  /** Null leaves the computed Likely scam verdict. */
  scamMark: text().$type<"scam" | "not">(),
  /**
   * Dismissed hides the Offer from ranking, and because a Duplicate collapses into the Offer it
   * stays hidden through re-posts. Shortlisted and Contacted only show.
   */
  dismissed: integer({ mode: "boolean" }).notNull().default(false),
  /** Null while not Dismissed, and for Offers dismissed before this was recorded. */
  dismissedAt: integer({ mode: "timestamp_ms" }),
  shortlisted: integer({ mode: "boolean" }).notNull().default(false),
  contacted: integer({ mode: "boolean" }).notNull().default(false),
  /**
   * When a sample of the clocks first saw the Offer Stale or Untracked ("quiet"), the nightly prune
   * at the latest; cleared when it comes back. The raw snapshot's 30 days run from here, marks or
   * not.
   */
  quietSince: integer({ mode: "timestamp_ms" }),
  /**
   * Where the Offer record's 90 days run from. Like `quietSince`, except it stays null while the
   * seeker's marks or overrides keep the record (so clearing every mark starts the clock then).
   */
  recordClockSince: integer({ mode: "timestamp_ms" }),
  /**
   * When the seeker released the pin that merge and split verdicts put on the record; only later
   * verdicts pin it again. The verdicts themselves stay for dedupe. Null: never released.
   */
  pairPinsReleasedAt: integer({ mode: "timestamp_ms" }),
  /**
   * When a Re-analyse click was answered `202` whose read has not ended; null when none is owed.
   */
  reanalyzeRequestedAt: integer({ mode: "timestamp_ms" }),
});

export type OfferRow = typeof offers.$inferSelect;

export const offerAds = sqliteTable(
  "offer_ads",
  {
    source: text().$type<Source>().notNull(),
    adId: text().notNull(),
    offerId: integer()
      .notNull()
      .references(() => offers.id, { onDelete: "cascade" }),
    path: text().notNull(),
    firstSeenAt: integer({ mode: "timestamp_ms" }).notNull(),
    /** The newest instant its "Online" age allows; null when neither card nor page showed one. */
    lastBumpAt: integer({ mode: "timestamp_ms" }),
    pageStatus: text().$type<PageStatus>().notNull(),
    /** SHA-256 of the Offer's own words (the page's `.original_content`: title and sections). */
    contentHash: text(),
    /** `AdProfile` as JSON, stamped with its `PROFILE_FORMAT`; null until read. */
    profile: text(),
    /** Copies of the profile's category and PLZ, so the candidates of a new Ad ID are one lookup. */
    category: text().$type<Category>(),
    postalCode: text(),
    /** The card at the stored page's fetch; a later card that differs means it may be outdated. */
    pageCardKey: text(),
    /**
     * Set when a Recheck brings no usable page. While set, automatic Rechecks wait
     * `RECHECK_RETRY_HOURS`.
     */
    recheckedAt: integer({ mode: "timestamp_ms" }),
  },
  (t) => [
    primaryKey({ columns: [t.source, t.adId] }),
    index("offer_ads_offer").on(t.offerId),
    index("offer_ads_bucket").on(t.source, t.category, t.postalCode),
  ],
);

export type OfferAdRow = typeof offerAds.$inferSelect;

/** A row is added only when the warm rent differs from the last. */
export const offerPrices = sqliteTable(
  "offer_prices",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    offerId: integer()
      .notNull()
      .references(() => offers.id, { onDelete: "cascade" }),
    source: text().$type<Source>().notNull(),
    adId: text().notNull(),
    observedAt: integer({ mode: "timestamp_ms" }).notNull(),
    /** Euros per month. */
    amount: real().notNull(),
    /** A per-night or per-day price multiplied by 30. */
    converted: integer({ mode: "boolean" }).notNull(),
  },
  (t) => [index("offer_prices_offer").on(t.offerId, t.observedAt, t.id)],
);

export type OfferPriceRow = typeof offerPrices.$inferSelect;

/**
 * As the Advertiser wrote them (never the translation). Kept per Ad ID so they follow it through a
 * split or merge.
 */
export const offerTexts = sqliteTable(
  "offer_texts",
  {
    source: text().$type<Source>().notNull(),
    adId: text().notNull(),
    contentHash: text().notNull(),
    seenAt: integer({ mode: "timestamp_ms" }).notNull(),
    title: text().notNull(),
    /** The free-text sections as JSON: `{ label, text }[]` in page order. */
    sections: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.source, t.adId, t.contentHash] }),
    index("offer_texts_ad").on(t.source, t.adId, t.seenAt),
    foreignKey({
      columns: [t.source, t.adId],
      foreignColumns: [offerAds.source, offerAds.adId],
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
  ],
);

export type OfferTextRow = typeof offerTexts.$inferSelect;

/**
 * Two Ad IDs of different Offers that dedupe related without collapsing: another room of the same
 * flat (`sibling`), or another Advertiser reusing photos or text (`cloned`). Kept per Ad ID so
 * moving one between Offers never moves them. `adId` is the one first seen later.
 */
export const offerLinks = sqliteTable(
  "offer_links",
  {
    source: text().$type<Source>().notNull(),
    adId: text().notNull(),
    otherAdId: text().notNull(),
    kind: text().$type<"sibling" | "cloned">().notNull(),
    /** Photos both Ad IDs show, by original file name (photo key). */
    sharedImages: integer().notNull(),
    /** 0 to 1; null when either text was too short to compare. */
    textSimilarity: real(),
  },
  (t) => [
    primaryKey({ columns: [t.source, t.adId, t.otherAdId] }),
    index("offer_links_other").on(t.source, t.otherAdId),
  ],
);

export type OfferLinkRow = typeof offerLinks.$inferSelect;

/** Stored with `adIdA` sorting before `adIdB`, so either order finds it. */
export const offerPairOverrides = sqliteTable(
  "offer_pair_overrides",
  {
    source: text().$type<Source>().notNull(),
    adIdA: text().notNull(),
    adIdB: text().notNull(),
    verdict: text().$type<"same" | "different">().notNull(),
    createdAt: integer({ mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.source, t.adIdA, t.adIdB] }),
    index("offer_pair_overrides_b").on(t.source, t.adIdB),
  ],
);

export type OfferPairOverrideRow = typeof offerPairOverrides.$inferSelect;

/**
 * An Offer a merge absorbed, and the Offer that holds its room now, so an old id or link still
 * finds it. Chains are kept flat: when the survivor is absorbed in turn, every tombstone pointing
 * at it moves on.
 */
export const offerTombstones = sqliteTable(
  "offer_tombstones",
  {
    offerId: integer().primaryKey(),
    mergedInto: integer()
      .notNull()
      .references(() => offers.id, { onDelete: "cascade" }),
  },
  (t) => [index("offer_tombstones_into").on(t.mergedInto)],
);

export const analysisUsage = sqliteTable(
  "analysis_usage",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    at: integer({ mode: "timestamp_ms" }).notNull(),
    /** The Berlin calendar month the call is counted in, such as `2026-11`. */
    month: text().notNull(),
    model: text().notNull(),
    effort: text(),
    /** Billed at the Batch API's half price. */
    batch: integer({ mode: "boolean" }).notNull(),
    inputTokens: integer().notNull(),
    /** Everything billed as output, thinking included. */
    outputTokens: integer().notNull(),
    /** Part of `outputTokens`; informational. */
    thinkingTokens: integer().notNull(),
    cacheReadTokens: integer().notNull(),
    cacheWriteTokens: integer().notNull(),
    /** Millionths of a US dollar, rounded up, so sums never drift below what was billed. */
    costMicros: integer().notNull(),
    runId: integer(),
  },
  (t) => [index("analysis_usage_month").on(t.month)],
);

/** A re-analysis run: started by the seeker's click, never by anything else. */
export const analysisRuns = sqliteTable("analysis_runs", {
  id: integer().primaryKey({ autoIncrement: true }),
  createdAt: integer({ mode: "timestamp_ms" }).notNull(),
  analysisVersion: text().notNull(),
  /** At the run's start, in millionths of a US dollar. */
  estimatedCostMicros: integer().notNull(),
  /**
   * Written once, when the run settles, so deleting its Offers or items later never rewrites it.
   */
  status: text().$type<RunStatus>().notNull().default("running"),
  finishedAt: integer({ mode: "timestamp_ms" }),
  stopReason: text().$type<RunStopReason>(),
  /**
   * Offers in the run when it started; every run has one. Nullable only in SQL: NOT NULL would
   * rebuild the table, and migrations run with foreign keys on, so the rebuild's drop would cascade
   * into `analysis_items`.
   */
  offerCount: integer(),
  appliedCount: integer().notNull().default(0),
  failedCount: integer().notNull().default(0),
  cappedCount: integer().notNull().default(0),
  droppedCount: integer().notNull().default(0),
  /** JSON object of counts by error kind. */
  errorKinds: text().notNull().default("{}"),
});

export type AnalysisRunRow = typeof analysisRuns.$inferSelect;

/**
 * Where a batch is. `submitting`: being sent, or sent with no answer and not found again yet.
 * `in_progress`: the API has it. `canceling`: asked to cancel because the cap was lowered below
 * what it reserved; its results are still read when it ends. `ended`: settled, see `endReason`.
 * Moves only through `analysis/batch-state.ts`.
 */
export type AnalysisBatchState = "submitting" | "in_progress" | "canceling" | "ended";

/**
 * How a batch ended. `completed`: its results were read. `never_created`: a send of unknown outcome
 * turned out not to have made one, and its requests were queued again. `send_refused`: the API
 * refused the send. `given_up`: its results can never be read (past what the API keeps, or the API
 * no longer knows it), so what it reserved counts as spent.
 */
export type BatchEndReason = "completed" | "never_created" | "send_refused" | "given_up";

/**
 * Its worst-case cost is reserved against the spend cap from before it is sent until its results
 * are in.
 */
export const analysisBatches = sqliteTable("analysis_batches", {
  id: integer().primaryKey({ autoIncrement: true }),
  /**
   * The API's id; null while the batch is being sent, and after a send that timed out until the
   * batch is found again by what it holds.
   */
  providerBatchId: text(),
  state: text().$type<AnalysisBatchState>().notNull(),
  reservedMicros: integer().notNull(),
  requestCount: integer().notNull(),
  createdAt: integer({ mode: "timestamp_ms" }).notNull(),
  endedAt: integer({ mode: "timestamp_ms" }),
  /**
   * The model, effort and run each request was sent with, by item id (JSON). Usage is priced from the
   * item's plan; this is what prices it when the item has been deleted meanwhile (a wipe).
   */
  requests: text().notNull().default("[]"),
  /** Looks at the batch that failed in a row because the API no longer knows it. */
  checkFailures: integer().notNull().default(0),
  /** Set when it ends; null while open, and on batches ended before this was recorded. */
  endReason: text().$type<BatchEndReason>(),
});

export type AnalysisBatchRow = typeof analysisBatches.$inferSelect;

export type AnalysisItemState =
  | "queued"
  | "submitted"
  | "applied"
  | "failed"
  /** The spend cap stopped it: before it was sent, or by canceling the batch it was in. */
  | "capped"
  /** The result was thrown away: the Offer's words changed, or it is gone. */
  | "dropped";
// Moves only through `analysis/batch-state.ts`; a queued item outside any run may also be
// discarded (its row deleted) when the cap stops it.

/** Stage 1 is the model pass, stage 2 the escalation pass. */
export const analysisItems = sqliteTable(
  "analysis_items",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    offerId: integer()
      .notNull()
      .references(() => offers.id, { onDelete: "cascade" }),
    runId: integer().references(() => analysisRuns.id, { onDelete: "cascade" }),
    batchId: integer().references(() => analysisBatches.id),
    stage: integer().$type<1 | 2>().notNull(),
    state: text().$type<AnalysisItemState>().notNull(),
    /** The Offer's `contentHash` when the item was queued: a result for other words is dropped. */
    contentHash: text().notNull(),
    plan: text().notNull(),
    /** Stage 2: what the first pass found, until the escalation answers (JSON). */
    carry: text(),
    errorKind: text(),
    createdAt: integer({ mode: "timestamp_ms" }).notNull(),
    finishedAt: integer({ mode: "timestamp_ms" }),
  },
  (t) => [index("analysis_items_state").on(t.state), index("analysis_items_offer").on(t.offerId)],
);

export type AnalysisItemRow = typeof analysisItems.$inferSelect;

/**
 * Kept apart from rule and model facts so a re-parse, Recheck or new analysis never touches it.
 * Pruning keeps its Offer.
 */
export const offerFactOverrides = sqliteTable(
  "offer_fact_overrides",
  {
    offerId: integer()
      .notNull()
      .references(() => offers.id, { onDelete: "cascade" }),
    fact: text().notNull(),
    /** JSON, as the Offer Facts store it; a list fact holds the list of its items. */
    value: text().notNull(),
    createdAt: integer({ mode: "timestamp_ms" }).notNull(),
    /**
     * The page current when the correction was made. No foreign key: it outlives the Ad ID's row.
     * All null for a correction made before they were recorded.
     */
    source: text().$type<Source>(),
    adId: text(),
    contentHash: text(),
  },
  (t) => [primaryKey({ columns: [t.offerId, t.fact] })],
);

export type OfferFactOverrideRow = typeof offerFactOverrides.$inferSelect;

/**
 * Only a keyed hash of the session id is stored, so a copy of the database can't be turned into a
 * working cookie.
 */
export const dashboardSessions = sqliteTable("dashboard_sessions", {
  /** HMAC-SHA256 of the session id, keyed with the access token it was issued under. */
  idHash: text().primaryKey(),
  /**
   * HMAC-SHA256 of a fixed label keyed with that token: names the token without revealing it, so
   * rows issued under a token that has since been replaced can be found and deleted.
   */
  tokenTag: text().notNull(),
  createdAt: integer({ mode: "timestamp_ms" }).notNull(),
  /** When a request last renewed the session; it ends `SESSION_IDLE_MS` after this. */
  lastUsedAt: integer({ mode: "timestamp_ms" }).notNull(),
});
