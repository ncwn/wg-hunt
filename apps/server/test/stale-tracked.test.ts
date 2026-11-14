import { describe, expect, it } from "vitest";
import { offerAds } from "../src/db/schema.js";
import { bootOffers, HOUR } from "./offers-harness.js";

const DAY = 24 * HOUR;

async function oneOffer() {
  const h = bootOffers();
  h.site.cards = h.freshCards([9000001]);
  await h.addSearch();
  await h.crawl();
  const { items } = (await h.json("GET", "/offers")).body;
  expect(items).toHaveLength(1);
  return { h, id: items[0].id as number };
}

type Harness = Awaited<ReturnType<typeof oneOffer>>["h"];

async function searchIds(h: Harness) {
  return ((await h.json("GET", "/searches")).body.items as { id: number }[]).map((s) => s.id);
}

describe("Stale by age", () => {
  it("makes an Offer with no Bump for more than 7 days Stale, without a request", async () => {
    const { h, id } = await oneOffer();
    expect((await h.json("GET", `/offers/${id}`)).body.stale).toBe(false);

    const requests = h.sent.length;
    h.clock.now += 6 * DAY + 23 * HOUR;
    expect((await h.json("GET", `/offers/${id}`)).body.stale).toBe(false);
    h.clock.now += 2 * HOUR;
    const offer = (await h.json("GET", `/offers/${id}`)).body;
    expect(offer.stale).toBe(true);
    expect(offer.tracked).toBe(true);
    expect((await h.json("GET", "/offers?includeHidden=true")).body.items[0].stale).toBe(true);
    h.runtime.offers.tick();
    expect((await h.json("GET", "/offers")).body.items).toEqual([]);
    expect(h.sent.length).toBe(requests);
  });

  it("is Stale as soon as its page is deactivated or deleted, however recent the Bump", async () => {
    const { h, id } = await oneOffer();
    expect((await h.json("GET", `/offers/${id}`)).body.ads[0].pageStatus).toBe("active");
    h.runtime.db.update(offerAds).set({ pageStatus: "deactivated" }).run();
    expect((await h.json("GET", `/offers/${id}`)).body.stale).toBe(true);
    h.runtime.db.update(offerAds).set({ pageStatus: "deleted" }).run();
    expect((await h.json("GET", `/offers/${id}`)).body.stale).toBe(true);
  });

  it("keeps a merged Offer alive while any Ad ID is not Stale", async () => {
    const { h, id } = await oneOffer();
    const old = h.clock.now - 10 * DAY;
    h.runtime.db
      .insert(offerAds)
      .values({
        source: "wg-gesucht",
        adId: "9000002",
        offerId: id,
        path: "/x.9000002.html",
        firstSeenAt: new Date(old),
        lastBumpAt: new Date(old),
        pageStatus: "active",
      })
      .run();
    expect((await h.json("GET", `/offers/${id}`)).body.stale).toBe(false);
    h.clock.now += 8 * DAY;
    expect((await h.json("GET", `/offers/${id}`)).body.stale).toBe(true);
  });
});

describe("Tracked", () => {
  it("is Tracked while an enabled Search matches it, and Untracked when the Search is disabled", async () => {
    const { h, id } = await oneOffer();
    const [searchId] = await searchIds(h);
    expect((await h.json("GET", `/offers/${id}`)).body.tracked).toBe(true);

    await h.json("PATCH", `/searches/${searchId}`, { enabled: false });
    const offer = (await h.json("GET", `/offers/${id}`)).body;
    expect(offer.tracked).toBe(false);
    expect(offer.stale).toBe(false);
    expect(offer.pageStatus).toBe("active");
  });

  it("makes an edited Search's Offers Untracked until a Search finds them again", async () => {
    const { h, id } = await oneOffer();
    const [searchId] = await searchIds(h);

    await h.json("PATCH", `/searches/${searchId}`, { priceCeiling: 300 });
    h.site.cards = [];
    expect((await h.json("GET", `/offers/${id}`)).body.tracked).toBe(true);
    await h.crawl(2 * HOUR);
    expect((await h.json("GET", `/offers/${id}`)).body.tracked).toBe(false);

    h.site.cards = h.freshCards([9000001]);
    await h.crawl(2 * HOUR);
    expect((await h.json("GET", `/offers/${id}`)).body.tracked).toBe(true);
    expect((await h.json("GET", "/offers")).body.items).toHaveLength(1);
  });

  it("stays Tracked while any other enabled Search matches it", async () => {
    const { h, id } = await oneOffer();
    const [first] = await searchIds(h);
    await h.json("POST", "/searches", { city: "Berlin", categories: ["flatshare-room"] });
    await h.crawl(2 * HOUR);

    await h.json("PATCH", `/searches/${first}`, { enabled: false });
    expect((await h.json("GET", `/offers/${id}`)).body.tracked).toBe(true);

    const second = (await searchIds(h)).find((s) => s !== first);
    await h.json("PATCH", `/searches/${second}`, { enabled: false });
    expect((await h.json("GET", `/offers/${id}`)).body.tracked).toBe(false);
  });

  it("stops crawling an Untracked Offer", async () => {
    const { h, id } = await oneOffer();
    const [searchId] = await searchIds(h);
    await h.json("PATCH", `/searches/${searchId}`, { enabled: false });

    h.clock.now += 3 * DAY;
    const before = h.sent.length;
    await h.crawl(DAY);
    expect(h.sent.length).toBe(before);
    expect((await h.json("GET", `/offers/${id}`)).body.tracked).toBe(false);
  });
});
