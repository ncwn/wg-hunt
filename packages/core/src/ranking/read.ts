import type { OfferFacts } from "../offer-facts/schema.js";
import { applicabilityContext, isApplicable } from "../offer-facts/schema.js";

export type Reading<T> =
  | { state: "not-applicable" }
  | { state: "unknown" }
  | { state: "known"; value: T; quote: string; doubtful: boolean };

type Loose = Record<
  string,
  { value: unknown; quote: string; confidence?: { status: string } } | undefined
>;

/** A model fact is absent until the model pass has run, so absent counts as `unknown`. */
export function readFact<T>(facts: OfferFacts, key: string): Reading<T> {
  if (!isApplicable(key, facts.category, applicabilityContext(facts))) {
    return { state: "not-applicable" };
  }
  const fact = (facts as unknown as Loose)[key];
  if (fact === undefined || fact.value === "unknown") return { state: "unknown" };
  return {
    state: "known",
    value: fact.value as T,
    quote: fact.quote,
    doubtful: fact.confidence?.status === "doubtful",
  };
}

export function applies(facts: OfferFacts, key: string): boolean {
  return isApplicable(key, facts.category, applicabilityContext(facts));
}

const DAY = 86_400_000;

/** Read as UTC so daylight saving never shifts a day. */
export function dayNumber(iso: string): number {
  return Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);
}

export function isoOf(dayNumber: number): string {
  return new Date(dayNumber * DAY).toISOString().slice(0, 10);
}

export function addMonths(iso: string, months: number): number {
  const date = new Date(`${iso}T00:00:00Z`);
  const day = date.getUTCDate();
  const target = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1);
  const last = new Date(
    Date.UTC(new Date(target).getUTCFullYear(), new Date(target).getUTCMonth() + 1, 0),
  ).getUTCDate();
  return Math.round((target + (Math.min(day, last) - 1) * DAY) / DAY);
}

export function monthsBetween(from: string, to: string): number {
  let months = 0;
  while (addMonths(from, months + 1) <= dayNumber(to)) months++;
  return months;
}

export function num(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}
