import type { OfferSummary } from "./offers.js";

export const RANGES = ["7D", "30D", "90D", "All"] as const;
export type Range = (typeof RANGES)[number];

const DAY = 86_400_000;
const RANGE_DAYS = { "7D": 7, "30D": 30, "90D": 90 } as const;
/** "All" is one point a day up to this many days, then one a week. */
const MAX_DAILY = 120;

const dayLabel = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  day: "numeric",
  month: "short",
});

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

type RentPoint = {
  /** In whole euros. */
  rent: number;
  label: string;
};

export type RentSeries = {
  points: RentPoint[];
  slots: number;
  change?: string;
};

/** The API keeps no rent history, so this is worked out from the Offers and misses Offers that have since gone. */
export function rentSeries(
  offers: OfferSummary[],
  range: Range,
  now: Date = new Date(),
): RentSeries {
  const matches = offers
    .filter((offer) => offer.band === "match" && offer.keyFacts.warmRent)
    .map((offer) => ({
      at: Date.parse(offer.createdAt),
      rent: (offer.keyFacts.warmRent as { amount: number }).amount,
    }))
    .sort((a, b) => a.at - b.at);
  if (!matches.length) return { points: [], slots: 0 };
  const end = now.getTime();
  const earliest = matches[0]?.at ?? end;
  const days =
    range === "All" ? Math.max(1, Math.ceil((end - earliest) / DAY) + 1) : RANGE_DAYS[range];
  const step = range === "All" && days > MAX_DAILY ? 7 : 1;
  const slots = Math.ceil(days / step);

  const points: RentPoint[] = [];
  let known = 0;
  for (let slot = 0; slot < slots; slot++) {
    const back = slots - 1 - slot;
    const t = end - back * step * DAY;
    while (known < matches.length && (matches[known]?.at ?? Infinity) <= t) known++;
    if (!known) continue;
    const rents = matches.slice(0, known).map((match) => match.rent);
    points.push({
      rent: Math.round(median(rents)),
      label: back === 0 ? "Today" : dayLabel.format(t),
    });
  }

  const first = points[0];
  const last = points.at(-1);
  if (points.length < 2 || !first || !last) return { points, slots };
  const diff = last.rent - first.rent;
  const sign = diff < 0 ? "−" : "+";
  const covered = Math.min(days, points.length * step);
  const span = `${covered} ${covered === 1 ? "day" : "days"}`;
  return {
    points,
    slots,
    change: diff === 0 ? `No change in ${span}` : `${sign}€ ${Math.abs(diff)} in ${span}`,
  };
}

export type OfferRentSeries = { points: number[]; labels: string[]; change: string };

export function offerRentSeries(
  history: { observedAt: string; warmRent: number }[],
  now: Date = new Date(),
): OfferRentSeries | undefined {
  const first = history[0];
  const last = history.at(-1);
  if (!first || !last) return undefined;
  const today = dayLabel.format(now);
  const label = (iso: string) => {
    const day = dayLabel.format(new Date(iso));
    return day === today ? "Today" : day;
  };
  const points = history.map((point) => point.warmRent);
  const labels = history.map((point) => label(point.observedAt));
  if (labels.at(-1) !== "Today") {
    points.push(last.warmRent);
    labels.push("Today");
  }
  const since = label(first.observedAt);
  const moved = Math.round(last.warmRent - first.warmRent);
  const change =
    moved === 0
      ? `Unchanged since ${since}`
      : `${moved > 0 ? "+" : "−"}€ ${Math.abs(moved)} since ${since}`;
  return { points, labels, change };
}
