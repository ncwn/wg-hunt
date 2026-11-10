import type { Money } from "../offer-facts/values.js";
import { distanceToPlace } from "../places/offer-distance.js";
import { findPlace } from "../places/place.js";
import { type RankableOffer, type Ranking, recencyOf, type Seeking } from "./rank.js";
import { dayNumber, readFact } from "./read.js";
import { BANDS } from "./reason.js";

export const SORTS = [
  "recency",
  "warm-rent",
  "rent-per-sqm",
  "size",
  "available-from",
  "distance",
] as const;
export type Sort = (typeof SORTS)[number];

/** Numbers only, so a cursor can carry it as plain JSON. */
export type OrderKey = number[];

function sortValue(
  offer: RankableOffer,
  sort: Exclude<Sort, "recency">,
  seeking: Seeking,
  place: string | undefined,
): number | null {
  const { facts } = offer;
  switch (sort) {
    case "warm-rent": {
      const rent = readFact<Money>(facts, "warmRent");
      return rent.state === "known" ? rent.value.amount : null;
    }
    case "rent-per-sqm": {
      const rent = readFact<number>(facts, "rentPerSqm");
      return rent.state === "known" ? rent.value : null;
    }
    case "size": {
      // Biggest first.
      const size = readFact<number>(facts, "roomSize");
      return size.state === "known" ? -size.value : null;
    }
    case "available-from": {
      const from = readFact<string>(facts, "availableFrom");
      return from.state === "known" ? dayNumber(from.value) : null;
    }
    case "distance": {
      const { places } = seeking.profile;
      const chosen = place === undefined ? places[0] : findPlace(places, place);
      return chosen === undefined ? null : (distanceToPlace(facts, chosen)?.km ?? null);
    }
  }
}

export function orderKey(
  offer: RankableOffer,
  ranking: Ranking,
  sort: Sort,
  seeking: Seeking,
  place?: string,
): OrderKey {
  const band = BANDS.indexOf(ranking.band);
  const recency = -recencyOf(offer);
  if (sort === "recency") {
    return [band, ranking.band === "near-match" ? ranking.misses : 0, recency];
  }
  const value = sortValue(offer, sort, seeking, place);
  return [band, value === null ? 1 : 0, value ?? 0, recency];
}

export function compareKeys(a: OrderKey, b: OrderKey): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
