import {
  costsCompleteOf,
  type Fact,
  type Money,
  type RuleFacts,
  rentPerSqmOf,
  roomSizeIsFlatSize,
  roomSizeOf,
} from "../../offer-facts/index.js";
import type { Category } from "../../searches.js";
import { field, unknown } from "./build.js";
import { isNotAvailable, parseEuros, parseNumber, round2 } from "./german.js";
import type { Page, Row } from "./page.js";

/** A per-night or per-day price is shown instead of a monthly one; it counts as 30 days. */
const DAYS_PER_MONTH = 30;

function findRow(page: Page, pattern: RegExp): Row | undefined {
  for (const [key, row] of page.rows) if (pattern.test(key)) return row;
  return undefined;
}

function findKeyFact(page: Page, pattern: RegExp): Row | undefined {
  for (const [key, row] of page.keyFacts) if (pattern.test(key)) return row;
  return undefined;
}

function sizeOf(row: Row | undefined): Fact<number> {
  if (!row) return unknown();
  const size = parseNumber(row.value);
  return size === undefined ? unknown(row.quote) : field(size, row.quote);
}

/**
 * A rent of 0 is a placeholder, not a price (it would rank as the cheapest room); a deposit or
 * cost of 0 is a real statement and stays.
 */
function moneyOf(row: Row | undefined, multiplier = 1, zeroIsUnknown = false): Fact<Money> {
  if (!row) return unknown();
  if (isNotAvailable(row.value)) return unknown(row.quote);
  const euros = parseEuros(row.value);
  if (euros === undefined || (zeroIsUnknown && euros === 0)) return unknown(row.quote);
  return field({ amount: round2(euros * multiplier), converted: multiplier !== 1 }, row.quote);
}

export function sizeFacts(page: Page, category: Category, wgFlatSize: Row | undefined) {
  if (!roomSizeIsFlatSize(category)) {
    return {
      roomSize: sizeOf(findKeyFact(page, /^Zimmergröße$/)),
      flatSize: sizeOf(wgFlatSize),
    } satisfies Partial<RuleFacts>;
  }
  // Größe is both the size of the home and the size of what is let, so rent per m² and a
  // room-size Filter read the same fact for every category.
  const flatSize = sizeOf(findKeyFact(page, /^Größe$/));
  return {
    flatSize,
    roomSize: roomSizeOf(flatSize),
    ...(category !== "one-room-flat" ? { rooms: sizeOf(findKeyFact(page, /^Zimmer$/)) } : {}),
  } satisfies Partial<RuleFacts>;
}

export function costFacts(page: Page, roomSize: Fact<number>) {
  const baseRow = findRow(page, /^Miete(?: pro (?:Tag|Nacht))?$/);
  const totalRow = findKeyFact(page, /^Gesamtmiete/);
  const perDay = [baseRow?.label, totalRow?.label].some((label) =>
    /pro (?:Tag|Nacht)/.test(label ?? ""),
  );
  const multiplier = perDay ? DAYS_PER_MONTH : 1;

  const utilitiesRow = findRow(page, /^Nebenkosten$/);
  const utilities = moneyOf(utilitiesRow, multiplier);
  const warmRent = moneyOf(totalRow, multiplier, true);

  return {
    baseRent: moneyOf(baseRow, multiplier, true),
    utilities,
    otherCosts: moneyOf(findRow(page, /^Sonstige Kosten$/), multiplier),
    deposit: moneyOf(findRow(page, /^Kaution$/)),
    equipmentFee: moneyOf(findRow(page, /^Ablösevereinbarung$/)),
    warmRent,
    // Without a Nebenkosten row the page has no place to give the utilities, so that is unknown.
    costsComplete: utilitiesRow ? costsCompleteOf(utilities) : unknown(),
    rentPerSqm: rentPerSqmOf(warmRent, roomSize),
  } satisfies Partial<RuleFacts>;
}
