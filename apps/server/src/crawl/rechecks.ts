import type { SearchCard, Source, SourceAdapter } from "@wg-hunt/core";
import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { crawlRequests, type OfferAdRow, offerAds, seenAds } from "../db/schema.js";
import { cardKeyOf } from "../offers/card-key.js";
import { isAdStale } from "../offers/staleness.js";
import { berlinDayStart } from "./berlin-time.js";
import { forecastDay, recheckRoom, storedForecastSearches } from "./budget.js";
import { jobPriority } from "./constants.js";
import type { CrawlEngine, HandlerResult } from "./engine.js";
import type { SourceResponse } from "./fetcher.js";
import { type Job, queuedJobs, removeJob } from "./queue.js";
import { requestCount } from "./request-log.js";
import type { FetchedOffer, SearchPolling } from "./search-polls.js";
import { loadCrawlSettings } from "./settings.js";
import { loggedPath } from "./source-paths.js";

const HOUR = 3_600_000;

export const RECHECK_RETRY_HOURS = 6;
const MAX_QUEUED_RECHECKS = 50;

/**
 * Weakest first.
 * - `automatic`: Bumped since its fetch and due.
 * - `returning`: a Stale Ad ID showed up on a search card again.
 * - `manual`: the Offer's Recheck button.
 */
const RECHECK_REASONS = ["automatic", "returning", "manual"] as const;
type RecheckReason = (typeof RECHECK_REASONS)[number];

const stronger = (a: RecheckReason, b: RecheckReason): RecheckReason =>
  RECHECK_REASONS.indexOf(a) >= RECHECK_REASONS.indexOf(b) ? a : b;

const priorityFor = (reason: RecheckReason): number =>
  jobPriority(reason === "returning" ? "new-offer" : "recheck");

type RecheckPayload = { type: "recheck"; source: Source; adId: string; reason: RecheckReason };

function readRecheck(value: unknown): RecheckPayload | undefined {
  const v = value as Partial<RecheckPayload> | undefined;
  const reason = RECHECK_REASONS.find((each) => each === v?.reason);
  if (
    v?.type !== "recheck" ||
    typeof v.source !== "string" ||
    typeof v.adId !== "string" ||
    reason === undefined
  ) {
    return undefined;
  }
  return { type: "recheck", source: v.source, adId: v.adId, reason };
}

function waitingRecheck(
  db: Db,
  source: Source,
  adId: string,
): { job: Job; payload: RecheckPayload } | undefined {
  for (const job of queuedJobs(db, "recheck")) {
    const payload = readRecheck(job.payload);
    if (payload?.source === source && payload.adId === adId) return { job, payload };
  }
  return undefined;
}

const keyOf = (source: Source, adId: string) => `${source}:${adId}`;

const retryAtOf = (ad: Pick<OfferAdRow, "recheckedAt">): number | null =>
  ad.recheckedAt === null ? null : ad.recheckedAt.getTime() + RECHECK_RETRY_HOURS * HOUR;

const backingOff = (ad: Pick<OfferAdRow, "recheckedAt">, now: number): boolean =>
  (retryAtOf(ad) ?? 0) > now;

/**
 * A Recheck that brought no usable page is on `recheckedAt`, which a stored page clears, so one
 * that read fine is found in the request log, under one of the paths the page is asked for.
 */
function lastReadFineAt(db: Db, paths: readonly string[], now: number): number | null {
  const row = db
    .select({ at: crawlRequests.at })
    .from(crawlRequests)
    .where(
      and(
        gte(crawlRequests.at, new Date(now - RECHECK_RETRY_HOURS * HOUR)),
        eq(crawlRequests.kind, "recheck"),
        eq(crawlRequests.outcome, "ok"),
        inArray(crawlRequests.path, paths.map(loggedPath)),
      ),
    )
    .orderBy(desc(crawlRequests.at))
    .limit(1)
    .get();
  return row?.at.getTime() ?? null;
}

export const RECHECK_STATES = ["idle", "queued", "in-flight", "failed"] as const;

export type RecheckState = {
  state: (typeof RECHECK_STATES)[number];
  manual: boolean;
  /** Last fetch of the page by any means (ISO); null before any. */
  pageFetchedAt: string | null;
  /** Last Recheck that brought no usable page (ISO); null once a page was stored. */
  lastFailedAt: string | null;
  /** While `failed`: when an automatic Recheck may try the page again (ISO). Null otherwise. */
  retryAfter: string | null;
};

export function recheckStateOf(
  db: Db,
  ad: Pick<OfferAdRow, "source" | "adId" | "path" | "recheckedAt">,
  now: number,
): RecheckState {
  const waiting = waitingRecheck(db, ad.source, ad.adId);
  const fetchedAt = db
    .select({ at: seenAds.detailFetchedAt })
    .from(seenAds)
    .where(and(eq(seenAds.source, ad.source), eq(seenAds.adId, ad.adId)))
    .get()?.at;
  const retryAt = retryAtOf(ad);
  const base = {
    manual: waiting?.payload.reason === "manual",
    pageFetchedAt: fetchedAt?.toISOString() ?? null,
    lastFailedAt: ad.recheckedAt?.toISOString() ?? null,
    retryAfter: null,
  };
  if (waiting !== undefined) {
    // The job stays queued while its request is out; the `pending` log row says that it went.
    const out = db
      .select({ id: crawlRequests.id })
      .from(crawlRequests)
      .where(
        and(
          eq(crawlRequests.kind, waiting.job.kind),
          eq(crawlRequests.outcome, "pending"),
          eq(crawlRequests.path, loggedPath(waiting.job.path)),
        ),
      )
      .get();
    if (out !== undefined) return { ...base, state: "in-flight" };
    // One put off until later waits out the time since the page's last Recheck, not its turn.
    if (waiting.job.dueAt <= now) return { ...base, state: "queued" };
  }
  if (retryAt !== null && retryAt > now) {
    return { ...base, state: "failed", retryAfter: new Date(retryAt).toISOString() };
  }
  return { ...base, state: "idle" };
}

export type Rechecks = ReturnType<typeof createRechecks>;

export function createRechecks(deps: {
  db: Db;
  engine: Pick<CrawlEngine, "enqueue" | "on" | "onIdle" | "onDropped" | "caps">;
  adapters: Record<Source, SourceAdapter>;
  polling: SearchPolling;
  isTracked: (source: Source, adId: string) => boolean;
  /** Epoch milliseconds. */
  clock: () => number;
}) {
  const { db, engine, adapters, polling, isTracked, clock } = deps;

  const adRow = (source: Source, adId: string) =>
    db
      .select()
      .from(offerAds)
      .where(and(eq(offerAds.source, source), eq(offerAds.adId, adId)))
      .get();
  const seenRow = (source: Source, adId: string) =>
    db
      .select()
      .from(seenAds)
      .where(and(eq(seenAds.source, source), eq(seenAds.adId, adId)))
      .get();

  type Candidate = { ad: OfferAdRow; fetchedAt: number };

  function candidates(now: number, maxPageAgeHours: number): Candidate[] {
    const rows = db
      .select({ ad: offerAds, card: seenAds.card, fetchedAt: seenAds.detailFetchedAt })
      .from(offerAds)
      .innerJoin(seenAds, and(eq(seenAds.source, offerAds.source), eq(seenAds.adId, offerAds.adId)))
      .where(
        and(
          eq(offerAds.pageStatus, "active"),
          eq(seenAds.detailState, "fetched"),
          isNotNull(seenAds.detailFetchedAt),
          sql`${offerAds.lastBumpAt} > ${seenAds.detailFetchedAt}`,
        ),
      )
      .orderBy(asc(seenAds.detailFetchedAt), asc(offerAds.adId))
      .all();

    const found: Candidate[] = [];
    for (const { ad, card, fetchedAt } of rows) {
      if (fetchedAt === null) continue;
      if (isAdStale(ad, now) || !isTracked(ad.source, ad.adId)) continue;
      if (backingOff(ad, now)) continue;
      const changed = ad.pageCardKey === null || ad.pageCardKey !== cardKeyOf(card);
      const old = fetchedAt.getTime() < now - maxPageAgeHours * HOUR;
      if (changed || old) found.push({ ad, fetchedAt: fetchedAt.getTime() });
    }
    return found;
  }

  function room(now: number): number {
    const settings = loadCrawlSettings(db);
    const forecast = forecastDay({
      searches: storedForecastSearches(db, polling.problemOf),
      settings,
      caps: engine.caps(),
    });
    const usedToday = requestCount(db, berlinDayStart(now), berlinDayStart(now, 1));
    return recheckRoom({
      forecast,
      usedToday,
      now,
      activeHours: settings.pacing.activeHours,
    });
  }

  const payloadFor = (ad: OfferAdRow, reason: RecheckReason): RecheckPayload => ({
    type: "recheck",
    source: ad.source,
    adId: ad.adId,
    reason,
  });

  /** Says whether a Recheck of the Ad ID already waited. */
  function ask(
    ad: OfferAdRow,
    asked: {
      reason: RecheckReason;
      path: string;
      dueAt: number;
      priority?: number;
    },
  ): boolean {
    const priority = asked.priority ?? priorityFor(asked.reason);
    const waiting = waitingRecheck(db, ad.source, ad.adId);
    if (waiting === undefined) {
      engine.enqueue({
        kind: "recheck",
        path: asked.path,
        dueAt: asked.dueAt,
        priority,
        payload: payloadFor(ad, asked.reason),
      });
      return false;
    }
    const { job, payload } = waiting;
    const reason = stronger(payload.reason, asked.reason);
    const place = Math.min(job.priority, priority);
    if (reason === payload.reason && place === job.priority) return true;
    // Replaced, not edited: should its request be out, the new job outlives that answer, so a
    // press made meanwhile is not lost if a Bot check drops it, at the price of a second read.
    // In one transaction, so a path the queue refuses leaves the waiting job where it was.
    db.$client.transaction(() => {
      removeJob(db, job.id);
      engine.enqueue({
        kind: "recheck",
        // A returning Ad ID's card has the path the Source lists it under now.
        path: asked.reason === "returning" ? asked.path : job.path,
        dueAt: Math.min(job.dueAt, asked.dueAt),
        priority: place,
        payload: payloadFor(ad, reason),
      });
    })();
    return true;
  }

  function sync(): void {
    const now = clock();
    const { recheck } = loadCrawlSettings(db);
    const due = recheck.enabled ? candidates(now, recheck.maxPageAgeHours) : [];
    const wanted = new Set(due.map((c) => keyOf(c.ad.source, c.ad.adId)));

    const queued = new Set<string>();
    let waiting = 0;
    for (const job of queuedJobs(db, "recheck")) {
      const payload = readRecheck(job.payload);
      if (payload === undefined) {
        removeJob(db, job.id);
        continue;
      }
      const key = keyOf(payload.source, payload.adId);
      if (payload.reason === "automatic" && !wanted.has(key)) {
        removeJob(db, job.id);
        continue;
      }
      queued.add(key);
      // A returning Ad ID's is served with the new Offers, whose share of the day is set aside.
      if (payload.reason !== "returning") waiting++;
    }
    if (due.length === 0) return;

    let allowance = Math.min(room(now) - waiting, MAX_QUEUED_RECHECKS - waiting);
    for (const { ad, fetchedAt } of due) {
      if (allowance <= 0) break;
      if (queued.has(keyOf(ad.source, ad.adId))) continue;
      // Due at the time its page was fetched: the oldest page is the first one served.
      engine.enqueue({
        kind: "recheck",
        path: ad.path,
        dueAt: fetchedAt,
        payload: payloadFor(ad, "automatic"),
      });
      allowance--;
    }
  }

  function request(source: Source, adId: string): { alreadyQueued: boolean } {
    const ad = adRow(source, adId);
    if (ad === undefined) throw new Error("an Offer's Ad ID always has its row");
    return { alreadyQueued: ask(ad, { reason: "manual", path: ad.path, dueAt: clock() }) };
  }

  /**
   * Held off for the retry time even after a Recheck that read fine: a page that still says
   * deactivated behind a card that stays listed is not news at every poll. Put off rather than left
   * out: an Ad ID Bumped back out of Stale shows up as returning on one card only.
   */
  function queueReturning(source: Source, adId: string): void {
    const ad = adRow(source, adId);
    const seen = seenRow(source, adId);
    if (ad === undefined || seen === undefined) return;
    const now = clock();
    const path = (JSON.parse(seen.card) as SearchCard).path;
    const readFineAt = lastReadFineAt(db, [path, ad.path], now);
    ask(ad, {
      reason: "returning",
      path,
      dueAt: Math.max(
        now,
        retryAtOf(ad) ?? 0,
        readFineAt === null ? 0 : readFineAt + RECHECK_RETRY_HOURS * HOUR,
      ),
    });
  }

  function handle(job: Job, response: SourceResponse | undefined): HandlerResult | undefined {
    const payload = readRecheck(job.payload);
    if (payload === undefined) return undefined;
    const { source, adId } = payload;
    const ad = adRow(source, adId);
    const seen = seenRow(source, adId);
    if (ad === undefined || seen === undefined) return undefined;

    // Storing the page clears this again, so it stays set only when the Recheck brought nothing
    // usable.
    db.update(offerAds)
      .set({ recheckedAt: new Date(clock()) })
      .where(and(eq(offerAds.source, source), eq(offerAds.adId, adId)))
      .run();
    if (response === undefined || response.status < 200 || response.status >= 300) {
      return undefined;
    }
    const parsed = adapters[source].parseOffer(response.body, {
      firstSeen: seen.firstSeenAt,
      category: seen.category,
    });
    if (parsed.outcome === "unexpected") return { unexpectedPage: true };

    const fetchedAt = clock();
    // Should the Offers step fail on a deletion, recheckedAt stays set (only that step clears it)
    // and a later Recheck reads the deletion again.
    polling.storeFetchedPage({
      source,
      adId,
      html: response.body,
      deleted: parsed.status === "deleted",
      fetchedAt,
    });
    const offer: FetchedOffer = {
      source,
      adId,
      fetchedAt,
      card: JSON.parse(seen.card) as SearchCard,
      parsed,
    };
    polling.publishFetched(offer);
    return undefined;
  }

  engine.on("recheck", (job, response) => {
    const result = handle(job, response);
    sync();
    return result;
  });
  // No card may ask for a returning one again (see `queueReturning`). Asked for again rather than
  // queued as it was: the sync that follows a Bot check may have queued an automatic Recheck of the
  // same page first.
  engine.onDropped((job) => {
    const payload = job.kind === "recheck" ? readRecheck(job.payload) : undefined;
    if (payload === undefined || payload.reason === "automatic") return;
    const ad = adRow(payload.source, payload.adId);
    if (ad === undefined) return;
    ask(ad, { reason: payload.reason, path: job.path, dueAt: clock(), priority: job.priority });
  });
  polling.onSync(sync);
  engine.onIdle(sync);

  return {
    sync,
    request,
    queueReturning,
  };
}
