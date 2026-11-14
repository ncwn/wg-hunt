import type { CardOnline, OnlineAge } from "../../source/source.js";

export const clean = (text: string): string => text.replace(/\s+/g, " ").trim();

/** "n.a." means the Advertiser gave no value. It is never 0. */
export const isNotAvailable = (text: string): boolean => /^n\.?\s?a\.?$/i.test(clean(text));

/** "375€", "1.100 €", "375,50€", "2010" (the Kaution sometimes has no €) -> euros. */
export function parseEuros(text: string): number | undefined {
  const cleaned = clean(text).replace(/€|EUR/gi, "").trim();
  if (!/^\d{1,3}(\.\d{3})+(,\d+)?$|^\d+(,\d+)?$/.test(cleaned)) return undefined;
  return Number(cleaned.replace(/\./g, "").replace(",", "."));
}

export function parseNumber(text: string): number | undefined {
  const match = clean(text).match(/^(\d+(?:,\d+)?)\s*(?:m²|qm)?$/i);
  return match?.[1] ? Number(match[1].replace(",", ".")) : undefined;
}

export function parseDate(text: string): string | undefined {
  const match = clean(text).match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!match) return undefined;
  const [, day = "", month = "", year = ""] = match;
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso
    ? undefined
    : iso;
}

const MONTHS = [
  "januar",
  "februar",
  "märz",
  "april",
  "mai",
  "juni",
  "juli",
  "august",
  "september",
  "oktober",
  "november",
  "dezember",
];

export function parseMonth(text: string): string | undefined {
  const match = clean(text).match(/^(\p{L}+)\s+(\d{4})$/u);
  const month = MONTHS.indexOf((match?.[1] ?? "").toLowerCase());
  return match && month >= 0 ? `${match[2]}-${String(month + 1).padStart(2, "0")}` : undefined;
}

const MINUTES_PER_UNIT: [RegExp, number][] = [
  [/^(?:minuten?|min\.?)$/i, 1],
  [/^(?:stunden?|std\.?)$/i, 60],
  [/^(?:tagen?|tage|t\.?)$/i, 60 * 24],
];

/** "22 Minuten", "1 Stunde", "4 Tage" or a date like "04.09.2026". */
export function parseOnlineWithUnit(text: string): CardOnline | undefined {
  const date = parseDate(text);
  if (date) return { age: { kind: "date", date }, unitMinutes: 60 * 24 };
  const match = clean(text).match(/^(\d+)\s*(\p{L}+\.?)$/u);
  if (!match?.[1] || !match[2]) return undefined;
  const unit = MINUTES_PER_UNIT.find(([pattern]) => pattern.test(match[2] ?? ""));
  return unit
    ? { age: { kind: "relative", minutes: Number(match[1]) * unit[1] }, unitMinutes: unit[1] }
    : undefined;
}

export function parseOnline(text: string): OnlineAge | undefined {
  return parseOnlineWithUnit(text)?.age;
}

/** "YYYY-MM-DD". */
export function berlinDay(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

const CITY_PREFIXES = new Set(["bad", "sankt", "st."]);
const CITY_JOINERS = new Set(["am", "im", "an", "bei", "vor", "unter"]);

/**
 * "Frankfurt am Main Nordend" -> city "Frankfurt am Main", district "Nordend". The address line is
 * "<PLZ> <city> <district>" with no separator, so a city of several words is recognised by its
 * shape: a prefix (Bad, Sankt), a joiner and its name (am Main, im Breisgau, ob der Tauber) or a
 * bracketed suffix (Halle (Saale)). A city name of another shape would leave part of it in the
 * district.
 */
export function splitCityAndDistrict(text: string): { city: string; district: string } {
  const words = clean(text).split(" ");
  let end = CITY_PREFIXES.has((words[0] ?? "").toLowerCase()) ? 2 : 1;
  for (;;) {
    const word = (words[end] ?? "").toLowerCase();
    if (word.startsWith("(")) {
      const close = words.findIndex((w, i) => i >= end && w.endsWith(")"));
      if (close < 0) break;
      end = close + 1;
    } else if (
      ["ob", "an", "in", "vor"].includes(word) &&
      words[end + 1]?.toLowerCase() === "der"
    ) {
      end += 3;
    } else if (CITY_JOINERS.has(word)) {
      end += 2;
    } else break;
  }
  return { city: words.slice(0, end).join(" "), district: words.slice(end).join(" ") };
}

export const round2 = (value: number): number => Math.round(value * 100) / 100;
