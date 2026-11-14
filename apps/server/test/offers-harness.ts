import { fakeProviders } from "@wg-hunt/core/analysis/testing";
import { afterEach } from "vitest";
import type { AnalysisOptions } from "../src/analysis/worker.js";
import type { SourceFetcher } from "../src/crawl/fetcher.js";
import { defaultCrawlSettings, saveCrawlSettings } from "../src/crawl/settings.js";
import type { ServerEvent } from "../src/events.js";
import { type Runtime, startRuntime } from "../src/runtime.js";
import {
  type CardSpec,
  offerHtml,
  offerPageWith,
  resultsPage,
  withOwnPhotos,
} from "./fixtures/search-pages.js";
import { tempDataDir } from "./helpers.js";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
/** 10:00 in Berlin (winter time), inside the default active hours. */
export const MORNING = Date.parse("2026-11-04T09:00:00Z");

const runtimes: Runtime[] = [];
afterEach(() => {
  for (const r of runtimes.splice(0)) r.close();
});

export function relaxCaps(runtime: Pick<Runtime, "db">, now: number): void {
  const defaults = defaultCrawlSettings();
  saveCrawlSettings(
    runtime.db,
    {
      ...defaults,
      pacing: { ...defaults.pacing, sessionSize: 10_000, hourlyCap: 600, dailyCap: 600 },
    },
    now,
  );
}

export async function driveCrawl(
  runtime: Pick<Runtime, "crawl">,
  clock: { now: number },
  until: number,
): Promise<void> {
  for (let i = 0; i < 10_000; i++) {
    const result = await runtime.crawl.step();
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

export function fakeSource() {
  const site = {
    cards: [] as CardSpec[],
    flatCards: [] as CardSpec[],
    pages: new Map<number, string>(),
  };
  const sent: string[] = [];
  const fetcher: SourceFetcher = {
    async fetch(path) {
      sent.push(path);
      // A search page is `<slug>-in-Berlin.<city>.<category>.<rent>.<page>.html`.
      const search = /-in-Berlin\.\d+\.(\d+)\.\d+\.(\d+)\.html/.exec(path);
      if (search !== null) {
        const [, category, page] = search;
        const cards = category === "0" ? site.cards : category === "2" ? site.flatCards : [];
        return { status: 200, body: resultsPage(page === "0" ? cards : []) };
      }
      const ad = /\.(\d+)\.html$/.exec(path)?.[1];
      return {
        status: 200,
        body: withOwnPhotos(site.pages.get(Number(ad)) ?? offerHtml(), Number(ad)),
      };
    },
  };
  return { site, sent, fetcher };
}

export { offerPageWith };

export function bootOffers(
  options: { dataDir?: string; start?: number; analysis?: AnalysisOptions } = {},
) {
  const dataDir = options.dataDir ?? tempDataDir();
  const clock = { now: options.start ?? MORNING };
  const source = fakeSource();
  const runtime = startRuntime(
    { dataDir, port: 0, host: "127.0.0.1" },
    process.cwd(),
    [],
    source.fetcher,
    () => clock.now,
    () => 0.5,
    { ...fakeProviders(), ...options.analysis },
  );
  runtimes.push(runtime);
  relaxCaps(runtime, clock.now);

  const events: ServerEvent[] = [];
  runtime.events.subscribe((event) => events.push(event));

  const call = (method: string, path: string, body?: unknown) =>
    runtime.app.request(`/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${runtime.token}`,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  async function addSearch(categories: string[] = ["flatshare-room"]) {
    const res = await call("POST", "/searches", { city: "Berlin", categories });
    if (res.status !== 201) throw new Error(`could not add a Search: ${res.status}`);
  }

  const freshCards = (ids: number[]): CardSpec[] =>
    ids.map((id) => ({ id, age: "5 Min.", title: `Zimmer ${id}` }));

  /** Half an hour covers one poll and its detail fetches. */
  const crawl = (ms = 30 * MINUTE) => driveCrawl(runtime, clock, clock.now + ms);

  async function json(method: string, path: string, body?: unknown) {
    const res = await call(method, path, body);
    // biome-ignore lint/suspicious/noExplicitAny: tests read the API's JSON loosely
    return { status: res.status, body: (await res.json()) as any };
  }

  return { runtime, clock, dataDir, ...source, call, json, addSearch, freshCards, crawl, events };
}
