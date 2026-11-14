import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createCrawlEngine } from "../src/crawl/engine.js";
import type { SourceFetcher } from "../src/crawl/fetcher.js";
import { createSearchPolling, toSpec } from "../src/crawl/search-polls.js";
import { defaultCrawlSettings, saveCrawlSettings } from "../src/crawl/settings.js";
import { createSnapshotStore } from "../src/crawl/snapshots.js";
import { SOURCE_ADAPTERS } from "../src/crawl/sources.js";
import { openDatabase } from "../src/db/index.js";
import { type SearchRow, searches, seenAds } from "../src/db/schema.js";
import { type CardSpec, offerHtml, resultsPage } from "./fixtures/search-pages.js";
import { tempDataDir } from "./helpers.js";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
/** 10:00 in Berlin (winter time), inside the default active hours. */
export const MORNING = Date.parse("2026-11-04T09:00:00Z");

function seeded(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Reply = string | { status: number; body: string };

export function pollingHarness(options: { start?: number } = {}) {
  const dataDir = tempDataDir();
  const db = openDatabase(join(dataDir, "test.sqlite"));
  const clock = { now: options.start ?? MORNING };
  const sent: string[] = [];
  const behaviour: { route: (path: string) => Reply } = {
    route: () => ({ status: 404, body: "" }),
  };
  const fetcher: SourceFetcher = {
    async fetch(path) {
      sent.push(path);
      const reply = behaviour.route(path);
      return typeof reply === "string" ? { status: 200, body: reply } : reply;
    },
  };

  const random = seeded(7);
  const engine = createCrawlEngine({ db, fetcher, clock: () => clock.now, random });
  const snapshots = createSnapshotStore(dataDir);
  const polling = createSearchPolling({
    db,
    engine,
    adapters: SOURCE_ADAPTERS,
    snapshots,
    clock: () => clock.now,
    random,
  });

  const defaults = defaultCrawlSettings();
  saveCrawlSettings(
    db,
    {
      ...defaults,
      pacing: { ...defaults.pacing, sessionSize: 10_000, hourlyCap: 600, dailyCap: 600 },
    },
    clock.now,
  );

  function addSearch(overrides: Partial<typeof searches.$inferInsert> = {}): SearchRow {
    return db
      .insert(searches)
      .values({
        source: "wg-gesucht",
        city: "Berlin",
        cityId: null,
        categories: ["flatshare-room"],
        rentTypes: ["unlimited", "limited", "overnight"],
        priceCeiling: null,
        recencyDays: 7,
        enabled: true,
        pollMinMinutes: 30,
        pollMaxMinutes: 60,
        createdAt: new Date(clock.now),
        updatedAt: new Date(clock.now),
        ...overrides,
      })
      .returning()
      .get();
  }

  function searchPath(search: SearchRow, page = 0, category = 0): string {
    const result = SOURCE_ADAPTERS[search.source].searchPages(toSpec(search), page);
    if (!result.ok) throw new Error(result.reason);
    const request = result.requests[category];
    if (!request) throw new Error("no such category");
    const url = new URL(request.path, "https://source.test");
    return `${url.pathname}${url.search}`;
  }

  async function drive(until: number): Promise<void> {
    for (let i = 0; i < 10_000; i++) {
      const result = await engine.step();
      if (result.state === "requested" || result.state === "skipped") continue;
      if (result.state === "busy") throw new Error("engine is busy");
      const next = result.until;
      if (next === undefined || !Number.isFinite(next) || next > until) {
        clock.now = Math.max(clock.now, until);
        return;
      }
      clock.now = Math.max(clock.now, next);
    }
    throw new Error("the crawl did not settle");
  }

  function ageText(publishedAt: number): string {
    const minutes = Math.max(0, Math.floor((clock.now - publishedAt) / MINUTE));
    if (minutes < 60) return `${minutes} Min.`;
    if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} Std.`;
    return `${Math.floor(minutes / (24 * 60))} T.`;
  }

  function cards(ids: number[], publishedAt = clock.now - 2 * MINUTE): CardSpec[] {
    return ids.map((id) => ({ id, age: ageText(publishedAt) }));
  }

  function serve(search: SearchRow, pages: (page: number) => CardSpec[], category = 0): void {
    behaviour.route = (path) => {
      for (let page = 0; page < 20; page++) {
        if (path === searchPath(search, page, category)) return resultsPage(pages(page));
      }
      return offerHtml();
    };
  }

  const seen = () => db.select().from(seenAds).all();
  const seenAd = (adId: string) => db.select().from(seenAds).where(eq(seenAds.adId, adId)).get();

  return {
    db,
    dataDir,
    clock,
    sent,
    behaviour,
    engine,
    polling,
    snapshots,
    addSearch,
    searchPath,
    drive,
    ageText,
    cards,
    serve,
    seen,
    seenAd,
  };
}
