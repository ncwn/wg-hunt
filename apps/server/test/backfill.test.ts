import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { defaultCrawlSettings, saveCrawlSettings } from "../src/crawl/settings.js";
import { crawlJobs } from "../src/db/schema.js";
import { berlin, bootSweep, HOUR } from "./sweep-harness.js";

/** The poll's own deeper pages may overlap. */
const pageNumbers = (requests: { path: string }[]) =>
  [...new Set(requests.map((r) => Number(/\.1\.(\d+)\.html/.exec(r.path)?.[1])))].sort(
    (a, b) => a - b,
  );

describe("the backfill of a new or edited Search", () => {
  it("queues a walk over the whole window at deeper-page priority when a Search is created", async () => {
    const h = bootSweep();
    h.site.listing = h.cards(9002000, 45);
    await h.addSearch();

    const queued = h.runtime.db
      .select()
      .from(crawlJobs)
      .where(eq(crawlJobs.kind, "deeper-page"))
      .all();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.dueAt.getTime()).toBeLessThanOrEqual(h.clock.now);

    // It is the first morning: no daily Sweep is due yet, yet every page of the window is read.
    await h.crawlUntil(berlin(4, 23));
    const walk = h.requestsOf("deeper-page");
    // Three pages of results and the empty page that ends them.
    expect(pageNumbers(walk)).toEqual([0, 1, 2, 3]);
    expect((await h.json("GET", "/offers")).body.items).toHaveLength(45);
  });

  it("serves the backfill after polls and new Offers, so it never delays them", async () => {
    const h = bootSweep();
    h.site.listing = h.cards(9002000, 45);
    await h.addSearch();
    await h.crawlUntil(berlin(4, 23));

    const kinds = h.requests().map((r) => r.kind);
    expect(kinds[0]).toBe("poll");
    const firstDeeper = kinds.indexOf("deeper-page");
    // Everything the poll found is fetched before the backfill's next page, 20 cards at a time.
    const newOffersBefore = kinds.slice(0, firstDeeper).filter((k) => k === "new-offer").length;
    expect(newOffersBefore).toBeGreaterThanOrEqual(20);
  });

  it("walks the window again when a Search is edited, even if it matched nothing before", async () => {
    const h = bootSweep();
    const search = await h.addSearch();
    await h.crawlUntil(berlin(4, 12));
    expect(h.requestsOf("deeper-page")).toHaveLength(1);

    h.site.listing = h.cards(9002100, 25);
    await h.json("PATCH", `/searches/${search.id}`, { recencyDays: 3 });
    const edited = h.clock.now;
    await h.crawlUntil(edited + 2 * HOUR);

    expect(pageNumbers(h.requestsOf("deeper-page", edited))).toEqual([0, 1, 2]);
  });

  it("counts a Sweep already in progress as the backfill instead of queuing a second walk", async () => {
    const h = bootSweep();
    h.site.listing = h.cards(9002000, 45);
    const settings = defaultCrawlSettings();
    saveCrawlSettings(
      h.runtime.db,
      { ...settings, pacing: { ...settings.pacing, dailyCap: 3, sessionSize: 10_000 } },
      h.clock.now,
    );
    await h.addSearch();
    await h.crawlUntil(berlin(4, 22));
    const walkJobs = () =>
      h.runtime.db
        .select()
        .from(crawlJobs)
        .where(eq(crawlJobs.kind, "deeper-page"))
        .all()
        .filter((job) => JSON.parse(job.payload ?? "{}").type === "sweep-page");
    expect(walkJobs()).toHaveLength(1);
    const [before] = walkJobs();

    // Syncing again (an edit that leaves the window alone) neither restarts nor doubles it.
    await h.json("PATCH", "/searches/1", { pollInterval: { minMinutes: 60, maxMinutes: 60 } });
    expect(walkJobs().map((job) => job.id)).toEqual([before?.id]);
  });
});
