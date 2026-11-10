import { euros, moveInDay, rowBand, rowReasons } from "./offer-rows.js";
import type { Offer } from "./offers.js";
import { categoryLabel, formatWhen } from "./searches.js";
import type { OfferCardData } from "./ui/OfferCard.js";

export function toCardOffer(offer: Offer, now: Date = new Date()): OfferCardData {
  const { warmRent, size, district, availableFrom } = offer.keyFacts;
  const costsIncomplete = offer.chips.some((chip) => chip.kind === "costs-incomplete");
  const details: { label: string; value: string }[] = [
    { label: "Posted", value: formatWhen(offer.firstSeenAt) },
    ...(offer.lastBumpAt ? [{ label: "Bumped", value: formatWhen(offer.lastBumpAt) }] : []),
    { label: "Kind", value: categoryLabel(offer.category) },
    ...(costsIncomplete ? [{ label: "Costs", value: "Not stated" }] : []),
    ...(warmRent?.converted ? [{ label: "Rent", value: "Worked out from a nightly price" }] : []),
  ];
  const reasons = rowReasons(offer.reasons);
  return {
    title: offer.title,
    band: rowBand(offer.band),
    ...(district ? { district } : {}),
    ...(warmRent ? { rent: euros(warmRent.amount) } : {}),
    ...(size !== null ? { size: `${size} m²` } : {}),
    ...(availableFrom ? { moveIn: moveInDay(availableFrom, now) } : {}),
    ...(offer.distance
      ? {
          distance: `${offer.distance.approximate ? "about " : ""}${offer.distance.km.toFixed(1)} km`,
        }
      : {}),
    ...(offer.photos.length ? { photos: offer.photos } : {}),
    ...(reasons.length ? { reasons } : {}),
    details,
    shortlisted: offer.marks.shortlisted,
    contacted: offer.marks.contacted,
    dismissed: offer.marks.dismissed,
    url: offer.url,
  };
}
