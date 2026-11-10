import { describe, expect, it } from "vitest";
import { type AdSpec, hash, ingestAds } from "./dedupe-harness.js";
import { bootOffers } from "./offers-harness.js";

type Harness = ReturnType<typeof bootOffers>;
type Signal = { kind: string; strength: string; evidence?: string };

const TARGET = 9000001;

function bootMarket(rents: number[]) {
  const h = bootOffers();
  const flats = rents.map(
    (warmRent, index): AdSpec => ({
      adId: 9100000 + index,
      warmRent,
      street: `Marktstraße ${index + 1}`,
      images: [hash(1000 + index * 3), hash(1001 + index * 3), hash(1002 + index * 3)],
    }),
  );
  ingestAds(h, ...flats, {
    adId: TARGET,
    warmRent: 150,
    street: "Billigweg 1",
    images: [hash(1), hash(2), hash(3)],
  });
  return h;
}

const lookup = async (h: Harness, adId: number) =>
  (await h.json("GET", `/offers/lookup?adId=${adId}`)).body;
const idOf = async (h: Harness, adId: number): Promise<number> => (await lookup(h, adId)).id;
const belowMedian = async (h: Harness): Promise<Signal | undefined> =>
  (await lookup(h, TARGET)).scam.signals.find((s: Signal) => s.kind === "rent_below_median");
const correct = async (h: Harness, adId: number, fact: string, value: unknown) => {
  const res = await h.json("PUT", `/offers/${await idOf(h, adId)}/facts/${fact}`, { value });
  expect(res.status).toBe(200);
};
const uncorrect = async (h: Harness, adId: number, fact: string) => {
  const res = await h.json("DELETE", `/offers/${await idOf(h, adId)}/facts/${fact}`);
  expect(res.status).toBe(200);
};

describe("the district baseline counts other Offers' Manual overrides", () => {
  it("takes another Offer's corrected rent per m², and its parsed one again once cleared", async () => {
    // 8 rooms at 489 € (27.17 €/m²) and 7 at 600 € (33.33 €/m²): the median is 27.17.
    const h = bootMarket([...Array(8).fill(489), ...Array(7).fill(600)]);
    expect((await belowMedian(h))?.evidence).toContain("district median €27.17/m² from 15 Offers");

    await correct(h, 9100000, "rentPerSqm", 40);
    expect((await belowMedian(h))?.evidence).toContain("district median €33.33/m² from 15 Offers");

    await uncorrect(h, 9100000, "rentPerSqm");
    expect((await belowMedian(h))?.evidence).toContain("district median €27.17/m² from 15 Offers");
  });

  it("moves another Offer out of its parsed district and into its corrected one", async () => {
    const h = bootMarket(Array(15).fill(489));
    expect(await belowMedian(h)).toBeDefined();

    await correct(h, 9100000, "district", "Mitte");
    expect(await belowMedian(h)).toBeUndefined();

    await correct(h, TARGET, "district", "Mitte");
    for (let index = 1; index < 15; index++) await correct(h, 9100000 + index, "district", "Mitte");
    expect((await belowMedian(h))?.evidence).toContain("from 15 Offers");

    await uncorrect(h, 9100000, "district");
    expect(await belowMedian(h)).toBeUndefined();
  });

  it("leaves out an Offer whose warm rent is corrected to a converted one, and back in when not", async () => {
    const h = bootMarket(Array(15).fill(489));
    expect(await belowMedian(h)).toBeDefined();

    await correct(h, 9100000, "warmRent", { amount: 489, converted: true });
    expect(await belowMedian(h)).toBeUndefined();

    await correct(h, 9100000, "warmRent", { amount: 489, converted: false });
    expect((await belowMedian(h))?.evidence).toContain("from 15 Offers");
  });
});

describe("a Cloned offer's signal reads its original's corrected facts", () => {
  it("weighs the copier against the original's corrected Mitglied seit", async () => {
    const h = bootOffers();
    ingestAds(
      h,
      { adId: 9000001, advertiser: { name: "Anna", memberSince: "Mai 2020" } },
      {
        adId: 9000002,
        advertiser: { name: "Marek", memberSince: "Oktober 2026", verified: false },
      },
    );
    const cloned = async () =>
      (await lookup(h, 9000002)).scam.signals.find((s: Signal) => s.kind === "cloned_offer");
    expect(await cloned()).toMatchObject({ strength: "strong" });

    // The original's Advertiser joined after the copier: copying is no longer strong evidence.
    await correct(h, 9000001, "memberSince", "2026-11");
    expect(await cloned()).toMatchObject({ strength: "soft" });

    await uncorrect(h, 9000001, "memberSince");
    expect(await cloned()).toMatchObject({ strength: "strong" });
  });
});
