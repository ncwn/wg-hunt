import { fakeProviders } from "@wg-hunt/core/analysis/testing";
import { afterEach } from "vitest";
import type { SourceFetcher } from "../src/crawl/fetcher.js";
import { crawlRequests } from "../src/db/schema.js";
import type { ServerEvent } from "../src/events.js";
import { type Runtime, startRuntime } from "../src/runtime.js";
import {
  adapterFixture,
  type CardSpec,
  offerHtml,
  resultsPage,
  withOwnPhotos,
} from "./fixtures/search-pages.js";
import { tempDataDir } from "./helpers.js";
import { driveCrawl, relaxCaps } from "./offers-harness.js";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** 10:00 in Berlin (winter time), inside the default active hours. */
const MORNING = Date.parse("2026-11-04T09:00:00Z");
/** Berlin winter time. */
export const berlin = (day: 4 | 5 | 6 | 7, hour: number, minute = 0) =>
  Date.parse(`2026-11-${String(day).padStart(2, "0")}T00:00:00Z`) +
  (hour - 1) * HOUR +
  minute * MINUTE;

const runtimes: Runtime[] = [];
afterEach(() => {
  for (const r of runtimes.splice(0)) r.close();
});

export function bootSweep(
  options: {
    start?: number;
    random?: () => number;
    /** Fewer than the Source's 20 give the same pages for fewer Offers. */
    pageSize?: number;
  } = {},
) {
  const pageSize = options.pageSize ?? 20;
  const dataDir = tempDataDir();
  const clock = { now: options.start ?? MORNING };
  const site = {
    listing: [] as CardSpec[],
    pages: new Map<number, string>(),
    failNext: [] as { match: RegExp; status: number }[],
    failing: [] as RegExp[],
  };
  const sent: { path: string; at: number }[] = [];
  const fetcher: SourceFetcher = {
    async fetch(path) {
      sent.push({ path, at: clock.now });
      if (site.failing.some((match) => match.test(path))) return { status: 500, body: "" };
      const failure = site.failNext.findIndex((f) => f.match.test(path));
      if (failure >= 0) {
        const [fail] = site.failNext.splice(failure, 1);
        return { status: fail?.status ?? 500, body: "" };
      }
      const search = /-in-Berlin\.\d+\.(\d+)\.\d+\.(\d+)\.html/.exec(path);
      if (search !== null) {
        const [, category, page] = search;
        const cards =
          category === "0"
            ? site.listing.slice(Number(page) * pageSize, (Number(page) + 1) * pageSize)
            : [];
        return { status: 200, body: resultsPage(cards) };
      }
      const ad = /\.(\d+)\.html$/.exec(path)?.[1];
      return {
        status: 200,
        body: withOwnPhotos(site.pages.get(Number(ad)) ?? offerHtml(), Number(ad)),
      };
    },
  };
  const runtime = startRuntime(
    { dataDir, port: 0, host: "127.0.0.1" },
    process.cwd(),
    [],
    fetcher,
    () => clock.now,
    options.random ?? (() => 0.5),
    fakeProviders(),
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
  async function json(method: string, path: string, body?: unknown) {
    const res = await call(method, path, body);
    // biome-ignore lint/suspicious/noExplicitAny: tests read the API's JSON loosely
    return { status: res.status, body: (await res.json()) as any };
  }

  async function addSearch(body: object = {}) {
    const res = await json("POST", "/searches", {
      city: "Berlin",
      categories: ["flatshare-room"],
      pollInterval: { minMinutes: 1440, maxMinutes: 1440 },
      ...body,
    });
    if (res.status !== 201) throw new Error(`could not add a Search: ${res.status}`);
    return res.body as { id: number };
  }

  /** `age` as a card shows it: "2 T." is two days. */
  const cards = (first: number, count: number, age = "2 T."): CardSpec[] =>
    Array.from({ length: count }, (_, i) => ({ id: first + i, age, title: `Zimmer ${first + i}` }));

  const crawlUntil = (until: number) => driveCrawl(runtime, clock, until);

  const requests = () =>
    runtime.db
      .select()
      .from(crawlRequests)
      .all()
      .map((r) => ({ kind: r.kind, path: r.path, at: r.at.getTime() }));

  const requestsOf = (kind: string, from = 0, to = Number.POSITIVE_INFINITY) =>
    requests().filter((r) => r.kind === kind && r.at >= from && r.at < to);

  const pageFetches = (adId: number, from = 0) =>
    sent.filter((r) => r.at >= from && r.path.endsWith(`.${adId}.html`)).length;

  const offerOf = async (adId: number) => {
    const res = await json("GET", `/offers/lookup?adId=${adId}`);
    if (res.status !== 200) throw new Error(`no Offer for ${adId}: ${res.status}`);
    return res.body;
  };

  return {
    runtime,
    clock,
    site,
    sent,
    events,
    call,
    json,
    addSearch,
    cards,
    crawlUntil,
    requests,
    requestsOf,
    pageFetches,
    offerOf,
  };
}

export { adapterFixture };
