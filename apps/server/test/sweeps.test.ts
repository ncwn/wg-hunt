import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { defaultCrawlSettings, saveCrawlSettings } from "../src/crawl/settings.js";
import { crawlJobs, offerAds, offers, seenAds } from "../src/db/schema.js";
import { relaxCaps } from "./offers-harness.js";
import { adapterFixture, berlin, bootSweep, DAY, HOUR, MINUTE } from "./sweep-harness.js";

async function settled(count: number, random?: () => number) {
  const h = bootSweep({ pageSize: 5, ...(random !== undefined && { random }) });
  h.site.listing = h.cards(9001000, count);
  const search = await h.addSearch();
  await h.crawlUntil(berlin(4, 23));
  expect((await h.json("GET", "/offers")).body.items).toHaveLength(count);
  return { h, search };
}

const pageNumbers = (requests: { path: string }[]) =>
  requests.map((r) => Number(/\.1\.(\d+)\.html/.exec(r.path)?.[1])).sort((a, b) => a - b);

describe("the daily Sweep", () => {
  it("reads every page of the window at deeper-page priority, once a day", async () => {
    const { h } = await settled(12);
    const settledAt = h.clock.now;
    expect(h.requestsOf("deeper-page", settledAt, berlin(5, 7))).toEqual([]);

    await h.crawlUntil(berlin(5, 12));
    const sweep = h.requestsOf("deeper-page", settledAt, berlin(5, 12));
    // Three pages of results and the empty page that ends them.
    expect(pageNumbers(sweep)).toEqual([0, 1, 2, 3]);
    for (const request of sweep) {
      expect(request.path).toContain("noDeact=1");
      expect(request.path).toContain("sin=2");
    }
    expect(h.requestsOf("stale-confirmation")).toEqual([]);

    await h.crawlUntil(berlin(6, 12));
    expect(h.requestsOf("deeper-page", berlin(6, 0), berlin(6, 12))).toHaveLength(4);
  });

  it.each([
    ["at the start", 0, berlin(5, 7)],
    ["in the middle", 0.5, berlin(5, 8, 30)],
    ["at the end", 0.999, berlin(5, 9, 59)],
  ])("starts at a random time in the first 3 active hours (%s)", async (_name, draw, expected) => {
    const { h } = await settled(5, () => draw);
    const settledAt = h.clock.now;
    await h.crawlUntil(berlin(5, 12));
    const [first] = h.requestsOf("deeper-page", settledAt);
    expect(first?.at).toBeGreaterThanOrEqual(expected);
    expect(first?.at).toBeLessThan(expected + 5 * MINUTE);
  });

  it("continues the next morning when active hours or the daily cap cut it short, and judges only then", async () => {
    const { h } = await settled(12);
    h.site.listing = h.site.listing.slice(0, 11);
    h.site.pages.set(9001011, adapterFixture("deactivated"));
    const settings = defaultCrawlSettings();
    saveCrawlSettings(
      h.runtime.db,
      { ...settings, pacing: { ...settings.pacing, dailyCap: 2, sessionSize: 10_000 } },
      h.clock.now,
    );

    await h.crawlUntil(berlin(5, 23, 30));
    expect(pageNumbers(h.requestsOf("deeper-page", berlin(5, 0)))).toEqual([0, 1]);
    expect(h.pageFetches(9001011, berlin(5, 0))).toBe(0);
    expect(h.requestsOf("stale-confirmation")).toEqual([]);
    expect((await h.offerOf(9001011)).stale).toBe(false);

    // A Bot check drops the job it met: the Sweep must not be lost with it.
    h.runtime.db.delete(crawlJobs).where(eq(crawlJobs.kind, "deeper-page")).run();

    relaxCaps(h.runtime, h.clock.now);
    await h.crawlUntil(berlin(6, 12));
    expect(pageNumbers(h.requestsOf("deeper-page", berlin(6, 0), berlin(6, 12)))).toEqual([2, 3]);
    expect(h.pageFetches(9001011, berlin(6, 0))).toBe(1);
    expect(h.requestsOf("stale-confirmation", berlin(6, 0))).toHaveLength(1);
    const offer = await h.offerOf(9001011);
    expect(offer.stale).toBe(true);
    expect(offer.pageStatus).toBe("deactivated");
  });

  it("refreshes a card's age and fields from pages the polls never read", async () => {
    const { h } = await settled(12);
    const before = (await h.offerOf(9001010)).lastBumpAt as string;
    h.site.listing[10] = {
      id: 9001010,
      age: "10 Min.",
      title: "Zimmer 9001010, frisch eingestellt",
    };

    await h.crawlUntil(berlin(5, 12));

    const offer = await h.offerOf(9001010);
    expect(new Date(offer.lastBumpAt).getTime()).toBeGreaterThan(new Date(before).getTime() + DAY);
    const stored = h.runtime.db.select().from(offers).where(eq(offers.id, offer.id)).get();
    expect(JSON.parse(stored?.card ?? "{}").title).toBe("Zimmer 9001010, frisch eingestellt");
  });

  it("does not start a Sweep for a disabled Search", async () => {
    const { h, search } = await settled(5);
    await h.json("PATCH", `/searches/${search.id}`, { enabled: false });
    const settledAt = h.clock.now;
    await h.crawlUntil(berlin(5, 12));
    expect(h.requestsOf("deeper-page", settledAt)).toEqual([]);
    expect(h.requestsOf("poll", settledAt)).toEqual([]);
  });

  it("drops a Sweep in progress when its Search is disabled", async () => {
    const { h, search } = await settled(12);
    const settings = defaultCrawlSettings();
    saveCrawlSettings(
      h.runtime.db,
      { ...settings, pacing: { ...settings.pacing, dailyCap: 1 } },
      h.clock.now,
    );
    await h.crawlUntil(berlin(5, 23, 30));
    expect(h.requestsOf("deeper-page", berlin(5, 0))).toHaveLength(1);

    await h.json("PATCH", `/searches/${search.id}`, { enabled: false });
    relaxCaps(h.runtime, h.clock.now);
    await h.crawlUntil(berlin(6, 12));
    expect(h.requestsOf("deeper-page", berlin(5, 23, 30))).toEqual([]);
  });

  it("keeps an edited Search's Offers Tracked while its backfill runs, instead of waiting for tomorrow", async () => {
    const { h, search } = await settled(7);
    await h.json("PATCH", `/searches/${search.id}`, { priceCeiling: 900 });
    expect((await h.offerOf(9001000)).tracked).toBe(true);
    expect((await h.offerOf(9001006)).tracked).toBe(true);

    const edited = h.clock.now;
    await h.crawlUntil(edited + 2 * HOUR);

    expect(pageNumbers(h.requestsOf("deeper-page", edited))).toEqual([0, 1, 2]);
    expect((await h.offerOf(9001000)).tracked).toBe(true);
    expect((await h.offerOf(9001006)).tracked).toBe(true);
    expect(h.requestsOf("stale-confirmation")).toEqual([]);
  });

  it("drops only the matches the backfill did not see, without asking the Source about them", async () => {
    const { h, search } = await settled(7);
    h.site.listing = h.site.listing.slice(0, 5);
    await h.json("PATCH", `/searches/${search.id}`, { priceCeiling: 400 });
    const edited = h.clock.now;
    expect((await h.offerOf(9001006)).tracked).toBe(true);

    await h.crawlUntil(edited + 2 * HOUR);

    for (let adId = 9001000; adId < 9001005; adId++) {
      expect((await h.offerOf(adId)).tracked, String(adId)).toBe(true);
    }
    for (let adId = 9001005; adId < 9001007; adId++) {
      expect(await h.offerOf(adId), String(adId)).toMatchObject({ tracked: false, stale: false });
    }
    expect(h.requestsOf("stale-confirmation")).toEqual([]);
    expect(h.pageFetches(9001006, edited)).toBe(0);
  });

  it("drops the matches at once when the edit changes what the Search covers", async () => {
    const { h, search } = await settled(5);
    await h.json("PATCH", `/searches/${search.id}`, { rentTypes: ["limited"] });
    expect((await h.offerOf(9001000)).tracked).toBe(false);
  });
});

describe("Stale confirmation", () => {
  async function threeMissing() {
    const { h } = await settled(5);
    h.site.listing = h.site.listing.slice(0, 2);
    h.site.pages.set(9001003, adapterFixture("deactivated"));
    h.site.pages.set(9001004, adapterFixture("deleted"));
    const from = h.clock.now;
    await h.crawlUntil(berlin(5, 12));
    return { h, from };
  }

  it("fetches each missing Offer exactly once and sets the right state for each outcome", async () => {
    const { h, from } = await threeMissing();

    for (const adId of [9001002, 9001003, 9001004]) expect(h.pageFetches(adId, from)).toBe(1);
    for (const adId of [9001000, 9001001]) expect(h.pageFetches(adId, from)).toBe(0);
    expect(h.requestsOf("stale-confirmation", from)).toHaveLength(3);

    const left = await h.offerOf(9001002);
    expect(left).toMatchObject({ stale: false, tracked: false, pageStatus: "active" });
    expect(await h.offerOf(9001003)).toMatchObject({ stale: true, pageStatus: "deactivated" });
    expect(await h.offerOf(9001004)).toMatchObject({ stale: true, pageStatus: "deleted" });
    expect(await h.offerOf(9001000)).toMatchObject({ stale: false, tracked: true });
    expect(await h.offerOf(9001001)).toMatchObject({ stale: false, tracked: true });

    const next = h.clock.now;
    await h.crawlUntil(berlin(6, 12));
    expect(h.requestsOf("stale-confirmation", next)).toEqual([]);
  });

  it("does not spend a request on an Offer that is already Stale by age", async () => {
    const { h } = await settled(3);
    const old = new Date(h.clock.now - 10 * DAY);
    h.runtime.db
      .update(offerAds)
      .set({ lastBumpAt: old })
      .where(eq(offerAds.adId, "9001002"))
      .run();
    h.site.listing = h.site.listing.slice(0, 2);

    const from = h.clock.now;
    await h.crawlUntil(berlin(5, 12));

    expect(h.pageFetches(9001002, from)).toBe(0);
    expect((await h.offerOf(9001002)).stale).toBe(true);
  });

  it("drops a waiting confirmation when its Search is disabled", async () => {
    const { h, search } = await settled(3);
    h.site.listing = h.site.listing.slice(0, 2);
    const settings = defaultCrawlSettings();
    saveCrawlSettings(
      h.runtime.db,
      { ...settings, pacing: { ...settings.pacing, dailyCap: 2 } },
      h.clock.now,
    );
    await h.crawlUntil(berlin(5, 23, 30));
    expect(h.pageFetches(9001002, berlin(5, 0))).toBe(0);
    expect(
      h.runtime.db
        .select()
        .from(crawlJobs)
        .all()
        .map((j) => j.kind),
    ).toContain("stale-confirmation");

    await h.json("PATCH", `/searches/${search.id}`, { enabled: false });
    relaxCaps(h.runtime, h.clock.now);
    await h.crawlUntil(berlin(6, 12));

    expect(h.pageFetches(9001002, berlin(5, 0))).toBe(0);
    expect(h.runtime.db.select().from(crawlJobs).all()).toEqual([]);
    expect(await h.offerOf(9001002)).toMatchObject({ stale: false, tracked: false });
  });

  it("tries again later when the confirmation fetch fails", async () => {
    const { h } = await settled(3);
    h.site.listing = h.site.listing.slice(0, 2);
    h.site.pages.set(9001002, adapterFixture("deactivated"));
    h.site.failNext.push({ match: /\.9001002\.html$/, status: 503 });

    const from = h.clock.now;
    await h.crawlUntil(berlin(5, 14));

    expect(h.pageFetches(9001002, from)).toBe(2);
    expect((await h.offerOf(9001002)).stale).toBe(true);
  });

  it("asks again after a Bot check dropped the confirmation", async () => {
    const { h } = await settled(3);
    h.site.listing = h.site.listing.slice(0, 2);
    h.site.pages.set(9001002, adapterFixture("deactivated"));
    h.site.failNext.push({ match: /\.9001002\.html$/, status: 429 });

    const from = h.clock.now;
    await h.crawlUntil(berlin(5, 14));

    expect(h.requestsOf("stale-confirmation", from)).toHaveLength(2);
    expect((await h.offerOf(9001002)).stale).toBe(true);
    expect(
      h.runtime.db
        .select()
        .from(crawlJobs)
        .all()
        .map((j) => j.kind),
    ).not.toContain("stale-confirmation");
  });

  it("keeps an Offer Tracked while another Search still shows it", async () => {
    const { h, search } = await settled(3);
    // A second Search with another URL that lists the same cards.
    await h.addSearch({ priceCeiling: 900 });
    await h.crawlUntil(berlin(4, 23, 50));

    await h.json("PATCH", `/searches/${search.id}`, { enabled: false });
    expect((await h.offerOf(9001000)).tracked).toBe(true);
  });
});

describe("a Stale confirmation whose Offers step fails", () => {
  it("leaves the new page to be adopted at the next boot instead of losing it", async () => {
    const { h } = await settled(3);
    h.site.listing = h.site.listing.slice(0, 2);
    h.site.pages.set(9001002, adapterFixture("deactivated"));
    const ingest = h.runtime.offers.ingest;
    h.runtime.offers.ingest = () => {
      throw new Error("broken Offers step");
    };
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const from = h.clock.now;
    await h.crawlUntil(berlin(5, 12));
    quiet.mockRestore();
    h.runtime.offers.ingest = ingest;
    expect(h.requestsOf("stale-confirmation", from)).toHaveLength(1);
    expect((await h.offerOf(9001002)).pageStatus).toBe("active");
    const seen = h.runtime.db.select().from(seenAds).where(eq(seenAds.adId, "9001002")).get();
    expect(seen?.ingestedAt).toBeNull();

    await h.runtime.offers.adoptStoredPages();
    expect(await h.offerOf(9001002)).toMatchObject({ stale: true, pageStatus: "deactivated" });
  });
});

describe("a returning Stale Offer", () => {
  it("gets a Recheck, keeps its first-seen time, and is not reported as new", async () => {
    const { h } = await settled(5);
    h.site.listing = h.site.listing.filter((c) => c.id !== 9001003);
    h.site.pages.set(9001003, adapterFixture("deactivated"));
    await h.crawlUntil(berlin(5, 12));
    const stale = await h.offerOf(9001003);
    expect(stale.stale).toBe(true);
    const added = h.events.filter((e) => e.type === "offer-added").length;

    h.site.pages.delete(9001003);
    h.site.listing = [{ id: 9001003, age: "5 Min.", title: "Zimmer 9001003" }, ...h.site.listing];
    const from = h.clock.now;
    await h.crawlUntil(berlin(6, 14));

    const back = await h.offerOf(9001003);
    expect(back.id).toBe(stale.id);
    expect(back).toMatchObject({ stale: false, tracked: true, pageStatus: "active" });
    expect(back.firstSeenAt).toBe(stale.firstSeenAt);
    expect(back.createdAt).toBe(stale.createdAt);
    expect(h.events.filter((e) => e.type === "offer-added")).toHaveLength(added);
    expect((await h.json("GET", "/offers")).body.items).toHaveLength(5);
    expect(h.requestsOf("recheck", from).some((r) => r.path.endsWith(".9001003.html"))).toBe(true);
    expect(h.requestsOf("new-offer", from)).toEqual([]);
  });

  it("gets a Recheck when it is Bumped back after more than 7 days", async () => {
    const { h } = await settled(2);
    h.runtime.db
      .update(offerAds)
      .set({ lastBumpAt: new Date(h.clock.now - 9 * DAY) })
      .where(eq(offerAds.adId, "9001001"))
      .run();
    expect((await h.offerOf(9001001)).stale).toBe(true);

    h.site.listing = [
      { id: 9001001, age: "5 Min.", title: "Zimmer 9001001" },
      { id: 9001000, age: "2 T.", title: "Zimmer 9001000" },
    ];
    const from = h.clock.now;
    await h.crawlUntil(berlin(5, 12));

    expect((await h.offerOf(9001001)).stale).toBe(false);
    expect(h.requestsOf("recheck", from).some((r) => r.path.endsWith(".9001001.html"))).toBe(true);
    expect(h.requestsOf("new-offer", from)).toEqual([]);
    expect((await h.json("GET", "/offers")).body.items).toHaveLength(2);
  });
});
