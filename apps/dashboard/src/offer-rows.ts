import type { OfferSummary } from "./offers.js";
import { isNewOffer } from "./seen.js";
import type { OfferRowData, Reason as RowReason } from "./ui/offers.js";
import type { Band } from "./ui/status.js";

type FilterName = OfferSummary["reasons"][number]["filter"];

// Typed as a record so that a Filter added to the API fails to compile here.
const FILTER_LABELS: Record<FilterName, string> = {
  anmeldung: "Anmeldung",
  genderSought: "Gender sought",
  requirements: "Requirements",
  ageSought: "Age sought",
  moveIn: "Move-in date",
  stayAvailable: "Stay length",
  stayMinimum: "Minimum stay",
  maxRent: "Warm rent",
  minSize: "Size",
  maxRentPerSqm: "Rent per m²",
  furnished: "Furnished",
  smoking: "Smoking",
  pets: "Pets",
  flatshareTypes: "Flatshare type",
  area: "Area",
  distance: "Distance",
  languages: "Languages",
  hideLikelyScams: "Likely scam",
  flatmateAges: "Flatmate ages",
};

export const filterLabel = (filter: FilterName) => FILTER_LABELS[filter];

const BAND: Record<OfferSummary["band"], Band> = {
  match: "match",
  "near-match": "near",
  warned: "warned",
  hidden: "hidden",
};

export const rowBand = (band: OfferSummary["band"]): Band => BAND[band];

export function euros(amount: number): string {
  return `€ ${Math.round(amount).toLocaleString("en")}`;
}

export function moveInDay(day: string, now: Date = new Date()): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return day;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (date <= today) return "Now";
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

const SHOWN_IN_ROW = new Set<FilterName>(["maxRent", "minSize", "maxRentPerSqm", "distance"]);

export function rowReasons(reasons: OfferSummary["reasons"]): RowReason[] {
  return reasons
    .filter((reason) => reason.outcome !== "pass" || !SHOWN_IN_ROW.has(reason.filter))
    .map((reason) => ({
      outcome: reason.outcome,
      text: filterLabel(reason.filter),
      ...(reason.quote ? { quote: reason.quote } : {}),
    }));
}

export function toOfferRow(
  offer: OfferSummary,
  { lastSeen, now = new Date() }: { lastSeen: number | null; now?: Date },
): OfferRowData {
  const { warmRent, size, district, availableFrom } = offer.keyFacts;
  const costsIncomplete = offer.chips.some((chip) => chip.kind === "costs-incomplete");
  const converted = warmRent?.converted === true;
  return {
    id: offer.id,
    title: offer.title,
    band: rowBand(offer.band),
    isNew: isNewOffer(offer, lastSeen),
    shortlisted: offer.marks.shortlisted,
    ...(district ? { district } : {}),
    ...(warmRent ? { rent: euros(warmRent.amount) } : {}),
    ...(costsIncomplete
      ? { rentNote: "costs not stated" }
      : converted
        ? { rentNote: "from a nightly price" }
        : {}),
    ...(size !== null ? { size: `${size} m²` } : {}),
    ...(availableFrom ? { moveIn: moveInDay(availableFrom, now) } : {}),
    ...(offer.distance
      ? {
          distance: `${offer.distance.approximate ? "about " : ""}${offer.distance.km.toFixed(1)} km`,
        }
      : {}),
  };
}
