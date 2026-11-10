import type { RuleFacts } from "../../offer-facts/index.js";
import type { RentType } from "../../searches.js";
import type { OnlineAge, ParseContext } from "../../source/source.js";
import { field, unknown } from "./build.js";
import {
  berlinDay,
  clean,
  isNotAvailable,
  parseDate,
  parseOnline,
  splitCityAndDistrict,
} from "./german.js";
import { ownText, type Page } from "./page.js";

const RENT_TYPES: Record<string, RentType> = { "0": "unlimited", "1": "limited", "2": "overnight" };

export function availabilityFacts(page: Page, ctx: ParseContext) {
  const rentType = page.scripts.match(
    /setTargeting\(\s*["']wgg_rent_type["']\s*,\s*["'](\d+)["']\s*\)/,
  );
  const rentTypeValue = RENT_TYPES[rentType?.[1] ?? ""];
  const from = page.rows.get("frei ab");
  const until = page.rows.get("frei bis");

  const facts: Partial<RuleFacts> = {};
  facts.rentType = rentTypeValue ? field(rentTypeValue, rentType?.[0] ?? "") : unknown();

  if (!from) {
    facts.availableFrom = unknown();
  } else if (/^sofort$/i.test(from.value)) {
    // "Immediately" is relative to the page, so it means the day wg-hunt first saw the Offer.
    facts.availableFrom = field(berlinDay(ctx.firstSeen), from.quote);
  } else {
    const date = isNotAvailable(from.value) ? undefined : parseDate(from.value);
    facts.availableFrom = date ? field(date, from.quote) : unknown(from.quote);
  }

  if (until) {
    const date = parseDate(until.value);
    facts.availableUntil = date ? field(date, until.quote) : unknown(until.quote);
  } else {
    // No end date in the availability block of an unlimited Offer: the block is the evidence.
    facts.availableUntil =
      rentTypeValue === "unlimited" && from ? field("none", from.quote) : unknown();
  }
  return facts;
}

export function onlineAge(page: Page): OnlineAge | undefined {
  const row = page.rows.get("Online");
  return row ? parseOnline(row.value) : undefined;
}

const COORDINATES = /"lat"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*"lng"\s*:\s*(-?\d+(?:\.\d+)?)/;
const MARKER = /\{[^{}]*"lat"[^{}]*\}/g;

/** The map config lists a marker per Offer on the page: this one and similar ones. */
function ownMarker(page: Page, adId: string | undefined) {
  if (!adId) return undefined;
  for (const [marker] of page.scripts.matchAll(MARKER)) {
    const id = marker.match(/"offer_id"\s*:\s*"?(\d+)"?/)?.[1];
    const coordinates = id === adId ? marker.match(COORDINATES) : null;
    if (coordinates) return coordinates;
  }
  return undefined;
}

export function locationFacts(page: Page, adId: string | undefined) {
  const lines = page
    .$('a[href="#map_container"] .section_panel_detail')
    .toArray()
    // The street and the place are one element each, or one element split by a line break.
    .flatMap((element) => ownText(page.$(element)).split("\n"))
    .map(clean)
    .filter((line) => line !== "");
  const place = lines.find((line) => /^\d{5}\s+\S/.test(line));
  const streetLine = lines.find((line) => line !== place);

  const facts: Partial<RuleFacts> = {};
  const parts = place?.match(/^(\d{5})\s+(.+)$/);
  facts.postalCode = parts?.[1] && place ? field(parts[1], place) : unknown();
  const split = parts?.[2] ? splitCityAndDistrict(parts[2]) : undefined;
  // An Advertiser who leaves the district empty gets the city repeated in its place.
  const district = split && split.district !== split.city ? split.district : "";
  facts.district = district && place ? field(district, place) : unknown();
  facts.street = streetLine ? field(streetLine, streetLine) : unknown();

  const coordinates = ownMarker(page, adId);
  facts.coordinates =
    coordinates?.[1] && coordinates[2]
      ? field({ lat: Number(coordinates[1]), lng: Number(coordinates[2]) }, coordinates[0])
      : unknown();
  return facts;
}
