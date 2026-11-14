import type { Category, SearchCard, Source, SourceAdapter } from "@wg-hunt/core";
import { and, asc, eq, isNotNull, isNull, lt } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { offerAds, type SearchRow, searches, searchMatches, seenAds } from "../db/schema.js";
import { isAdStale } from "../offers/staleness.js";
import { berlinDayStart, nextActiveInstant } from "./berlin-time.js";
import type { CrawlEngine, HandlerResult } from "./engine.js";
import type { SourceResponse } from "./fetcher.js";
import { type Job, queuedJobs, removeJob } from "./queue.js";
import type { FetchedOffer, SearchPolling } from "./search-polls.js";
import { loadCrawlSettings } from "./settings.js";
import {
  type InvalidSweep,
  isComplete,
  loadSweep,
  type Sweep,
  type SweepEvent,
  type SweepState,
  transition,
  writeSweep,
} from "./sweep-state.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const SWEEP_START_HOURS = 3;
/** A safety stop: no Search has this many pages in a week's window. */
const SWEEP_MAX_PAGES = 60;
export const MAX_SWEEP_ATTEMPTS = 3;
const RETRY_MINUTES = 30;
/** A Source wrongly answering with a short list must not cost hundreds of fetches. */
const MAX_CONFIRMATIONS_PER_SWEEP = 40;

type SweepPagePayload = {
  type: "sweep-page";
  searchId: number;
  generation: number;
  category: Category;
  page: number;
  attempt?: number;
};

type ConfirmationPayload = {
  type: "stale-confirmation";
  source: Source;
  adId: string;
  attempt?: number;
};

function isSweepPage(value: unknown): value is SweepPagePayload {
  const v = value as Partial<SweepPagePayload> | undefined;
  return (
    v?.type === "sweep-page" &&
    typeof v.searchId === "number" &&
    typeof v.generation === "number" &&
    typeof v.category === "string" &&
    typeof v.page === "number"
  );
}

function isConfirmation(value: unknown): value is ConfirmationPayload {
  const v = value as Partial<ConfirmationPayload> | undefined;
  return (
    v?.type === "stale-confirmation" && typeof v.source === "string" && typeof v.adId === "string"
  );
}

/** Any change is an edit. The first `COVERAGE_PARTS` are what it covers. */
function specKey(search: SearchRow): string {
  return JSON.stringify([
    search.source,
    search.city,
    search.cityId,
    search.categories,
    search.rentTypes,
    search.priceCeiling,
    search.recencyDays,
    search.enabled,
  ]);
}

const COVERAGE_PARTS = 5;

function coverageChanged(before: string, after: string): boolean {
  try {
    const part = (key: string) =>
      JSON.stringify((JSON.parse(key) as unknown[]).slice(0, COVERAGE_PARTS));
    return part(before) !== part(after);
  } catch {
    return true;
  }
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

export function createSweeps(deps: {
  db: Db;
  engine: Pick<CrawlEngine, "enqueue" | "on" | "onHandlerFailed">;
  adapters: Record<Source, SourceAdapter>;
  polling: SearchPolling;
  /** Epoch milliseconds. */
  clock: () => number;
  /** Uniform in [0, 1). */
  random: () => number;
}) {
  const { db, engine, adapters, polling, clock, random } = deps;
  const finishedListeners: ((searchId: number) => void)[] = [];

  const searchRow = (id: number) => db.select().from(searches).where(eq(searches.id, id)).get();
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
  const stored = (search: SearchRow) => loadSweep(db, search.id, search.categories);

  /** The only write to a Sweep. */
  function commit(search: SearchRow, prev: Sweep | InvalidSweep | undefined, event: SweepEvent) {
    const next = transition(prev, event);
    writeSweep(db, search.id, next);
    return next;
  }

  function liveSweep(searchId: number, generation: number): Sweep | undefined {
    const search = searchRow(searchId);
    if (search === undefined || !search.enabled) return undefined;
    const sweep = stored(search);
    if (sweep === undefined || "invalid" in sweep) return undefined;
    if (sweep.state.status === "idle" || sweep.generation !== generation) return undefined;
    return sweep;
  }

  function startOnDay(ms: number, daysAhead: number): number {
    const { start, end } = loadCrawlSettings(db).pacing.activeHours;
    const opens = nextActiveInstant(berlinDayStart(ms, daysAhead), start, end);
    const open = (toMinutes(end) - toMinutes(start)) * MINUTE;
    return opens + Math.floor(random() * Math.min(SWEEP_START_HOURS * HOUR, open));
  }

  /** A Sweep that ran into a second morning has used up that day's turn. */
  const nextStart = (endedAt: number) => startOnDay(endedAt, 1);

  function wantedPages(search: SearchRow, state: SweepState): [Category, number][] {
    if (state.status === "idle") return [];
    return search.categories.flatMap((category): [Category, number][] => {
      const page = state.status === "running" ? state.cursors[category] : 0;
      return page === null || page === undefined ? [] : [[category, page]];
    });
  }

  /**
   * Sweep pages and poll continuations share `deeper-page` and the queue holds one job per path. A
   * replaced Sweep requeues at the next `sync`; this page takes the same cards for every Search on
   * the URL.
   */
  function queuePage(
    search: SearchRow,
    sweep: Sweep,
    category: Category,
    page: number,
    queued: Map<string, Job>,
  ): void {
    const request = polling.pageRequest(search, category, page);
    if (request === undefined) return;
    const dueAt = page === 0 && sweep.state.status === "scheduled" ? sweep.state.startAt : clock();
    const held = queued.get(request.path);
    if (held !== undefined) {
      if (isSweepPage(held.payload) && liveSweep(held.payload.searchId, held.payload.generation)) {
        if (held.payload.searchId === search.id || held.dueAt <= dueAt) return;
        // A retry is always due later than a first try, and its count lives only in this job.
        if ((held.payload.attempt ?? 0) >= 1) return;
      }
      removeJob(db, held.id);
    }
    const job = engine.enqueue({
      kind: "deeper-page",
      path: request.path,
      dueAt,
      payload: {
        type: "sweep-page",
        searchId: search.id,
        generation: sweep.generation,
        category,
        page,
      } satisfies SweepPagePayload,
    });
    if (job !== null) queued.set(request.path, job);
  }

  const queuedPages = () => new Map(queuedJobs(db, "deeper-page").map((job) => [job.path, job]));

  function ensureJobs(search: SearchRow, sweep: Sweep): void {
    const queued = queuedPages();
    for (const [category, page] of wantedPages(search, sweep.state)) {
      queuePage(search, sweep, category, page, queued);
    }
  }

  function clearMatches(searchId: number): void {
    db.delete(searchMatches).where(eq(searchMatches.searchId, searchId)).run();
  }

  function startBackfill(search: SearchRow, prev: Sweep | InvalidSweep | undefined, now: number) {
    const next = commit(search, prev, {
      type: "start",
      specKey: specKey(search),
      mode: "backfill",
      startAt: now,
    });
    ensureJobs(search, next);
  }

  function syncSearch(search: SearchRow, now: number): void {
    const prev = stored(search);
    const key = specKey(search);
    if (!polling.isCrawled(search)) {
      // Nothing it matched is Tracked on its account any more.
      if (prev !== undefined && !("invalid" in prev)) {
        if (prev.state.status === "idle" && prev.specKey === key) return;
      }
      clearMatches(search.id);
      commit(search, prev, { type: "stop", specKey: key });
      return;
    }

    if (prev === undefined) {
      startBackfill(search, prev, now);
    } else if (prev.specKey !== key) {
      // Old matches stay (still Tracked) until `finish` drops the unseen ones; only a coverage
      // change drops them now.
      if (coverageChanged(prev.specKey, key)) clearMatches(search.id);
      startBackfill(search, prev, now);
    } else if ("invalid" in prev) {
      // A row no state fits can't be judged from or continued; a backfill drops what it misses
      // without a fetch.
      startBackfill(search, prev, now);
    } else if (prev.state.status === "idle") {
      // It became readable without an edit (the adapter learnt its city): it is owed a backfill.
      startBackfill(search, prev, now);
    } else if (isComplete(prev.state, search.categories)) {
      finish(search, prev, now);
    } else {
      ensureJobs(search, prev);
    }
  }

  function dropOrphans(): void {
    for (const job of queuedJobs(db, "deeper-page")) {
      if (!isSweepPage(job.payload)) continue;
      if (!liveSweep(job.payload.searchId, job.payload.generation)) removeJob(db, job.id);
    }
    for (const job of queuedJobs(db, "stale-confirmation")) {
      if (!isConfirmation(job.payload) || !isWanted(job.payload.source, job.payload.adId)) {
        removeJob(db, job.id);
      }
    }
  }

  function isWanted(source: Source, adId: string): boolean {
    return (
      db
        .select({ at: searchMatches.missingAt })
        .from(searchMatches)
        .innerJoin(
          searches,
          and(eq(searches.id, searchMatches.searchId), eq(searches.enabled, true)),
        )
        .where(
          and(
            eq(searchMatches.source, source),
            eq(searchMatches.adId, adId),
            isNotNull(searchMatches.missingAt),
          ),
        )
        .limit(1)
        .get() !== undefined
    );
  }

  /**
   * Lost to a Bot check or crash, a confirmation would leave the Ad ID missing and Tracked until
   * Stale.
   */
  function restoreConfirmations(now: number): void {
    const queued = new Set(
      queuedJobs(db, "stale-confirmation")
        .map((job) => job.payload)
        .filter(isConfirmation)
        .map((payload) => `${payload.source}\n${payload.adId}`),
    );
    const waiting = db
      .selectDistinct({ source: searchMatches.source, adId: searchMatches.adId })
      .from(searchMatches)
      .innerJoin(searches, and(eq(searches.id, searchMatches.searchId), eq(searches.enabled, true)))
      .where(isNotNull(searchMatches.missingAt))
      .all();
    for (const { source, adId } of waiting) {
      if (queued.has(`${source}\n${adId}`)) continue;
      const ad = adRow(source, adId);
      if (ad === undefined || seenRow(source, adId) === undefined || isAdStale(ad, now)) {
        settle(source, adId, false);
        continue;
      }
      engine.enqueue({
        kind: "stale-confirmation",
        path: ad.path,
        payload: { type: "stale-confirmation", source, adId } satisfies ConfirmationPayload,
      });
    }
  }

  function sync(): void {
    const now = clock();
    db.$client.transaction(() => {
      for (const search of db.select().from(searches).orderBy(asc(searches.id)).all()) {
        syncSearch(search, now);
      }
      dropOrphans();
      restoreConfirmations(now);
    })();
  }

  function retryPage(search: SearchRow, sweep: Sweep, payload: SweepPagePayload): void {
    const attempt = (payload.attempt ?? 0) + 1;
    const now = clock();
    const request = polling.pageRequest(search, payload.category, payload.page);
    if (attempt >= MAX_SWEEP_ATTEMPTS || request === undefined) {
      // A Sweep with a page missing cannot say what is gone: give it up, and sweep again tomorrow.
      const next = commit(search, sweep, { type: "give-up", startAt: nextStart(now) });
      dropOrphans();
      ensureJobs(search, next);
      return;
    }
    engine.enqueue({
      kind: "deeper-page",
      path: request.path,
      dueAt: now + attempt * RETRY_MINUTES * MINUTE,
      payload: { ...payload, attempt } satisfies SweepPagePayload,
    });
  }

  function handlePage(job: Job, response: SourceResponse | undefined): HandlerResult | undefined {
    const payload = job.payload;
    if (!isSweepPage(payload)) return undefined;
    const search = searchRow(payload.searchId);
    const sweep = liveSweep(payload.searchId, payload.generation);
    if (search === undefined || sweep === undefined) return undefined;

    if (response === undefined || response.status >= 400) {
      retryPage(search, sweep, payload);
      return undefined;
    }
    // A redirect is not followed: a results page that does not come back as one is unexpected.
    if (response.status >= 300) return { unexpectedPage: true };
    const parsed = adapters[search.source].parseSearchPage(response.body);
    if (parsed.outcome === "unexpected") return { unexpectedPage: true };

    const now = clock();
    db.$client.transaction(() => {
      polling.takeCards(search, payload.category, payload.page, job.path, parsed.cards, now);
      const more = parsed.cards.length > 0 && payload.page + 1 < SWEEP_MAX_PAGES;
      const next = commit(search, sweep, {
        type: "page-read",
        categories: search.categories,
        category: payload.category,
        page: payload.page,
        cards: parsed.cards.length,
        more,
        now,
      });
      if (more) queuePage(search, next, payload.category, payload.page + 1, queuedPages());
      else if (isComplete(next.state, search.categories)) finish(search, next, now);
    })();
    return undefined;
  }

  function finish(search: SearchRow, sweep: Sweep, now: number): void {
    const { state } = sweep;
    if (state.status !== "running") return;
    const startedAt = state.startedAt;
    if (state.mode === "backfill") {
      // Unseen matches go without a fetch (kept only to stay Tracked meanwhile). An empty answer
      // counts too; a wrong one only hides Offers until the next poll finds them.
      db.delete(searchMatches)
        .where(
          and(
            eq(searchMatches.searchId, search.id),
            lt(searchMatches.lastSeenAt, new Date(startedAt)),
          ),
        )
        .run();
    } else if (state.cardCount > 0) {
      // A daily Sweep that read no card at all proves nothing (an empty answer is not "everything
      // left").
      const missing = db
        .select()
        .from(searchMatches)
        .where(
          and(
            eq(searchMatches.searchId, search.id),
            lt(searchMatches.lastSeenAt, new Date(startedAt)),
            isNull(searchMatches.missingAt),
          ),
        )
        .orderBy(asc(searchMatches.lastSeenAt))
        .all();
      let queued = 0;
      for (const match of missing) {
        if (queued >= MAX_CONFIRMATIONS_PER_SWEEP) break;
        const ad = adRow(match.source, match.adId);
        if (ad === undefined || isAdStale(ad, now)) continue;
        db.update(searchMatches)
          .set({ missingAt: new Date(now) })
          .where(
            and(
              eq(searchMatches.searchId, search.id),
              eq(searchMatches.source, match.source),
              eq(searchMatches.adId, match.adId),
            ),
          )
          .run();
        engine.enqueue({
          kind: "stale-confirmation",
          path: ad.path,
          payload: {
            type: "stale-confirmation",
            source: match.source,
            adId: match.adId,
          } satisfies ConfirmationPayload,
        });
        queued++;
      }
    }
    const next = commit(search, sweep, { type: "finish", now, startAt: nextStart(now) });
    ensureJobs(search, next);
    for (const listener of finishedListeners) listener(search.id);
  }

  function settle(source: Source, adId: string, leftTheSearch: boolean): void {
    const waiting = and(
      eq(searchMatches.source, source),
      eq(searchMatches.adId, adId),
      isNotNull(searchMatches.missingAt),
    );
    if (leftTheSearch) db.delete(searchMatches).where(waiting).run();
    else db.update(searchMatches).set({ missingAt: null }).where(waiting).run();
  }

  function retryConfirmation(job: Job, payload: ConfirmationPayload): void {
    const attempt = (payload.attempt ?? 0) + 1;
    if (attempt >= MAX_SWEEP_ATTEMPTS) {
      // Not answered: the next Sweep that misses it asks again.
      settle(payload.source, payload.adId, false);
      return;
    }
    engine.enqueue({
      kind: "stale-confirmation",
      path: job.path,
      dueAt: clock() + attempt * RETRY_MINUTES * MINUTE,
      payload: { ...payload, attempt } satisfies ConfirmationPayload,
    });
  }

  function handleConfirmation(
    job: Job,
    response: SourceResponse | undefined,
  ): HandlerResult | undefined {
    const payload = job.payload;
    if (!isConfirmation(payload)) return undefined;
    const { source, adId } = payload;
    const seen = seenRow(source, adId);
    if (!isWanted(source, adId)) return undefined;
    // Nothing to compare the page with: unanswered, so the next Sweep that misses it asks again.
    if (seen === undefined) {
      settle(source, adId, false);
      return undefined;
    }

    if (response === undefined || response.status < 200 || response.status >= 300) {
      retryConfirmation(job, payload);
      return undefined;
    }
    const parsed = adapters[source].parseOffer(response.body, {
      firstSeen: seen.firstSeenAt,
      category: seen.category,
    });
    if (parsed.outcome === "unexpected") {
      retryConfirmation(job, payload);
      return { unexpectedPage: true };
    }

    const fetchedAt = clock();
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
    // Still active: it only left the Search. Anything else: the page says why it was missing.
    settle(source, adId, parsed.status === "active");
    return undefined;
  }

  polling.routePages("sweep-page", handlePage);
  engine.on("stale-confirmation", handleConfirmation);
  engine.onHandlerFailed((job) => {
    if (job.kind === "stale-confirmation" && isConfirmation(job.payload)) {
      retryConfirmation(job, job.payload);
    }
  });
  polling.onSync(sync);
  polling.onPageHandled(sync);

  return {
    sync,
    /** Runs after a Sweep's confirmations are queued. */
    onFinished(listener: (searchId: number) => void): void {
      finishedListeners.push(listener);
    },
  };
}
