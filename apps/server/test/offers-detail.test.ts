import { wgGesuchtSource } from "@wg-hunt/core/sources/wg-gesucht";
import { describe, expect, it } from "vitest";
import { bootOffers, offerPageWith } from "./offers-harness.js";

async function crawledOffer(page?: string) {
  const h = bootOffers();
  h.site.cards = h.freshCards([9000001]);
  if (page !== undefined) h.site.pages.set(9000001, page);
  await h.addSearch();
  await h.crawl();
  const list = await h.json("GET", "/offers");
  return { h, id: list.body.items[0].id as number };
}

describe("GET /offers/{id}", () => {
  it("returns the facts with value, origin and quote", async () => {
    const { h, id } = await crawledOffer();
    const { status, body } = await h.json("GET", `/offers/${id}`);
    expect(status).toBe(200);
    expect(body.facts.roomSize).toEqual({ value: 18, origin: "field", quote: "Zimmergröße: 18m²" });
    expect(body.facts.warmRent).toMatchObject({
      value: { amount: 489, converted: false },
      origin: "field",
    });
    expect(body.facts.deposit).toMatchObject({ value: { amount: 900 } });
    expect(body.facts.equipmentFee.value).toBe("unknown");
    expect(body.rulesVersion).toBe(wgGesuchtSource.rulesVersion);
    expect(body.analysisState).toBe("pending");
  });

  it("keeps the facts that do not apply to the category out", async () => {
    const { h, id } = await crawledOffer();
    const { body } = await h.json("GET", `/offers/${id}`);
    expect(body.facts.flatmates).toBeDefined();
    expect(body.facts.rooms).toBeUndefined();
    expect(body.facts.anmeldung).toBeUndefined();
  });

  it("returns the Ad IDs with their addresses, and the card's Advertiser", async () => {
    const { h, id } = await crawledOffer();
    const { body } = await h.json("GET", `/offers/${id}`);
    expect(body.ads).toEqual([
      {
        source: "wg-gesucht",
        adId: "9000001",
        url: "https://www.wg-gesucht.de/wg-zimmer-in-Teststadt-Mitte.9000001.html",
        firstSeenAt: expect.any(String),
        lastBumpAt: expect.any(String),
        pageStatus: "active",
        current: true,
        textHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    expect(body.advertiser).toEqual({ name: "Anna", avatarUrl: null, kind: "private" });
  });

  it("starts the price history with the rent the Offer was first seen at", async () => {
    const { h, id } = await crawledOffer();
    const { body } = await h.json("GET", `/offers/${id}`);
    expect(body.priceHistory).toEqual([
      {
        observedAt: expect.any(String),
        source: "wg-gesucht",
        adId: "9000001",
        warmRent: 489,
        converted: false,
      },
    ]);
  });

  it("answers not-found for an id that was never given out", async () => {
    const h = bootOffers();
    const { status, body } = await h.json("GET", "/offers/42");
    expect(status).toBe(404);
    expect(body.type).toBe("not-found");
  });

  it("needs the access token", async () => {
    const h = bootOffers();
    for (const path of ["/offers", "/offers/1", "/offers/lookup?adId=1"]) {
      expect((await h.runtime.app.request(`/api/v1${path}`)).status, path).toBe(401);
    }
  });
});

describe("photos", () => {
  it("are the Source's own addresses, and the server never fetches them", async () => {
    const { h, id } = await crawledOffer();
    const { body } = await h.json("GET", `/offers/${id}`);
    expect(body.photos).toHaveLength(3);
    for (const photo of body.photos) {
      expect(photo).toMatch(
        /^https:\/\/img\.wg-gesucht\.de\/media\/up\/2026\/45\/[0-9a-f]{64}_[^/]+\.large\.jpg$/,
      );
    }
    expect(h.sent.length).toBeGreaterThan(1);
    expect(h.sent.filter((path) => /\.(jpe?g|png|gif|webp)\b|img\./i.test(path))).toEqual([]);
  });

  it("leave out anything that is not a web address", async () => {
    const page = offerPageWith({ title: "Zimmer", warmRent: 400 }).replace(
      'data-large="https://img.wg-gesucht.de/media/up/2026/45/bbbb000000000000000000000000000000000000000000000000000000000001_zimmer-1.large.jpg"',
      'data-large="javascript:alert(1)"',
    );
    const { h, id } = await crawledOffer(page);
    const { body } = await h.json("GET", `/offers/${id}`);
    expect(body.photos).toHaveLength(2);
    expect(body.photos.every((url: string) => url.startsWith("https://"))).toBe(true);
  });
});
