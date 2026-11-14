import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { queuedJobs } from "../src/crawl/queue.js";
import { MAX_POLL_PAGES } from "../src/crawl/search-polls.js";
import { crawlJobs, searches } from "../src/db/schema.js";
import { HOUR, MINUTE, MORNING, pollingHarness } from "./polling-harness.js";

const offerPath = (id: number) => `/wg-zimmer-in-Teststadt-Mitte.${id}.html`;

describe("a poll", () => {
  it("fetches page 1 of an enabled Search, then the detail page of every organic card", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    h.serve(search, (page) => (page === 0 ? h.cards([9000001, 9000002, 9000003]) : []));

    await h.drive(MORNING + 10 * MINUTE);

    expect(h.sent).toEqual([
      h.searchPath(search, 0),
      offerPath(9000001),
      offerPath(9000002),
      offerPath(9000003),
      h.searchPath(search, 1),
    ]);
  });

  it("never fetches a Promoted placement, whatever its position", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    h.serve(search, (page) =>
      page === 0
        ? [{ id: 5000001, promoted: true }, ...h.cards([9000001]), { id: 5000002, promoted: true }]
        : [],
    );

    await h.drive(MORNING + 10 * MINUTE);

    expect(h.sent).toContain(offerPath(9000001));
    expect(h.sent.some((path) => path.includes("5000001") || path.includes("5000002"))).toBe(false);
    expect(h.seen().map((ad) => ad.adId)).toEqual(["9000001"]);
  });

  it("polls each category of the Search on its own page", async () => {
    const h = pollingHarness();
    const search = h.addSearch({ categories: ["flatshare-room", "flat"] });
    h.polling.sync();
    h.serve(search, () => []);

    await h.drive(MORNING + 10 * MINUTE);

    expect(h.sent).toEqual([h.searchPath(search, 0, 0), h.searchPath(search, 0, 1)]);
  });

  it("queues the next poll a random time inside the Search's own interval", async () => {
    const h = pollingHarness();
    const search = h.addSearch({ pollMinMinutes: 45, pollMaxMinutes: 50 });
    h.polling.sync();
    h.serve(search, () => []);

    await h.drive(MORNING + 5 * MINUTE);

    const [next] = queuedJobs(h.db, "poll");
    expect(next?.path).toBe(h.searchPath(search));
    const wait = (next?.dueAt ?? 0) - MORNING;
    expect(wait).toBeGreaterThanOrEqual(45 * MINUTE);
    expect(wait).toBeLessThanOrEqual(50 * MINUTE + MINUTE);
  });

  it("polls again when the interval has passed", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    h.serve(search, () => []);

    await h.drive(MORNING + 2 * HOUR);

    const polls = h.sent.filter((path) => path === h.searchPath(search));
    expect(polls.length).toBeGreaterThanOrEqual(2);
    expect(polls.length).toBeLessThanOrEqual(4);
  });

  it("does not poll a Search that is disabled", async () => {
    const h = pollingHarness();
    h.addSearch({ enabled: false });
    h.polling.sync();

    await h.drive(MORNING + HOUR);

    expect(h.sent).toEqual([]);
  });
});

describe("keeping the queue in step with the Searches", () => {
  it("drops the later pages of a poll when its Search is switched off, but keeps the detail fetches", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    h.serve(search, (page) => (page === 0 ? h.cards([9000001]) : []));
    await h.engine.step();
    expect(queuedJobs(h.db, "deeper-page")).toHaveLength(1);

    h.db.update(searches).set({ enabled: false }).where(eq(searches.id, search.id)).run();
    h.polling.sync();

    expect(queuedJobs(h.db, "deeper-page")).toEqual([]);
    expect(queuedJobs(h.db, "poll")).toEqual([]);
    expect(queuedJobs(h.db, "new-offer")).toHaveLength(1);
  });

  it("drops the later pages of a poll when the Source can no longer build its Search's requests", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    h.serve(search, (page) => (page === 0 ? h.cards([9000001]) : []));
    await h.engine.step();
    expect(queuedJobs(h.db, "deeper-page")).toHaveLength(1);

    // Still enabled, but edited to a city the adapter has no id for: it is no longer crawled.
    h.db.update(searches).set({ city: "Teststadt" }).where(eq(searches.id, search.id)).run();
    h.polling.sync();

    expect(queuedJobs(h.db, "deeper-page")).toEqual([]);
    expect(queuedJobs(h.db, "poll")).toEqual([]);
    expect(queuedJobs(h.db, "new-offer")).toHaveLength(1);
  });

  it("takes nothing from a page that comes back after its Search stopped being crawled", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    h.serve(search, (page) => (page === 0 ? h.cards([9000001]) : []));
    h.db.update(searches).set({ city: "Teststadt" }).where(eq(searches.id, search.id)).run();

    await h.drive(MORNING + 10 * MINUTE);

    expect(h.sent).toEqual([h.searchPath(search, 0)]);
    expect(h.seen()).toEqual([]);
  });

  it("queues a detail fetch again that a crash or an old queue lost", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    h.serve(search, (page) => (page === 0 ? h.cards([9000001]) : []));
    await h.engine.step();
    for (const job of queuedJobs(h.db, "new-offer"))
      h.db.delete(crawlJobs).where(eq(crawlJobs.id, job.id)).run();

    h.polling.sync();

    expect(queuedJobs(h.db, "new-offer").map((job) => job.path)).toEqual([offerPath(9000001)]);
  });

  it("leaves a poll that is already waiting alone", async () => {
    const h = pollingHarness();
    h.addSearch();
    h.polling.sync();
    const [before] = queuedJobs(h.db, "poll");
    h.clock.now += 10 * MINUTE;

    h.polling.sync();

    const after = queuedJobs(h.db, "poll");
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before?.id);
    expect(after[0]?.dueAt).toBe(before?.dueAt);
  });
});

describe("how far a poll goes", () => {
  it("goes on while a page has something new and stops at the first page with nothing", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    // Pages 1 and 2 are new; page 3 shows only Ad IDs page 2 already had (drift).
    const published = MORNING - 10 * MINUTE;
    h.serve(search, (page) => {
      if (page === 0) return h.cards([9000001, 9000002, 9000003], published);
      if (page === 1) return h.cards([9000004, 9000005, 9000006], published);
      return h.cards([9000005, 9000006], published);
    });

    await h.drive(MORNING + 20 * MINUTE);

    expect(h.sent.filter((path) => path.includes("in-Berlin"))).toEqual(
      [0, 1, 2].map((page) => h.searchPath(search, page)),
    );
    expect(h.seen()).toHaveLength(6);
  });

  it("stops after page 1 on a later poll that finds nothing new", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    const published = MORNING - 10 * MINUTE;
    h.serve(search, (page) => (page === 0 ? h.cards([9000001, 9000002, 9000003], published) : []));
    await h.drive(MORNING + 10 * MINUTE);
    h.sent.length = 0;

    await h.drive(MORNING + 2 * HOUR);

    expect(h.sent.length).toBeGreaterThan(0);
    expect(h.sent.every((path) => path === h.searchPath(search, 0))).toBe(true);
  });

  it("goes on past a page whose Ad IDs are all known but one was Bumped", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    const published = MORNING - 8 * HOUR;
    h.serve(search, (page) => (page === 0 ? h.cards([9000001, 9000002], published) : []));
    await h.drive(MORNING + 10 * MINUTE);
    h.sent.length = 0;

    const bumpedAt = MORNING + 45 * MINUTE;
    h.serve(search, (page) => {
      if (page === 0) return [...h.cards([9000001], bumpedAt), ...h.cards([9000002], published)];
      return h.cards([9000002], published);
    });
    await h.drive(MORNING + 2 * HOUR);

    expect(h.sent).toContain(h.searchPath(search, 1));
    expect(h.sent).not.toContain(h.searchPath(search, 2));
    expect(h.sent.some((path) => path.includes("9000001"))).toBe(false);
  });

  it(`never goes past ${MAX_POLL_PAGES} pages, however much is new`, async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    h.serve(search, (page) => h.cards([9000000 + page * 10, 9000001 + page * 10]));

    await h.drive(MORNING + 40 * MINUTE);

    const fetched = [...Array(20).keys()].filter((page) =>
      h.sent.includes(h.searchPath(search, page)),
    );
    expect(fetched).toEqual([0, 1, 2, 3, 4]);
  });

  it("ends at a page with no organic cards: the normal end of results, not a stop", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    h.serve(search, (page) =>
      page === 0 ? h.cards([9000001]) : [{ id: 5000001, promoted: true }],
    );

    await h.drive(MORNING + 20 * MINUTE);

    expect(h.sent.filter((path) => path.includes("in-Berlin"))).toEqual([
      h.searchPath(search, 0),
      h.searchPath(search, 1),
    ]);
    expect(h.engine.status().paused).toBeNull();
    expect(h.engine.status().state).toBe("running");
  });
});
