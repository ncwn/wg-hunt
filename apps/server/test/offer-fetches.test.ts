import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_DETAIL_ATTEMPTS } from "../src/crawl/detail-fetch.js";
import { queuedJobs } from "../src/crawl/queue.js";
import type { FetchedOffer } from "../src/crawl/search-polls.js";
import { cubaPage } from "./fixtures/pages.js";
import { offerHtml, resultsPage } from "./fixtures/search-pages.js";
import { HOUR, MINUTE, MORNING, pollingHarness } from "./polling-harness.js";

const offerPath = (id: number) => `/wg-zimmer-in-Teststadt-Mitte.${id}.html`;
const DAY = 24 * HOUR;

describe("detail fetches of new Offers", () => {
  it("fetches an Ad ID once, however many Searches list it", async () => {
    const h = pollingHarness();
    const cheap = h.addSearch({ priceCeiling: 600 });
    const all = h.addSearch();
    h.polling.sync();
    const published = MORNING - 10 * MINUTE;
    h.behaviour.route = (path) => {
      if (path === h.searchPath(cheap, 0) || path === h.searchPath(all, 0)) {
        return resultsPage(h.cards([9000001], published));
      }
      if (path.includes("in-Berlin")) return resultsPage([]);
      return offerHtml();
    };

    await h.drive(MORNING + 30 * MINUTE);

    expect(h.sent.filter((path) => path === offerPath(9000001))).toHaveLength(1);
    expect(h.sent.filter((path) => path === h.searchPath(cheap, 0))).toHaveLength(1);
    expect(h.sent.filter((path) => path === h.searchPath(all, 0))).toHaveLength(1);
    expect(h.seenAd("9000001")?.detailState).toBe("fetched");
  });

  it("does not fetch an Ad ID again when a later poll sees it", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    const published = MORNING - 10 * MINUTE;
    h.serve(search, (page) => (page === 0 ? h.cards([9000001], published) : []));

    await h.drive(MORNING + 3 * HOUR);

    expect(h.sent.filter((path) => path === offerPath(9000001))).toHaveLength(1);
    expect(h.sent.filter((path) => path === h.searchPath(search, 0)).length).toBeGreaterThan(1);
  });

  it("skips a new card that is already older than 7 days, but remembers it", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    h.serve(search, (page) =>
      page === 0
        ? [
            { id: 9000001, age: "20.10.2026" },
            ...h.cards([9000002], MORNING - 3 * DAY),
            { id: 9000003, age: "28.10.2026" },
          ]
        : [],
    );

    await h.drive(MORNING + 30 * MINUTE);

    expect(h.sent).not.toContain(offerPath(9000001));
    expect(h.sent).toContain(offerPath(9000002));
    // 28 October may still be within 7 days of 4 November: not certainly old.
    expect(h.sent).toContain(offerPath(9000003));
    expect(h.seenAd("9000001")?.detailState).toBe("skipped");
  });

  it("fetches a skipped Ad ID once it is Bumped back to a fresh age", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    h.serve(search, (page) => (page === 0 ? [{ id: 9000001, age: "20.10.2026" }] : []));
    await h.drive(MORNING + 10 * MINUTE);
    expect(h.sent).not.toContain(offerPath(9000001));

    h.serve(search, (page) => (page === 0 ? h.cards([9000001], MORNING + 40 * MINUTE) : []));
    await h.drive(MORNING + 2 * HOUR);

    expect(h.sent).toContain(offerPath(9000001));
  });

  describe("a card priced over the Search's ceiling", () => {
    const priced = (h: ReturnType<typeof pollingHarness>, price: string, per = "pro Monat") =>
      h.cards([9000001]).map((spec) => ({ ...spec, price, per }));

    it("is not fetched, but remembered", async () => {
      const h = pollingHarness();
      const search = h.addSearch({ priceCeiling: 500 });
      h.polling.sync();
      h.serve(search, (page) =>
        page === 0
          ? [...priced(h, "900 €"), ...h.cards([9000002]).map((s) => ({ ...s, price: "500 €" }))]
          : [],
      );

      await h.drive(MORNING + 30 * MINUTE);

      expect(h.sent).not.toContain(offerPath(9000001));
      expect(h.sent).toContain(offerPath(9000002));
      expect(h.seenAd("9000001")?.detailState).toBe("priced-out");
    });

    it("is fetched once a later card shows a price within the ceiling", async () => {
      const h = pollingHarness();
      const search = h.addSearch({ priceCeiling: 500 });
      h.polling.sync();
      h.serve(search, (page) => (page === 0 ? priced(h, "900 €") : []));
      await h.drive(MORNING + 10 * MINUTE);
      expect(h.sent).not.toContain(offerPath(9000001));

      h.serve(search, (page) => (page === 0 ? priced(h, "480 €") : []));
      await h.drive(MORNING + 2 * HOUR);

      expect(h.sent).toContain(offerPath(9000001));
    });

    it("is fetched when another Search with a higher ceiling lists it", async () => {
      const h = pollingHarness();
      const cheap = h.addSearch({ priceCeiling: 500 });
      h.polling.sync();
      const listing = (searches: { id: number }[]) => {
        h.behaviour.route = (path) => {
          if (searches.some((search) => path === h.searchPath(search as never, 0))) {
            return resultsPage(priced(h, "900 €"));
          }
          if (path.includes("in-Berlin")) return resultsPage([]);
          return offerHtml();
        };
      };
      listing([cheap]);
      await h.drive(MORNING + 10 * MINUTE);
      expect(h.sent).not.toContain(offerPath(9000001));

      const roomy = h.addSearch({ priceCeiling: 1000 });
      h.polling.sync();
      listing([cheap, roomy]);
      await h.drive(MORNING + 2 * HOUR);

      expect(h.sent).toContain(offerPath(9000001));
    });

    it("is fetched when the Search has no ceiling, or the price is per night", async () => {
      const h = pollingHarness();
      const open = h.addSearch();
      h.polling.sync();
      h.serve(open, (page) => (page === 0 ? priced(h, "900 €") : []));
      await h.drive(MORNING + 30 * MINUTE);
      expect(h.sent).toContain(offerPath(9000001));

      const nightly = pollingHarness();
      const capped = nightly.addSearch({ priceCeiling: 50 });
      nightly.polling.sync();
      nightly.serve(capped, (page) => (page === 0 ? priced(nightly, "60 €", "pro Nacht") : []));
      await nightly.drive(MORNING + 30 * MINUTE);
      expect(nightly.sent).toContain(offerPath(9000001));
    });
  });

  it("keeps the card-only fields with the Ad ID", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    h.serve(search, (page) => (page === 0 ? h.cards([9000001]) : []));

    await h.drive(MORNING + 10 * MINUTE);

    const card = JSON.parse(h.seenAd("9000001")?.card ?? "{}");
    expect(card).toMatchObject({
      adId: "9000001",
      title: "Zimmer 9000001",
      rent: { amount: 500, unit: "month" },
      advertiser: { name: "Anna", kind: "private" },
    });
  });

  it("hands every fetched page, already read, to the next stage", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    const offers: FetchedOffer[] = [];
    h.polling.onOfferFetched((offer) => offers.push(offer));
    h.polling.sync();
    h.serve(search, (page) => (page === 0 ? h.cards([9000001]) : []));

    await h.drive(MORNING + 10 * MINUTE);

    expect(offers).toHaveLength(1);
    const [offer] = offers;
    expect(offer).toMatchObject({
      source: "wg-gesucht",
      adId: "9000001",
    });
    expect(offer?.parsed).toMatchObject({ outcome: "parsed", status: "active" });
    expect(offer?.card.advertiser.name).toBe("Anna");
  });

  it("keeps the page compressed in the data folder, and nowhere else", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    h.serve(search, (page) => (page === 0 ? h.cards([9000001, 9000002]) : []));

    await h.drive(MORNING + 10 * MINUTE);

    expect(readdirSync(join(h.dataDir, "offer-pages", "wg-gesucht")).sort()).toEqual([
      "9000001.html.gz",
      "9000002.html.gz",
    ]);
    expect(h.snapshots.read("wg-gesucht", "9000001")).toBe(offerHtml());
  });
});

describe("when a detail fetch goes wrong", () => {
  it("tries again later after a server error, then gives up after a few attempts", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    const published = MORNING - 10 * MINUTE;
    h.serve(search, (page) => (page === 0 ? h.cards([9000001], published) : []));
    const search0 = h.behaviour.route;
    h.behaviour.route = (path) =>
      path === offerPath(9000001) ? { status: 503, body: "" } : search0(path);

    await h.drive(MORNING + 6 * HOUR);

    expect(h.sent.filter((path) => path === offerPath(9000001))).toHaveLength(MAX_DETAIL_ATTEMPTS);
    expect(h.seenAd("9000001")?.detailState).toBe("failed");
    expect(h.engine.status().paused).toBeNull();
  });

  it("recovers when a retry succeeds", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    const published = MORNING - 10 * MINUTE;
    h.serve(search, (page) => (page === 0 ? h.cards([9000001], published) : []));
    const search0 = h.behaviour.route;
    let failures = 1;
    h.behaviour.route = (path) =>
      path === offerPath(9000001) && failures-- > 0 ? { status: 500, body: "" } : search0(path);

    await h.drive(MORNING + 3 * HOUR);

    expect(h.seenAd("9000001")?.detailState).toBe("fetched");
  });

  it("pauses on an Offer page it does not understand, without escalating the Cooldown", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    h.serve(search, (page) => (page === 0 ? h.cards([9000001]) : []));
    const search0 = h.behaviour.route;
    h.behaviour.route = (path) =>
      path === offerPath(9000001) ? "<html><body>Etwas ganz anderes</body></html>" : search0(path);

    await h.drive(MORNING + 10 * MINUTE);

    const status = h.engine.status();
    expect(status.state).toBe("layout-changed");
    expect(status.paused).toMatchObject({ reason: "layout-changed", cause: "unexpected-page" });
    expect(status.cooldown).toBeNull();
    expect(h.snapshots.read("wg-gesucht", "9000001")).toBeUndefined();
  });

  it("leaves the Bot check to the engine: a verification page stops everything", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    h.serve(search, (page) => (page === 0 ? h.cards([9000001]) : []));
    const search0 = h.behaviour.route;
    h.behaviour.route = (path) => (path === offerPath(9000001) ? cubaPage() : search0(path));

    await h.drive(MORNING + 10 * MINUTE);

    expect(h.engine.status().state).toBe("cooling-down");
    expect(h.snapshots.has("wg-gesucht", "9000001")).toBe(false);
  });
});

describe("a search page the adapter does not understand", () => {
  it("pauses with 'layout changed' and keeps the next poll queued", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    h.behaviour.route = () => "<html><body><h1>Wartungsarbeiten</h1></body></html>";

    await h.drive(MORNING + 10 * MINUTE);

    expect(h.engine.status()).toMatchObject({
      state: "layout-changed",
      paused: { reason: "layout-changed", cause: "unexpected-page" },
    });
    expect(h.sent).toEqual([h.searchPath(search, 0)]);
    expect(queuedJobs(h.db, "poll").map((job) => job.path)).toEqual([h.searchPath(search, 0)]);
  });

  it("treats a redirect from a search URL as unexpected, not as an empty list", async () => {
    const h = pollingHarness();
    h.addSearch();
    h.polling.sync();
    h.behaviour.route = () => ({ status: 301, body: "" });

    await h.drive(MORNING + 10 * MINUTE);

    expect(h.engine.status().state).toBe("layout-changed");
  });

  it("does not pause for a server error, and polls again later", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    h.behaviour.route = () => ({ status: 503, body: "" });

    await h.drive(MORNING + 3 * HOUR);

    expect(h.engine.status().state).toBe("running");
    expect(h.sent.filter((path) => path === h.searchPath(search, 0)).length).toBeGreaterThan(1);
  });
});

describe("after a Bot check", () => {
  it("keeps polling the Search: the dropped poll comes back and is the probe after the Cooldown", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    h.serve(search, () => []);
    const results = h.behaviour.route;
    let challenged = false;
    h.behaviour.route = (path) => {
      if (!challenged) {
        challenged = true;
        return cubaPage();
      }
      return results(path);
    };

    await h.drive(MORNING + 10 * MINUTE);
    expect(h.engine.status().state).toBe("cooling-down");
    // Nothing else would ever queue the next poll: only the poll's own handler does that.
    expect(queuedJobs(h.db, "poll").map((job) => job.path)).toEqual([h.searchPath(search, 0)]);

    await h.drive(MORNING + 3 * HOUR);
    const polls = h.sent.filter((path) => path === h.searchPath(search, 0));
    expect(polls.length).toBeGreaterThanOrEqual(2);
    expect(h.engine.status().state).toBe("running");
    expect(queuedJobs(h.db, "poll")).toHaveLength(1);
  });

  it("fetches a new Ad ID whose detail fetch it dropped, once the Cooldown is over", async () => {
    const h = pollingHarness();
    const search = h.addSearch();
    h.polling.sync();
    h.serve(search, (page) => (page === 0 ? h.cards([9000001]) : []));
    const results = h.behaviour.route;
    let challenged = false;
    h.behaviour.route = (path) => {
      if (path === offerPath(9000001) && !challenged) {
        challenged = true;
        return cubaPage();
      }
      return results(path);
    };

    await h.drive(MORNING + 10 * MINUTE);
    expect(h.engine.status().state).toBe("cooling-down");
    expect(h.seenAd("9000001")?.detailState).toBe("pending");
    expect(queuedJobs(h.db, "new-offer").map((job) => job.path)).toEqual([offerPath(9000001)]);

    await h.drive(MORNING + 3 * HOUR);
    expect(h.sent.filter((path) => path === offerPath(9000001))).toHaveLength(2);
    expect(h.seenAd("9000001")?.detailState).toBe("fetched");
  });
});
