import {
  type Category,
  MAX_POLL_MINUTES,
  type ParseResult,
  type SearchCard,
  type SearchSpec,
  type Source,
  type SourceAdapter,
} from "@wg-hunt/core";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { type SearchRow, searches, searchMatches, seenAds } from "../db/schema.js";
import { STALE_AFTER_DAYS } from "../offers/staleness.js";
import { pollStretch } from "./budget.js";
import { isCrawled, type PollProblem } from "./crawled-search.js";
import {
  afterFailedFetch,
  firstDetailState,
  requeued,
  storeFetchedPage,
  wantsRefetch,
} from "./detail-fetch.js";
import type { CrawlEngine, HandlerResult, JobHandler, WaitReason } from "./engine.js";
import type { SourceResponse } from "./fetcher.js";
import { olderThan, type PublishWindow, publishWindow, wasBumped } from "./publish-window.js";
import { type Job, queuedJobs, removeJob } from "./queue.js";
import { loadCrawlSettings } from "./settings.js";
import type { SnapshotStore } from "./snapshots.js";

export const MAX_POLL_PAGES = 5;

const RETRY_MINUTES = 30;
const MINUTE = 60_000;

type PagePayload = { type: "search-page"; searchId: number; category: Category; page: number };
type OfferPayload = {
  type: "new-offer";
  source: Source;
  adId: string;
  category: Category;
};

function isPagePayload(value: unknown): value is PagePayload {
  const v = value as Partial<PagePayload> | undefined;
  return (
    v?.type === "search-page" &&
    typeof v.searchId === "number" &&
    typeof v.category === "string" &&
    typeof v.page === "number"
  );
}

function isOfferPayload(value: unknown): value is OfferPayload {
  const v = value as Partial<OfferPayload> | undefined;
  return (
    v?.type === "new-offer" &&
    typeof v.source === "string" &&
    typeof v.adId === "string" &&
    typeof v.category === "string"
  );
}

export type FetchedOffer = {
  source: Source;
  adId: string;
  fetchedAt: number;
  card: SearchCard;
  parsed: Exclude<ParseResult, { outcome: "unexpected" }>;
};

export type AdSighting = {
  source: Source;
  adId: string;
  card: SearchCard;
  bumped: boolean;
  /** Latest possible last publish or Bump per the card's age (epoch ms); null if no age shown. */
  lastBumpAt: number | null;
};

export type CrawlNowResult =
  | {
      ok: true;
      queued: number;
      /** Null while only a Resume helps. */
      runsAt: number | null;
      /** Null when it may go now. */
      waiting: WaitReason | null;
    }
  | { ok: false; reason: "disabled" | "unknown-city" };

type SourcedSpec = SearchSpec & { source: Source };

export const toSpec = (search: SourcedSpec): SearchSpec => ({
  city: search.city,
  cityId: search.cityId,
  categories: search.categories,
  rentTypes: search.rentTypes,
  priceCeiling: search.priceCeiling,
  recencyDays: search.recencyDays,
});

export type SearchPolling = ReturnType<typeof createSearchPolling>;

export function createSearchPolling(deps: {
  db: Db;
  engine: Pick<
    CrawlEngine,
    "enqueue" | "on" | "onDropped" | "onHandlerFailed" | "nextRequest" | "caps"
  >;
  adapters: Record<Source, SourceAdapter>;
  snapshots: SnapshotStore;
  /** Epoch milliseconds. */
  clock: () => number;
  /** Uniform in [0, 1). */
  random: () => number;
}) {
  const { db, engine, adapters, snapshots, clock, random } = deps;
  const listeners: ((offer: FetchedOffer) => void)[] = [];
  const replaceListeners: ((ad: { source: Source; adId: string }) => void)[] = [];
  const sightingListeners: ((sighting: AdSighting) => void)[] = [];
  const syncListeners: (() => void)[] = [];
  const pageListeners: (() => void)[] = [];
  const pageRoutes = new Map<string, JobHandler>();

  const searchRow = (id: number) => db.select().from(searches).where(eq(searches.id, id)).get();
  const seenAd = (source: Source, adId: string) =>
    db
      .select()
      .from(seenAds)
      .where(and(eq(seenAds.source, source), eq(seenAds.adId, adId)))
      .get();

  function pageRequest(search: SearchRow, category: Category, page: number) {
    const adapter = adapters[search.source];
    const result = adapter.searchPages(toSpec(search), page);
    return result.ok ? result.requests.find((r) => r.category === category) : undefined;
  }

  function asksFor(search: SearchRow, category: Category, page: number, path: string): boolean {
    return pageRequest(search, category, page)?.path === path;
  }

  function pollRequests(search: SearchRow) {
    const result = adapters[search.source].searchPages(toSpec(search), 0);
    return result.ok ? result.requests : [];
  }

  function pagePayload(search: SearchRow, category: Category, page: number): PagePayload {
    return { type: "search-page", searchId: search.id, category, page };
  }

  function pollDelay(search: SearchRow): number {
    const min = search.pollMinMinutes * MINUTE;
    const max = search.pollMaxMinutes * MINUTE;
    const stretch = pollStretch(db, problemOf, loadCrawlSettings(db), engine.caps());
    return Math.min(
      Math.round((min + random() * (max - min)) * stretch),
      MAX_POLL_MINUTES * MINUTE,
    );
  }

  function scheduleNextPoll(search: SearchRow, category: Category): void {
    const request = pageRequest(search, category, 0);
    if (request === undefined) return;
    engine.enqueue({
      kind: "poll",
      path: request.path,
      dueAt: clock() + pollDelay(search),
      payload: pagePayload(search, category, 0),
    });
  }

  function sync(): void {
    const now = clock();
    const wanted = new Map<string, PagePayload>();
    const all = db.select().from(searches).orderBy(asc(searches.id)).all().filter(crawled);
    for (const search of all) {
      for (const request of pollRequests(search)) {
        if (!wanted.has(request.path)) {
          wanted.set(request.path, pagePayload(search, request.category, 0));
        }
      }
    }

    // A Sweep's pages share the kind but have another payload, and are left alone.
    const polled = new Map(all.map((search) => [search.id, search]));
    for (const job of queuedJobs(db, "deeper-page")) {
      if (!isPagePayload(job.payload)) continue;
      const { searchId, category, page } = job.payload;
      const search = polled.get(searchId);
      if (search === undefined || !asksFor(search, category, page, job.path)) {
        removeJob(db, job.id);
      }
    }

    const have = new Set<string>();
    for (const job of queuedJobs(db, "poll")) {
      const payload = wanted.get(job.path);
      if (payload === undefined) {
        removeJob(db, job.id);
      } else if (JSON.stringify(job.payload) !== JSON.stringify(payload)) {
        removeJob(db, job.id);
        engine.enqueue({ kind: "poll", path: job.path, dueAt: job.dueAt, payload });
        have.add(job.path);
      } else {
        have.add(job.path);
      }
    }
    for (const [path, payload] of wanted) {
      if (!have.has(path)) engine.enqueue({ kind: "poll", path, dueAt: now, payload });
    }

    // A restart or a crash can lose a queued detail fetch; the Ad ID would wait forever.
    const queuedPaths = new Set(queuedJobs(db, "new-offer").map((job) => job.path));
    for (const row of db.select().from(seenAds).where(eq(seenAds.detailState, "pending")).all()) {
      const card = JSON.parse(row.card) as SearchCard;
      if (queuedPaths.has(card.path)) continue;
      engine.enqueue({
        kind: "new-offer",
        path: card.path,
        dueAt: now,
        payload: {
          type: "new-offer",
          source: row.source,
          adId: row.adId,
          category: row.category,
        } satisfies OfferPayload,
      });
    }
  }

  function syncAll(): void {
    sync();
    for (const listener of syncListeners) listener();
  }

  function problemOf(search: SourcedSpec): PollProblem | null {
    return adapters[search.source].searchPages(toSpec(search), 0).ok ? null : "unknown-city";
  }

  function crawled(search: SearchRow): boolean {
    return isCrawled({ enabled: search.enabled, problem: problemOf(search) });
  }

  function nextPollAt(search: SearchRow): number | null {
    const paths = new Set(pollRequests(search).map((r) => r.path));
    const due = queuedJobs(db, "poll")
      .filter((job) => paths.has(job.path))
      .map((job) => job.dueAt);
    return due.length === 0 ? null : Math.min(...due);
  }

  function crawlNow(search: SearchRow): CrawlNowResult {
    if (!search.enabled) return { ok: false, reason: "disabled" };
    const requests = pollRequests(search);
    if (requests.length === 0) return { ok: false, reason: "unknown-city" };

    const now = clock();
    for (const request of requests) {
      engine.enqueue({
        kind: "poll",
        path: request.path,
        dueAt: now,
        payload: pagePayload(search, request.category, 0),
      });
    }
    const next = engine.nextRequest();
    return { ok: true, queued: requests.length, runsAt: next.at, waiting: next.waitingFor };
  }

  type Sighting = { fresh: boolean; bumped: boolean };

  /**
   * The Source ignores the ceiling it is sent and cards show warm rent, so fetching these would
   * spend requests on Offers the Filters hide. A per-night or missing price is never priced out.
   */
  function pricedOut(search: SearchRow, card: SearchCard): boolean {
    return (
      search.priceCeiling !== null &&
      card.rent?.unit === "month" &&
      card.rent.amount > search.priceCeiling
    );
  }

  function takeCard(
    search: SearchRow,
    category: Category,
    card: SearchCard,
    now: number,
  ): Sighting {
    const window: PublishWindow | undefined = card.online && publishWindow(card.online, now);
    const known = seenAd(search.source, card.adId);
    const cardJson = JSON.stringify(card);

    if (known === undefined) {
      const tooOld = window !== undefined && olderThan(window, STALE_AFTER_DAYS, now);
      db.insert(seenAds)
        .values({
          source: search.source,
          adId: card.adId,
          firstSeenAt: new Date(now),
          lastSeenAt: new Date(now),
          category,
          onlineEarliest: window ? new Date(window.earliest) : null,
          onlineLatest: window ? new Date(window.latest) : null,
          card: cardJson,
          detailState: firstDetailState({ tooOld, pricedOut: pricedOut(search, card) }),
        })
        .run();
      if (!tooOld && !pricedOut(search, card)) queueDetailFetch(search, category, card, 0);
      return { fresh: true, bumped: false };
    }

    const before: PublishWindow | undefined =
      known.onlineEarliest && known.onlineLatest
        ? {
            earliest: known.onlineEarliest.getTime(),
            latest: known.onlineLatest.getTime(),
            unit: known.onlineLatest.getTime() - known.onlineEarliest.getTime(),
          }
        : undefined;
    const bumped = window !== undefined && before !== undefined && wasBumped(before, window);
    // A card that only aged keeps the window it had; a Bump starts a new one.
    const keep = !bumped && before !== undefined ? before : window;
    const fresh = window !== undefined && !olderThan(window, STALE_AFTER_DAYS, now);
    const retry = wantsRefetch(known.detailState, {
      bumped,
      fresh,
      pricedOut: pricedOut(search, card),
    });

    db.update(seenAds)
      .set({
        lastSeenAt: new Date(now),
        card: cardJson,
        onlineEarliest: keep ? new Date(keep.earliest) : null,
        onlineLatest: keep ? new Date(keep.latest) : null,
        ...(retry && requeued),
      })
      .where(and(eq(seenAds.source, search.source), eq(seenAds.adId, card.adId)))
      .run();
    if (retry) queueDetailFetch(search, category, card, 0);
    const sighting: AdSighting = {
      source: search.source,
      adId: card.adId,
      card,
      bumped,
      lastBumpAt: keep ? keep.latest : null,
    };
    for (const listener of sightingListeners) {
      try {
        listener(sighting);
      } catch (err) {
        // The card is stored; a broken next stage must not stop the poll.
        console.error(`Sighting listener failed: ${err instanceof Error ? err.name : "error"}`);
      }
    }
    return { fresh: false, bumped };
  }

  function queueDetailFetch(
    search: SearchRow,
    category: Category,
    card: SearchCard,
    delayMs: number,
  ): void {
    const payload: OfferPayload = {
      type: "new-offer",
      source: search.source,
      adId: card.adId,
      category,
    };
    engine.enqueue({ kind: "new-offer", path: card.path, dueAt: clock() + delayMs, payload });
  }

  function sharing(category: Category, page: number, path: string): SearchRow[] {
    return db
      .select()
      .from(searches)
      .where(eq(searches.enabled, true))
      .all()
      .filter((search) => asksFor(search, category, page, path));
  }

  /**
   * The match recorded for every Search reading this URL is what makes an Offer Tracked. The caller
   * has made sure `search` still asks for `path`.
   */
  function takeCards(
    search: SearchRow,
    category: Category,
    page: number,
    path: string,
    cards: SearchCard[],
    now: number,
  ): Sighting[] {
    const matching = sharing(category, page, path);
    return db.$client.transaction(() =>
      cards.map((card) => {
        for (const match of matching) {
          db.insert(searchMatches)
            .values({
              searchId: match.id,
              source: match.source,
              adId: card.adId,
              lastSeenAt: new Date(now),
            })
            .onConflictDoUpdate({
              target: [searchMatches.searchId, searchMatches.source, searchMatches.adId],
              set: { lastSeenAt: new Date(now), missingAt: null },
            })
            .run();
        }
        return takeCard(search, category, card, now);
      }),
    )();
  }

  function handleSearchPage(
    job: Job,
    response: SourceResponse | undefined,
  ): HandlerResult | undefined {
    if (!isPagePayload(job.payload)) return undefined;
    const { searchId, category, page } = job.payload;
    const search = searchRow(searchId);
    if (search === undefined || !crawled(search)) return undefined;
    if (page === 0) scheduleNextPoll(search, category);
    // An edit while the request was on its way made the Search ask for other results, or for
    // none in this category: the page is not what it matches now, so nothing is taken from it.
    if (!asksFor(search, category, page, job.path)) return undefined;

    if (response === undefined || response.status >= 400) return undefined;
    // A redirect is not followed: a results page that does not come back as one is unexpected.
    if (response.status >= 300) return { unexpectedPage: true };

    const adapter = adapters[search.source];
    const parsed = adapter.parseSearchPage(response.body);
    if (parsed.outcome === "unexpected") return { unexpectedPage: true };

    const now = clock();
    const sightings = takeCards(search, category, page, job.path, parsed.cards, now);
    const somethingNew = sightings.some((s) => s.fresh || s.bumped);

    if (somethingNew && page + 1 < MAX_POLL_PAGES) {
      const next = pageRequest(search, category, page + 1);
      if (next !== undefined) {
        engine.enqueue({
          kind: "deeper-page",
          path: next.path,
          payload: pagePayload(search, category, page + 1),
        });
      }
    }
    return undefined;
  }

  function retryDetail(source: Source, payload: OfferPayload, path: string): void {
    const row = seenAd(source, payload.adId);
    if (row === undefined || row.detailState !== "pending") return;
    const next = afterFailedFetch(row.detailAttempts);
    db.update(seenAds)
      .set(next)
      .where(and(eq(seenAds.source, source), eq(seenAds.adId, payload.adId)))
      .run();
    if (next.detailState === "pending") {
      engine.enqueue({
        kind: "new-offer",
        path,
        dueAt: clock() + next.detailAttempts * RETRY_MINUTES * MINUTE,
        payload,
      });
    }
  }

  function handleNewOffer(
    job: Job,
    response: SourceResponse | undefined,
  ): HandlerResult | undefined {
    if (!isOfferPayload(job.payload)) return undefined;
    // A detail fetch belongs to the Ad ID, not to the Search that found it: the Search may be gone.
    const payload = job.payload;
    const source = payload.source;
    const row = seenAd(source, payload.adId);
    // A page that is stored is read again by a Recheck, never from here.
    if (row === undefined || row.detailState === "fetched") return undefined;

    if (response === undefined || response.status < 200 || response.status >= 300) {
      retryDetail(source, payload, job.path);
      return undefined;
    }

    const parsed = adapters[source].parseOffer(response.body, {
      firstSeen: row.firstSeenAt,
      category: payload.category,
    });
    if (parsed.outcome === "unexpected") {
      retryDetail(source, payload, job.path);
      return { unexpectedPage: true };
    }

    const fetchedAt = clock();
    storePage({
      source,
      adId: payload.adId,
      html: response.body,
      deleted: parsed.status === "deleted",
      fetchedAt,
    });

    const offer: FetchedOffer = {
      source,
      adId: payload.adId,
      fetchedAt,
      card: JSON.parse(row.card) as SearchCard,
      parsed,
    };
    publishFetched(offer);
    return undefined;
  }

  function storePage(page: Parameters<typeof storeFetchedPage>[1]): void {
    storeFetchedPage(
      {
        db,
        snapshots,
        beforeReplace: (ad) => {
          for (const listener of replaceListeners) listener(ad);
        },
      },
      page,
    );
  }

  function publishFetched(offer: FetchedOffer): void {
    for (const listener of listeners) {
      try {
        listener(offer);
      } catch (err) {
        // The page is stored; a broken next stage must not stop the crawl.
        console.error(`Offer listener failed: ${err instanceof Error ? err.name : "error"}`);
      }
    }
  }

  function afterPage<T>(result: T): T {
    for (const listener of pageListeners) {
      try {
        listener();
      } catch (err) {
        console.error(`Page listener failed: ${err instanceof Error ? err.name : "error"}`);
      }
    }
    return result;
  }

  engine.on("poll", (job, response) => afterPage(handleSearchPage(job, response)));
  engine.on("deeper-page", async (job, response) => {
    const type = (job.payload as { type?: unknown } | undefined)?.type;
    const route = typeof type === "string" ? pageRoutes.get(type) : undefined;
    const result = await (route ?? handleSearchPage)(job, response);
    return afterPage(result);
  });
  engine.on("new-offer", handleNewOffer);
  // Polls and deeper pages are not put back here: the next sync does that.
  engine.onHandlerFailed((job) => {
    if (job.kind !== "new-offer" || !isOfferPayload(job.payload)) return;
    retryDetail(job.payload.source, job.payload, job.path);
  });
  // A Bot-checked job never queued its follow-ups; without this a Search goes unpolled until boot.
  engine.onDropped(() => syncAll());

  return {
    sync: syncAll,
    pageRequest,
    takeCards,
    storeFetchedPage: storePage,
    publishFetched,
    crawlNow,
    problemOf,
    isCrawled: crawled,
    nextPollAt,
    onOfferFetched(listener: (offer: FetchedOffer) => void): void {
      listeners.push(listener);
    },
    beforePageReplaced(listener: (ad: { source: Source; adId: string }) => void): void {
      replaceListeners.push(listener);
    },
    onSync(listener: () => void): void {
      syncListeners.push(listener);
    },
    onPageHandled(listener: () => void): void {
      pageListeners.push(listener);
    },
    routePages(type: string, handler: JobHandler): void {
      pageRoutes.set(type, handler);
    },
    onAdSeen(listener: (sighting: AdSighting) => void): void {
      sightingListeners.push(listener);
    },
  };
}
