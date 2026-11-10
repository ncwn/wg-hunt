import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
// The release version is the root package.json's; the server package has none of its own.
import release from "../../../package.json" with { type: "json" };
import { type AnalysisOptions, createAnalysis } from "./analysis/worker.js";
import type { ApiModule } from "./api/context.js";
import { createApp } from "./app.js";
import { type Config, DATABASE_FILE, findProjectRoot, TOKEN_FILE } from "./config.js";
import { loadCookieJar, saveCookieJar } from "./crawl/cookie-jar.js";
import { createCrawlEngine } from "./crawl/engine.js";
import { createSourceFetcher, createUndiciTransport, type SourceFetcher } from "./crawl/fetcher.js";
import { createRawPageCheck, createRawPageStore } from "./crawl/raw-pages.js";
import { createRechecks } from "./crawl/rechecks.js";
import { createSearchPolling } from "./crawl/search-polls.js";
import { createSnapshotStore } from "./crawl/snapshots.js";
import { SOURCE_ADAPTERS } from "./crawl/sources.js";
import { createSweeps } from "./crawl/sweeps.js";
import { openDatabase } from "./db/index.js";
import { createEventBus } from "./events.js";
import { catchUpReadout, startCatchUp } from "./offers/catch-up.js";
import { createOffers } from "./offers/offers.js";
import { isAdTracked } from "./offers/tracked.js";
import { freeDiskBytes } from "./retention/data-folder.js";
import { createRetention } from "./retention/index.js";
import { createSessions } from "./sessions.js";
import { openAccessToken } from "./token.js";

export type Runtime = ReturnType<typeof startRuntime>;

/** A model call in flight has already been paid for. */
const SHUTDOWN_ANALYSIS_WAIT_MS = 30_000;

/**
 * The data folder holds the access token, the Seeker Profile and every Offer: private to this
 * user, whatever the permissions were when it was made.
 */
function keepDataFolderPrivate(dataDir: string): void {
  chmodSync(dataDir, 0o700);
  for (const name of [DATABASE_FILE, `${DATABASE_FILE}-wal`, `${DATABASE_FILE}-shm`, TOKEN_FILE]) {
    const file = join(dataDir, name);
    if (existsSync(file)) chmodSync(file, 0o600);
  }
}

export function startRuntime(
  config: Config,
  projectRoot = findProjectRoot(process.cwd()),
  extraModules: ApiModule[] = [],
  /** The only way out to the Source. */
  fetcher?: SourceFetcher,
  /** Epoch milliseconds. */
  clock: () => number = Date.now,
  /** Uniform in [0, 1). */
  random: () => number = Math.random,
  analysisOptions?: AnalysisOptions,
  freeBytes: () => number | null = () => freeDiskBytes(config.dataDir),
) {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  // Before the database is opened, so a file made by this start is never readable by others.
  chmodSync(config.dataDir, 0o700);
  const db = openDatabase(join(config.dataDir, DATABASE_FILE));
  const token = openAccessToken(join(config.dataDir, TOKEN_FILE));
  keepDataFolderPrivate(config.dataDir);
  const sessions = createSessions({ db, token, clock });
  const events = createEventBus();
  const crawl = createCrawlEngine({
    db,
    fetcher:
      fetcher ??
      createSourceFetcher({
        transport: createUndiciTransport(),
        jar: loadCookieJar(db),
        onCookies: (jar) => saveCookieJar(db, jar, clock()),
        clock,
      }),
    clock,
    random,
    events,
    saveRawPage: createRawPageStore(config.dataDir),
    rawPageExists: createRawPageCheck(config.dataDir),
    freeBytes,
  });
  const snapshots = createSnapshotStore(config.dataDir);
  const polling = createSearchPolling({
    db,
    engine: crawl,
    adapters: SOURCE_ADAPTERS,
    snapshots,
    clock,
    random,
  });
  const sweeps = createSweeps({
    db,
    engine: crawl,
    adapters: SOURCE_ADAPTERS,
    polling,
    clock,
    random,
  });
  const rechecks = createRechecks({
    db,
    engine: crawl,
    adapters: SOURCE_ADAPTERS,
    polling,
    isTracked: (source, adId) => isAdTracked(db, source, adId),
    clock,
  });
  const offers = createOffers({ db, adapters: SOURCE_ADAPTERS, snapshots, clock, events });
  const analysis = createAnalysis({
    db,
    offers,
    adapters: SOURCE_ADAPTERS,
    snapshots,
    clock,
    events,
    ...(analysisOptions && { options: analysisOptions }),
  });
  const retention = createRetention({
    db,
    dataDir: config.dataDir,
    clock,
    crawl,
    polling,
    freeBytes,
    onWipe: () => {
      analysis.batch.interruptRuns();
      // What the catch-up counted is deleted too.
      catchUp.forget();
    },
    // Held in memory, so it is this start's even when the database would not take it.
    catchUp: () => catchUpReadout(catchUp.record()),
  });
  // A finished Sweep may have changed which Offers are Tracked, so every Offer is ranked again.
  sweeps.onFinished(() => offers.rebandAll());
  offers.onIngested((result) => analysis.ingested(result));
  polling.beforePageReplaced((ad) => offers.reparseIfOutdated(ad));
  polling.onOfferFetched((fetched) => offers.ingest(fetched));
  polling.onAdSeen((sighting) => {
    if (offers.noteSighting(sighting).returning) {
      rechecks.queueReturning(sighting.source, sighting.adId);
    }
  });
  const catchUp = startCatchUp({ db, clock, offers });
  // The queue is persisted; this only adds what a restart or an edit made while stopped left out.
  polling.sync();
  analysis.start();
  const app = createApp(
    {
      db,
      crawl,
      polling,
      rechecks,
      offers,
      analysis,
      retention,
      clock,
      events,
      token,
      sessions,
      version: release.version,
      projectRoot,
      dashboardDir: config.dashboardDir,
    },
    extraModules,
  );
  return {
    app,
    db,
    get token() {
      return token.current();
    },
    crawl,
    polling,
    sweeps,
    rechecks,
    offers,
    analysis,
    retention,
    snapshots,
    events,
    /** Never rejects. */
    catchUp: catchUp.done,
    shutdown: async () => {
      retention.stop();
      offers.stop();
      catchUp.stop();
      analysis.stop();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const patience = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_ANALYSIS_WAIT_MS);
      });
      await Promise.all([
        crawl.stop(),
        Promise.race([analysis.idle().catch(() => {}), patience]),
        catchUp.done,
      ]);
      clearTimeout(timer);
      db.$client.close();
    },
    close: () => {
      retention.stop();
      offers.stop();
      catchUp.stop();
      analysis.stop();
      db.$client.close();
    },
  };
}
