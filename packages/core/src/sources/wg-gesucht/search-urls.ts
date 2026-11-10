import type { Category, RentType } from "../../searches.js";
import type { SearchPageRequests, SearchSpec } from "../../source/source.js";

/** Slug in the URL path and the number in its category segment. */
const CATEGORY_URLS: Record<Category, { slug: string; number: number }> = {
  "flatshare-room": { slug: "wg-zimmer", number: 0 },
  "one-room-flat": { slug: "1-zimmer-wohnungen", number: 1 },
  flat: { slug: "wohnungen", number: 2 },
  house: { slug: "haeuser", number: 3 },
};

/** Search pages number rent types 2 / 1 / 3. Offer pages number them 0 / 1 / 2: not the same. */
const RENT_TYPE_NUMBERS: Record<RentType, number> = { unlimited: 2, limited: 1, overnight: 3 };

/**
 * The Source's ids for the larger German cities, read from the live site's own city autocomplete
 * on 2026-11-06. `name` is the city as the Source spells it in URLs, the same as `citySlug`
 * gives (the site redirects any other spelling to it, because the id alone decides the city).
 * Any other city needs the id on the Search: it is the first number after the city name in the
 * Source's own search URLs.
 */
export const KNOWN_CITIES: { name: string; id: string }[] = [
  { name: "Berlin", id: "8" },
  { name: "Hamburg", id: "55" },
  { name: "Muenchen", id: "90" },
  { name: "Koeln", id: "73" },
  { name: "Frankfurt-am-Main", id: "41" },
  { name: "Stuttgart", id: "124" },
  { name: "Duesseldorf", id: "30" },
  { name: "Leipzig", id: "77" },
  { name: "Dresden", id: "27" },
  { name: "Hannover", id: "57" },
  { name: "Nuernberg", id: "96" },
  { name: "Bremen", id: "17" },
  { name: "Heidelberg", id: "59" },
  { name: "Freiburg-im-Breisgau", id: "43" },
  { name: "Muenster", id: "91" },
  { name: "Aachen", id: "1" },
  { name: "Goettingen", id: "49" },
  { name: "Karlsruhe", id: "68" },
  { name: "Mannheim", id: "85" },
  { name: "Bonn", id: "13" },
  { name: "Darmstadt", id: "23" },
];

/** `sin` is "new offers since": 1 is the last 3 days, 2 the last week. */
const sinceOf = (recencyDays: number) => (recencyDays <= 3 ? 1 : 2);

const SLUG_LETTERS: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss" };

function citySlug(city: string): string {
  return city
    .trim()
    .replace(/[äöüß]/gi, (letter) => {
      const written = SLUG_LETTERS[letter.toLowerCase()] ?? letter;
      return letter === letter.toLowerCase()
        ? written
        : written.replace(/^./, (c) => c.toUpperCase());
    })
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resolveCity(search: SearchSpec): { slug: string; id: string } | undefined {
  const slug = citySlug(search.city);
  if (slug === "") return undefined;
  if (search.cityId !== null) {
    return /^\d{1,6}$/.test(search.cityId) ? { slug, id: search.cityId } : undefined;
  }
  const known = KNOWN_CITIES.find((city) => city.name.toLowerCase() === slug.toLowerCase());
  return known && { slug: known.name, id: known.id };
}

export function searchPages(search: SearchSpec, page: number): SearchPageRequests {
  const city = resolveCity(search);
  if (!city) return { ok: false, reason: "unknown-city" };

  const requests = search.categories.map((category) => {
    const { slug, number } = CATEGORY_URLS[category];
    const query = new URLSearchParams();
    if (page === 0) query.append("offer_filter", "1");
    query.append("city_id", city.id);
    query.append("noDeact", "1");
    query.append("categories[]", String(number));
    if (search.rentTypes.length < Object.keys(RENT_TYPE_NUMBERS).length) {
      for (const rentType of search.rentTypes) {
        query.append("rent_types[]", String(RENT_TYPE_NUMBERS[rentType]));
      }
    }
    query.append("sin", String(sinceOf(search.recencyDays)));
    if (search.priceCeiling !== null) query.append("rMax", String(search.priceCeiling));
    return {
      category,
      path: `/${slug}-in-${city.slug}.${city.id}.${number}.1.${page}.html?${query}`,
    };
  });
  return { ok: true, requests };
}
