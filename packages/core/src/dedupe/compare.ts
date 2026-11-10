import type { AdProfile, AdvertiserFingerprint } from "./profile.js";
import { textSimilarity } from "./text.js";

/** Square metres: an Advertiser rounds or re-measures between posts. */
const ROOM_SIZE_TOLERANCE = 1;
export const SIMILAR_TEXT = 0.7;
const NEAR_IDENTICAL_TEXT = 0.9;
export const DIFFERENT_TEXT = 0.3;
/** One name in common can be a coincidence, or a photo of the building every room of a flat shows. */
const SHARED_PHOTOS = 2;

/**
 * - `duplicate`: the same room re-posted by the same Advertiser. It collapses into one Offer.
 * - `sibling`: another room in the same flat by the same Advertiser. Linked, not merged.
 * - `cloned`: another Advertiser reusing the photos or the text. Linked, never merged.
 * - `apart`: no relation worth keeping, or too borderline to say. Kept apart.
 */
export type Relation = "duplicate" | "sibling" | "cloned" | "apart";

export type Comparison = {
  relation: Relation;
  sharedImages: number;
  /** 0 to 1; null when either text is too short to compare. */
  textSimilarity: number | null;
};

const sameAdvertiser = (a: AdvertiserFingerprint, b: AdvertiserFingerprint): boolean =>
  a.name === b.name &&
  a.avatar === b.avatar &&
  a.memberSince === b.memberSince &&
  a.companyProfile === b.companyProfile;

/**
 * A fact one side states and the other does not counts against the same flat, because a false
 * merge hides a room.
 */
function sameFlat(a: AdProfile, b: AdProfile): boolean {
  return (
    a.postalCode !== null &&
    a.postalCode === b.postalCode &&
    a.street === b.street &&
    a.flatSize === b.flatSize &&
    a.flatshareSize === b.flatshareSize &&
    a.flatmates === b.flatmates
  );
}

type PhotoEvidence = "shared" | "different" | "unknown";

function photoEvidence(a: readonly string[], b: readonly string[]): PhotoEvidence {
  if (a.length === 0 || b.length === 0) return "unknown";
  const shared = a.filter((key) => b.includes(key)).length;
  if (shared === 0) return "different";
  const needed = a.length === 1 || b.length === 1 ? 1 : SHARED_PHOTOS;
  return shared >= needed ? "shared" : "unknown";
}

/**
 * A photo key that Ad IDs of this many Offers, other than the two compared, already show is
 * common: a stock photo, or a photo of the building that every room of it shows.
 */
export const COMMON_PHOTO_OFFERS = 2;

export type PhotoIndex = ReadonlyMap<string, ReadonlySet<number>>;

/** `own` holds undefined for an Ad ID not stored yet. */
export function commonPhotos(
  keys: Iterable<string>,
  index: PhotoIndex,
  own: readonly (number | undefined)[],
): Set<string> {
  const common = new Set<string>();
  for (const key of keys) {
    const others = [...(index.get(key) ?? [])].filter((offer) => !own.includes(offer));
    if (others.length >= COMMON_PHOTO_OFFERS) common.add(key);
  }
  return common;
}

const NO_COMMON_PHOTOS: ReadonlySet<string> = new Set();

/**
 * Never a model. When unsure the answer is `apart`: a missed merge shows a room twice and a seeker
 * can merge it by hand, while a false merge hides a real room. Rent plays no part.
 */
export function compareAds(
  a: AdProfile,
  b: AdProfile,
  common: ReadonlySet<string> = NO_COMMON_PHOTOS,
): Comparison {
  const imagesOf = (ad: AdProfile) => ad.images.filter((key) => !common.has(key));
  const [aImages, bImages] = [imagesOf(a), imagesOf(b)];
  const shared = aImages.filter((key) => bImages.includes(key)).length;
  const photos = photoEvidence(aImages, bImages);
  const similarity = a.text && b.text ? textSimilarity(a.text, b.text) : null;
  const result = (relation: Relation): Comparison => ({
    relation,
    sharedImages: shared,
    textSimilarity: similarity,
  });

  if (a.category !== b.category || a.postalCode === null || a.postalCode !== b.postalCode) {
    return result("apart");
  }

  if (!sameAdvertiser(a.advertiser, b.advertiser)) {
    const copied =
      photos === "shared" || (similarity !== null && similarity >= NEAR_IDENTICAL_TEXT);
    return result(copied ? "cloned" : "apart");
  }

  if (!sameFlat(a, b)) return result("apart");

  const sizes = a.roomSize !== null && b.roomSize !== null ? [a.roomSize, b.roomSize] : null;
  const sameSize =
    sizes !== null && Math.abs((sizes[0] ?? 0) - (sizes[1] ?? 0)) <= ROOM_SIZE_TOLERANCE;
  const otherSize = sizes !== null && !sameSize;
  const company = a.advertiser.company || b.advertiser.company;
  const alike = photos === "shared" || (similarity !== null && similarity >= SIMILAR_TEXT);

  // A company reuses its template text across rooms, so only photos both show (`photoEvidence`)
  // say that two of its Ad IDs are one room.
  if (sameSize && (company ? photos === "shared" : alike)) return result("duplicate");

  const textDiffers = similarity !== null && similarity < DIFFERENT_TEXT;
  if (otherSize || (textDiffers && photos === "different")) return result("sibling");

  // A company's room of the same size, with the same template and no photo in common, is most
  // likely another room of its co-living flat.
  if (sameSize && company) return result("sibling");

  return result("apart");
}
