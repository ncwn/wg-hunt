import { describe, expect, it } from "vitest";
import { bootOffers, HOUR, offerPageWith } from "./offers-harness.js";

type Boot = ReturnType<typeof bootOffers>;

async function threeBands(): Promise<{ h: Boot; ids: Record<string, number> }> {
  const h = bootOffers();
  h.site.cards = h.freshCards([9000001, 9000002, 9000003]);
  h.site.pages.set(9000001, offerPageWith({ title: "Cheap", warmRent: 450 }));
  h.site.pages.set(9000002, offerPageWith({ title: "Dear", warmRent: 520 }));
  h.site.pages.set(9000003, offerPageWith({ title: "Dearest", warmRent: 700 }));
  await h.addSearch();
  await h.crawl();
  const filters = (await h.json("GET", "/filters")).body;
  filters.maxRent.limit = 500;
  filters.maxRent.margin = { value: 50, unit: "absolute" };
  await h.json("PUT", "/filters", filters);
  const items = (await h.json("GET", "/offers?includeHidden=true")).body.items;
  return {
    h,
    ids: Object.fromEntries(items.map((o: { title: string; id: number }) => [o.title, o.id])),
  };
}

const counts = async (h: Boot, query = "") => (await h.json("GET", `/offers/counts${query}`)).body;
const at = (ms: number) => encodeURIComponent(new Date(ms).toISOString());

describe("GET /offers/counts", () => {
  it("counts each band as the list does", async () => {
    const { h } = await threeBands();
    const { bands } = await counts(h);
    expect(bands).toEqual({ match: 1, "near-match": 1, warned: 0, hidden: 1 });
    for (const [band, count] of Object.entries(bands)) {
      const listed = (await h.json("GET", `/offers?band=${band}`)).body.items;
      expect(listed).toHaveLength(count as number);
    }
  });

  it("counts a Dismissed Offer in Hidden, and not in the band it left", async () => {
    const { h, ids } = await threeBands();
    await h.json("PATCH", `/offers/${ids.Cheap}/marks`, { dismissed: true });
    expect((await counts(h)).bands).toEqual({ match: 0, "near-match": 1, warned: 0, hidden: 2 });
  });

  it("counts the Offers that are new since a time, Hidden ones not", async () => {
    const { h } = await threeBands();
    expect((await counts(h, `?since=${at(h.clock.now - HOUR)}`)).new).toBe(2);
    expect((await counts(h, `?since=${at(h.clock.now + HOUR)}`)).new).toBe(0);
    expect((await counts(h)).new).toBe(2);
  });

  it("counts an Offer that enters a band after `since` as new again", async () => {
    const { h, ids } = await threeBands();
    const seen = h.clock.now + HOUR;
    h.clock.now += 2 * HOUR;
    const filters = (await h.json("GET", "/filters")).body;
    filters.maxRent.limit = 600;
    await h.json("PUT", "/filters", filters);
    expect((await counts(h, `?since=${at(seen)}`)).new).toBe(1);
    expect((await h.json("GET", `/offers?since=${at(seen)}`)).body.items).toEqual([
      expect.objectContaining({ id: ids.Dear, band: "match" }),
    ]);
  });

  it("refuses a time it cannot read", async () => {
    const h = bootOffers();
    const res = await h.json("GET", "/offers/counts?since=yesterday");
    expect(res.status).toBe(400);
    expect(res.body.type).toBe("validation-error");
  });
});
