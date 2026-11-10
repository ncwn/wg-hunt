import { offerFactsSchema } from "@wg-hunt/core";
import { describe, expect, it } from "vitest";
import { flatHtml } from "./fixtures/search-pages.js";
import { bootOffers, HOUR } from "./offers-harness.js";

/**
 * The fixture flatshare room is 489 € warm for an 18 m² room, Nebenkosten 75 €; the fixture flat
 * is 980 € warm for 64 m².
 */
const euros = (amount: number) => ({ amount, converted: false });

type Reason = { filter: string; outcome: string };
/** The API sends an Offer's facts apart from its category, which the Offer Facts schema includes. */
const isValidFacts = (body: { category: string; facts: unknown }) =>
  offerFactsSchema.safeParse({ category: body.category, ...(body.facts as object) }).success;

const reasonFor = (body: { reasons: Reason[] }, filter: string) =>
  body.reasons.find((reason) => reason.filter === filter);

async function bootWith(filters: Record<string, unknown> = {}) {
  const h = bootOffers();
  const current = (await h.json("GET", "/filters")).body;
  await h.json("PUT", "/filters", { ...current, ...filters });
  h.site.cards = h.freshCards([9000001]);
  h.site.flatCards = h.freshCards([9000002]);
  h.site.pages.set(9000002, flatHtml());
  await h.addSearch(["flatshare-room", "flat"]);
  await h.crawl(2 * HOUR);
  const items = (await h.json("GET", "/offers?includeHidden=true")).body.items as {
    id: number;
    category: string;
  }[];
  const idOf = (category: string) => {
    const item = items.find((offer) => offer.category === category);
    if (item === undefined) throw new Error(`no ${category} was crawled`);
    return item.id;
  };
  return { h, room: idOf("flatshare-room"), flat: idOf("flat") };
}

describe("a corrected input changes the facts derived from it", () => {
  it("works a flatshare room's rent per m² out again from a corrected warm rent, and re-bands it", async () => {
    const { h, room } = await bootWith({
      maxRentPerSqm: { enabled: true, strength: "dealbreaker", limit: 25, margin: null },
    });
    const before = (await h.json("GET", `/offers/${room}`)).body;
    expect(before.facts.rentPerSqm.value).toBe(27.17);
    expect(reasonFor(before, "maxRentPerSqm")?.outcome).toBe("fail");
    expect(before.band).toBe("hidden");

    const res = await h.json("PUT", `/offers/${room}/facts/warmRent`, { value: euros(400) });

    expect(res.status).toBe(200);
    expect(res.body.facts.rentPerSqm).toEqual({
      value: 22.22,
      origin: "field",
      quote: "your correction: 400 € / Zimmergröße: 18m²",
      alternatives: [
        { value: 27.17, origin: "field", quote: "Gesamtmiete: 489€ / Zimmergröße: 18m²" },
      ],
    });
    expect(reasonFor(res.body, "maxRentPerSqm")?.outcome).toBe("pass");
    expect(res.body.band).not.toBe("hidden");

    const { body } = await h.json("GET", `/offers/${room}`);
    expect(body.facts.rentPerSqm).toEqual(res.body.facts.rentPerSqm);
    expect(isValidFacts(body)).toBe(true);
  });

  it("keeps a flatshare room's size and rent per m² when only the flat size is corrected", async () => {
    const { h, room } = await bootWith();
    const before = (await h.json("GET", `/offers/${room}`)).body.facts;
    const res = await h.json("PUT", `/offers/${room}/facts/flatSize`, { value: 120 });
    expect(res.body.facts.roomSize).toEqual(before.roomSize);
    expect(res.body.facts.rentPerSqm).toEqual(before.rentPerSqm);

    const sized = await h.json("PUT", `/offers/${room}/facts/roomSize`, { value: 20 });
    expect(sized.body.facts.rentPerSqm).toMatchObject({ value: 24.45, origin: "field" });
  });

  it("makes a flat's room size follow its corrected size, for the size Filter and rent per m²", async () => {
    const { h, flat } = await bootWith({
      minSize: { enabled: true, strength: "dealbreaker", limit: 70, margin: null },
    });
    const before = (await h.json("GET", `/offers/${flat}`)).body;
    expect(reasonFor(before, "minSize")?.outcome).toBe("fail");

    const res = await h.json("PUT", `/offers/${flat}/facts/flatSize`, { value: 80 });

    expect(res.body.facts.roomSize).toMatchObject({ value: 80, origin: "field" });
    expect(res.body.facts.rentPerSqm).toMatchObject({ value: 12.25, origin: "field" });
    expect(reasonFor(res.body, "minSize")?.outcome).toBe("pass");
    expect(isValidFacts(res.body)).toBe(true);
  });

  it("drops and brings back the costs caution as the utilities are corrected", async () => {
    const { h, room } = await bootWith();
    const chipsOf = (body: { chips: { kind: string }[] }) => body.chips.map((chip) => chip.kind);
    expect(chipsOf((await h.json("GET", `/offers/${room}`)).body)).not.toContain(
      "costs-incomplete",
    );

    const unstated = await h.json("PUT", `/offers/${room}/facts/utilities`, { value: "unknown" });
    expect(unstated.body.facts.costsComplete).toMatchObject({ value: false, origin: "field" });
    expect(chipsOf(unstated.body)).toContain("costs-incomplete");

    const stated = await h.json("PUT", `/offers/${room}/facts/utilities`, { value: euros(90) });
    expect(stated.body.facts.costsComplete).toMatchObject({ value: true, origin: "field" });
    expect(chipsOf(stated.body)).not.toContain("costs-incomplete");
  });

  it("keeps a correction of the derived fact itself over what its inputs say", async () => {
    const { h, room } = await bootWith();
    await h.json("PUT", `/offers/${room}/facts/rentPerSqm`, { value: 10 });
    const res = await h.json("PUT", `/offers/${room}/facts/warmRent`, { value: euros(400) });
    expect(res.body.facts.rentPerSqm).toMatchObject({ value: 10, origin: "manual" });
  });

  it("restores the parsed derived fact exactly when the input's correction is reverted", async () => {
    const { h, room, flat } = await bootWith();
    const roomBefore = (await h.json("GET", `/offers/${room}`)).body.facts;
    await h.json("PUT", `/offers/${room}/facts/warmRent`, { value: euros(400) });
    await h.json("PUT", `/offers/${room}/facts/utilities`, { value: "unknown" });
    await h.json("DELETE", `/offers/${room}/facts/warmRent`);
    const reverted = await h.json("DELETE", `/offers/${room}/facts/utilities`);
    expect(reverted.body.facts).toEqual(roomBefore);

    const flatBefore = (await h.json("GET", `/offers/${flat}`)).body.facts;
    await h.json("PUT", `/offers/${flat}/facts/flatSize`, { value: 80 });
    expect((await h.json("DELETE", `/offers/${flat}/facts/flatSize`)).body.facts).toEqual(
      flatBefore,
    );
  });
});
