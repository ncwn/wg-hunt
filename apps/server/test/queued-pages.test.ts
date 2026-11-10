import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { queuedJobs } from "../src/crawl/queue.js";
import { SOURCE_ADAPTERS } from "../src/crawl/sources.js";
import { createSweeps } from "../src/crawl/sweeps.js";
import { crawlJobs, type SearchRow, searches, searchMatches } from "../src/db/schema.js";
import { offerHtml, resultsPage } from "./fixtures/search-pages.js";
import { HOUR, MINUTE, MORNING, pollingHarness } from "./polling-harness.js";
import { berlin, bootSweep } from "./sweep-harness.js";

type Harness = ReturnType<typeof pollingHarness>;

const offerPath = (id: number) => `/wg-zimmer-in-Teststadt-Mitte.${id}.html`;
/** A results page ends in city id, category, a constant and the page number; an Offer page in its Ad ID. */
const isResultsPage = (path: string) => /(\.\d+){4}\.html/.test(path);

/** `onRequest` runs while the request is on its way. */
function serve(h: Harness, pages: Record<string, number[]>, onRequest?: (path: string) => void) {
  h.behaviour.route = (path) => {
    onRequest?.(path);
    return isResultsPage(path) ? resultsPage(h.cards(pages[path] ?? [])) : offerHtml();
  };
}

async function untilLaterPageQueued(h: Harness) {
  for (let i = 0; i < 100; i++) {
    const [job] = queuedJobs(h.db, "deeper-page");
    if (job !== undefined) return job;
    const result = await h.engine.step();
    if ("until" in result && result.until !== undefined) {
      h.clock.now = Math.max(h.clock.now, result.until);
    }
  }
  throw new Error("no later page was queued");
}

function edit(h: Harness, search: SearchRow, changes: Partial<typeof searches.$inferInsert>) {
  h.db.update(searches).set(changes).where(eq(searches.id, search.id)).run();
  h.polling.sync();
}

const matchedTo = (h: Harness, adId: number) =>
  h.db
    .select()
    .from(searchMatches)
    .where(eq(searchMatches.adId, String(adId)))
    .all()
    .map((match) => match.searchId)
    .sort();

describe("a later page a poll queued", () => {
  it("is dropped when its Search drops the category that asked for it", async () => {
    const h = pollingHarness();
    const search = h.addSearch({ categories: ["flatshare-room", "flat"] });
    h.polling.sync();
    serve(h, { [h.searchPath(search, 0, 1)]: [9000001] });
    const later = await untilLaterPageQueued(h);
    expect(later.path).toBe(h.searchPath(search, 1, 1));

    edit(h, search, { categories: ["flatshare-room"] });

    expect(queuedJobs(h.db, "deeper-page")).toEqual([]);
    await h.drive(h.clock.now + HOUR);
    expect(h.sent).not.toContain(later.path);
  });

  it.each([
    ["city", { city: "Hamburg" }],
    ["recency", { recencyDays: 3 }],
    ["price ceiling", { priceCeiling: 600 }],
  ])("is dropped when its Search's %s changes", async (_name, changes) => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    serve(h, { [h.searchPath(search, 0)]: [9000001] });
    const later = await untilLaterPageQueued(h);

    edit(h, search, changes);

    expect(queuedJobs(h.db, "deeper-page")).toEqual([]);
    await h.drive(h.clock.now + HOUR);
    expect(h.sent).not.toContain(later.path);
  });

  it("stays queued through an edit that leaves its request as it was", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    serve(h, { [h.searchPath(search, 0)]: [9000001] });
    const later = await untilLaterPageQueued(h);

    // The Source knows two windows, 3 days and a week: 5 days asks for the same page as 7.
    edit(h, search, { recencyDays: 5, pollMinMinutes: 20 });

    expect(queuedJobs(h.db, "deeper-page")).toEqual([later]);
  });

  it("gives nothing to any Search when it comes back for a category its Search dropped", async () => {
    const h = pollingHarness();
    const search = h.addSearch({ categories: ["flatshare-room", "flat"] });
    // Another Search with no request for flats either: no request is not the same request.
    const houses = h.addSearch({ city: "Hamburg", categories: ["house"] });
    h.polling.sync();
    const laterFlats = h.searchPath(search, 1, 1);
    serve(h, { [h.searchPath(search, 0, 1)]: [9000001], [laterFlats]: [9000002] }, (path) => {
      // The edit lands while the later page is on its way: no sync can drop it any more.
      if (path === laterFlats) edit(h, search, { categories: ["flatshare-room"] });
    });

    await h.drive(MORNING + 20 * MINUTE);

    expect(h.sent).toContain(laterFlats);
    expect(matchedTo(h, 9000002)).toEqual([]);
    expect(h.seenAd("9000002")).toBeUndefined();
    expect(h.sent).not.toContain(offerPath(9000002));
    expect(queuedJobs(h.db, "new-offer")).toEqual([]);
    expect(matchedTo(h, 9000001)).toEqual([search.id]);
    expect(houses.id).not.toBe(search.id);
  });

  it("gives two Searches that build the same request the match from one fetch", async () => {
    const h = pollingHarness();
    const first = h.addSearch();
    const second = h.addSearch({ pollMinMinutes: 45, pollMaxMinutes: 90 });
    h.polling.sync();
    const [page1, page2] = [h.searchPath(first, 0), h.searchPath(first, 1)];
    expect(h.searchPath(second, 1)).toBe(page2);
    serve(h, { [page1]: [9000001], [page2]: [9000002] });

    await h.drive(MORNING + 20 * MINUTE);

    expect(h.sent.filter((path) => path === page1)).toHaveLength(1);
    expect(h.sent.filter((path) => path === page2)).toHaveLength(1);
    expect(matchedTo(h, 9000001)).toEqual([first.id, second.id]);
    expect(matchedTo(h, 9000002)).toEqual([first.id, second.id]);
  });
});

describe("a poll that comes back for a request its Search no longer builds", () => {
  it("gives nothing to the Search or to those sharing its new request, and the new request is polled", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    const hamburg = h.addSearch({ city: "Hamburg" });
    h.polling.sync();
    const berlinPage = h.searchPath(search, 0);
    serve(h, { [berlinPage]: [9000001] }, (path) => {
      if (path === berlinPage) edit(h, search, { city: "Hamburg" });
    });

    await h.drive(MORNING + 20 * MINUTE);

    expect(h.seen()).toEqual([]);
    expect(matchedTo(h, 9000001)).toEqual([]);
    expect(h.sent).toEqual([berlinPage, h.searchPath(hamburg, 0)]);
    expect(queuedJobs(h.db, "poll").map((job) => job.path)).toEqual([h.searchPath(hamburg, 0)]);
  });
});

describe("a page a Sweep queued", () => {
  const sweepPages = (h: ReturnType<typeof bootSweep>) =>
    h.runtime.db
      .select()
      .from(crawlJobs)
      .where(eq(crawlJobs.kind, "deeper-page"))
      .all()
      .map((job) => (JSON.parse(job.payload ?? "{}") as { category?: string }).category);

  it("is dropped when its Search drops the category that asked for it", async () => {
    const h = bootSweep();
    const search = await h.addSearch({ categories: ["flatshare-room", "flat"] });
    expect(sweepPages(h)).toEqual(["flatshare-room", "flat"]);

    await h.json("PATCH", `/searches/${search.id}`, { categories: ["flatshare-room"] });

    expect(sweepPages(h)).toEqual(["flatshare-room"]);
    await h.crawlUntil(berlin(4, 23));
    expect(h.sent.filter((request) => request.path.includes("wohnungen-in-"))).toEqual([]);
  });

  it("gives nothing to any Search when it comes back for a category its Search dropped", async () => {
    const h = pollingHarness();
    createSweeps({
      db: h.db,
      engine: h.engine,
      adapters: SOURCE_ADAPTERS,
      polling: h.polling,
      clock: () => h.clock.now,
      random: () => 0.5,
    });
    const search = h.addSearch({ categories: ["flatshare-room", "flat"] });
    h.addSearch({ city: "Hamburg", categories: ["house"] });
    h.polling.sync();
    // The poll asks for the first page of flats, then the backfill does: the same URL, and only
    // the second answer has a card. The edit lands while that second request is on its way.
    const flats = h.searchPath(search, 0, 1);
    let asked = 0;
    h.behaviour.route = (path) => {
      if (!isResultsPage(path)) return offerHtml();
      if (path !== flats || ++asked < 2) return resultsPage([]);
      edit(h, search, { categories: ["flatshare-room"] });
      return resultsPage(h.cards([9000002]));
    };

    await h.drive(MORNING + 20 * MINUTE);

    expect(asked).toBe(2);
    expect(matchedTo(h, 9000002)).toEqual([]);
    expect(h.seenAd("9000002")).toBeUndefined();
    expect(h.sent).not.toContain(offerPath(9000002));
  });
});
