import { describe, expect, it } from "vitest";
import { flatHtml } from "./fixtures/search-pages.js";
import { bootOffers, HOUR, MINUTE } from "./offers-harness.js";

const adIds = (body: { items: { url: string }[] }) =>
  body.items.map((offer) => /\.(\d+)\.html$/.exec(offer.url)?.[1]);

describe("GET /offers ordering and paging", () => {
  it("lists the Offers of a later poll before those of an earlier one", async () => {
    const h = bootOffers();
    h.site.cards = h.freshCards([9000001]);
    await h.addSearch();
    await h.crawl();

    h.site.cards = h.freshCards([9000002, 9000001]);
    await h.crawl(2 * HOUR);

    expect(adIds((await h.json("GET", "/offers")).body)).toEqual(["9000002", "9000001"]);
  });

  it("pages through Offers first seen at the same instant without repeating or dropping one", async () => {
    const h = bootOffers();
    h.site.cards = h.freshCards([9000001, 9000002, 9000003, 9000004, 9000005]);
    await h.addSearch();
    await h.crawl();

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const { status, body } = await h.json("GET", `/offers?${query}`);
      expect(status).toBe(200);
      expect(body.items.length).toBeLessThanOrEqual(2);
      seen.push(...(adIds(body) as string[]));
      cursor = body.nextCursor;
      pages++;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect([...seen].sort()).toEqual(["9000001", "9000002", "9000003", "9000004", "9000005"]);
  });

  it("rejects a cursor it did not hand out", async () => {
    const h = bootOffers();
    const { status, body } = await h.json("GET", "/offers?cursor=bm90LW1pbmU");
    expect(status).toBe(400);
    expect(body.type).toBe("invalid-cursor");
  });
});

describe("GET /offers?since=", () => {
  it("returns only the Offers created after that time", async () => {
    const h = bootOffers();
    h.site.cards = h.freshCards([9000001]);
    await h.addSearch();
    await h.crawl();
    const [first] = (await h.json("GET", "/offers")).body.items;

    h.site.cards = h.freshCards([9000002, 9000001]);
    await h.crawl(2 * HOUR);

    const since = encodeURIComponent(first.createdAt);
    expect(adIds((await h.json("GET", `/offers?since=${since}`)).body)).toEqual(["9000002"]);
    expect(adIds((await h.json("GET", "/offers")).body)).toEqual(["9000002", "9000001"]);
  });

  it("does not miss an Offer whose card was seen before the client looked but whose page came after", async () => {
    const h = bootOffers();
    h.site.cards = h.freshCards([9000001]);
    await h.addSearch();
    // The poll has seen the card; the detail fetch is still waiting for its turn.
    await h.crawl(5_000);
    expect((await h.json("GET", "/offers")).body.items).toEqual([]);
    const clientLooked = encodeURIComponent(new Date(h.clock.now).toISOString());

    await h.crawl(30 * MINUTE);

    const { body } = await h.json("GET", `/offers?since=${clientLooked}`);
    expect(adIds(body)).toEqual(["9000001"]);
    const [offer] = body.items;
    expect(new Date(offer.firstSeenAt).getTime()).toBeLessThan(
      new Date(decodeURIComponent(clientLooked)).getTime(),
    );
    expect(new Date(offer.createdAt).getTime()).toBeGreaterThan(
      new Date(decodeURIComponent(clientLooked)).getTime(),
    );
  });

  it("rejects a time it cannot read", async () => {
    const h = bootOffers();
    const { status, body } = await h.json("GET", "/offers?since=yesterday");
    expect(status).toBe(400);
    expect(body.type).toBe("validation-error");
  });
});

describe("GET /offers?category=", () => {
  it("returns only the Offers of that category", async () => {
    const h = bootOffers();
    h.site.cards = h.freshCards([9000001]);
    h.site.flatCards = h.freshCards([9000002]);
    h.site.pages.set(9000002, flatHtml());
    await h.addSearch(["flatshare-room", "flat"]);
    await h.crawl(2 * HOUR);

    const all = (await h.json("GET", "/offers")).body;
    expect(all.items.map((o: { category: string }) => o.category).sort()).toEqual([
      "flat",
      "flatshare-room",
    ]);
    const flats = (await h.json("GET", "/offers?category=flat")).body;
    expect(adIds(flats)).toEqual(["9000002"]);
    expect(flats.items[0].category).toBe("flat");
    expect(adIds((await h.json("GET", "/offers?category=house")).body)).toEqual([]);
  });

  it("rejects a category that does not exist", async () => {
    const h = bootOffers();
    expect((await h.json("GET", "/offers?category=castle")).status).toBe(400);
  });
});
