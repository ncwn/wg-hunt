import type { Category } from "../searches.js";

const BASELINE_DAYS = 30;
export const MIN_COMPARABLES = 15;

const DAY = 86_400_000;

export type RentBaseline = {
  /** Euros per m². */
  median: number;
  count: number;
  district: string;
};

export type RentSample = {
  id: number;
  category: Category;
  district: string;
  /** Warm rent per m², in euros. */
  rentPerSqm: number;
  /** Epoch milliseconds. */
  seenAt: number;
};

export function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const high = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? high : ((sorted[middle - 1] ?? 0) + high) / 2;
}

const keyOf = (category: string, district: string) =>
  `${category}|${district.trim().toLocaleLowerCase("de")}`;

export function rentBaselines(
  samples: readonly RentSample[],
  now: number,
): (offer: { id: number; category: Category; district: string | null }) => RentBaseline | null {
  const groups = new Map<string, RentSample[]>();
  for (const sample of samples) {
    if (sample.seenAt < now - BASELINE_DAYS * DAY) continue;
    const key = keyOf(sample.category, sample.district);
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  return ({ id, category, district }) => {
    if (district === null) return null;
    const others = (groups.get(keyOf(category, district)) ?? []).filter(
      (sample) => sample.id !== id,
    );
    if (others.length < MIN_COMPARABLES) return null;
    return {
      median: medianOf(others.map((sample) => sample.rentPerSqm)),
      count: others.length,
      district,
    };
  };
}
