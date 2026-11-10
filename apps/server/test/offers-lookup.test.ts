import { describe, expect, it } from "vitest";
import { bootOffers } from "./offers-harness.js";

async function crawledOffer() {
  const h = bootOffers();
  h.site.cards = h.freshCards([9000001]);
  await h.addSearch();
  await h.crawl();
  const id = (await h.json("GET", "/offers")).body.items[0].id as number;
  return { h, id };
}

const lookup = (h: Awaited<ReturnType<typeof crawledOffer>>["h"], query: string) =>
  h.json("GET", `/offers/lookup?${query}`);

describe("GET /offers/lookup", () => {
  it("resolves a pasted Offer URL to the Offer", async () => {
    const { h, id } = await crawledOffer();
    const pasted = encodeURIComponent(
      "https://www.wg-gesucht.de/wg-zimmer-in-Berlin-Mitte.9000001.html?utm=share",
    );
    const { status, body } = await lookup(h, `url=${pasted}`);
    expect(status).toBe(200);
    expect(body.id).toBe(id);
    expect(body).toEqual((await h.json("GET", `/offers/${id}`)).body);
  });

  it("resolves a bare Ad ID, on wg-gesucht unless a Source is named", async () => {
    const { h, id } = await crawledOffer();
    expect((await lookup(h, "adId=9000001")).body.id).toBe(id);
    expect((await lookup(h, "source=wg-gesucht&adId=9000001")).body.id).toBe(id);
    expect((await lookup(h, "adId=%209000001%20")).body.id).toBe(id);
  });

  it("answers not-known for an Ad ID wg-hunt has never seen", async () => {
    const { h } = await crawledOffer();
    const byId = await lookup(h, "adId=1234567");
    expect(byId.status).toBe(404);
    expect(byId.body).toMatchObject({ type: "not-known", status: 404 });

    const byUrl = await lookup(
      h,
      `url=${encodeURIComponent("https://www.wg-gesucht.de/wg-zimmer-in-Berlin.1234567.html")}`,
    );
    expect(byUrl.status).toBe(404);
    expect(byUrl.body.type).toBe("not-known");
  });

  it("does not take an Ad ID that was seen on a card but never stored for an Offer", async () => {
    const h = bootOffers();
    // Already older than 7 days: the card is remembered but its page is never fetched.
    h.site.cards = [{ id: 9000009, age: "20.10.2026" }];
    await h.addSearch();
    await h.crawl();
    expect((await lookup(h, "adId=9000009")).body.type).toBe("not-known");
  });

  it("asks for exactly one of url and adId", async () => {
    const { h } = await crawledOffer();
    for (const query of ["", "url=https%3A%2F%2Fwww.wg-gesucht.de%2Fa.9000001.html&adId=9000001"]) {
      const { status, body } = await lookup(h, query);
      expect(status, query).toBe(400);
      expect(body.type).toBe("validation-error");
    }
  });

  it("explains a URL that is not an Offer page, and an Ad ID that is not a number", async () => {
    const { h } = await crawledOffer();
    const url = await lookup(
      h,
      `url=${encodeURIComponent("https://example.com/room.9000001.html")}`,
    );
    expect(url.status).toBe(400);
    expect(url.body.errors).toEqual([{ path: "url", message: expect.any(String) }]);

    const adId = await lookup(h, "adId=abc");
    expect(adId.status).toBe(400);
    expect(adId.body.errors).toEqual([{ path: "adId", message: expect.any(String) }]);
  });
});
