import type { Fact } from "../offer-facts/fact.js";
import type { Category } from "../searches.js";
import { defaultFilters, type FilterKey, type Filters } from "./filters.js";
import { defaultSeekerProfile, type SeekerProfile } from "./profile.js";
import type { RankableOffer, Ranking } from "./rank.js";
import { rankOffer } from "./rank.js";

export function fact<T>(value: T | "unknown", extra: Partial<Fact<T>> = {}): Fact<T> {
  return { value, origin: "text", quote: value === "unknown" ? "" : "quote", ...extra };
}

export const unknown = () => fact<never>("unknown");

export function doubtful<T>(value: T | "unknown", quote = "quote"): Fact<T> {
  return fact(value, { quote, confidence: { status: "doubtful", reasons: ["quote_not_found"] } });
}

export const DAY = 86_400_000;
export const NOW = Date.parse("2026-11-04T09:00:00Z");

export function offer(
  facts: Record<string, unknown> = {},
  extra: Partial<Omit<RankableOffer, "facts">> & { category?: Category } = {},
): RankableOffer {
  const { category = "flatshare-room", ...rest } = extra;
  return {
    facts: { category, ...facts } as RankableOffer["facts"],
    firstSeenAt: NOW,
    lastBumpAt: null,
    ...rest,
  };
}

type FilterPatch = { [K in FilterKey]?: Partial<Filters[K]> };

export function seeking(
  profile: Partial<SeekerProfile> = {},
  filters: FilterPatch = {},
): { profile: SeekerProfile; filters: Filters } {
  const base = defaultFilters();
  const merged = Object.fromEntries(
    Object.entries(base).map(([key, value]) => [
      key,
      { ...value, ...(filters as Record<string, object>)[key] },
    ]),
  ) as Filters;
  return { profile: { ...defaultSeekerProfile(), ...profile }, filters: merged };
}

export function rank(
  facts: Record<string, unknown>,
  profile: Partial<SeekerProfile> = {},
  filters: FilterPatch = {},
  extra: Parameters<typeof offer>[1] = {},
): Ranking {
  return rankOffer(offer(facts, extra), seeking(profile, filters));
}

export function reasonFor(ranking: Ranking, filter: FilterKey) {
  return ranking.reasons.find((reason) => reason.filter === filter);
}
