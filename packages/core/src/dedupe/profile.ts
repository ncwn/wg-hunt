import type { Fact, Flatmates, RuleFacts } from "../offer-facts/index.js";
import type { Category } from "../searches.js";
import type { OfferText, SearchCard } from "../source/source.js";
import { type TextSignature, textSignature } from "./text.js";

/**
 * A field the Source did not show is null. Nulls match, so an Advertiser that shows nothing
 * (private, no avatar) matches another that shows nothing.
 */
export type AdvertiserFingerprint = {
  name: string | null;
  avatar: string | null;
  /** The "Mitglied seit" month, `YYYY-MM`. */
  memberSince: string | null;
  companyProfile: string | null;
  company: boolean;
};

/** Plain JSON: it is stored as such. */
export type AdProfile = {
  category: Category;
  postalCode: string | null;
  street: string | null;
  flatSize: number | null;
  roomSize: number | null;
  flatshareSize: number | null;
  /** Current flatmates by gender, `"1w2m0d0n"`; null when the page does not say. */
  flatmates: string | null;
  advertiser: AdvertiserFingerprint;
  /** An Ad ID can have photos and no keys: a generic name or a non-upload address gives none. */
  images: string[];
  /** Null when the text is too short to compare. */
  text: TextSignature | null;
};

/** An upload's address: `media/up/<year>/<week>/<64-hex hash>_<original file name>`. */
const UPLOAD = /\/([0-9a-f]{64})_([^/]+)$/i;

const uploadOf = (url: string) => UPLOAD.exec(url.split(/[?#]/)[0] ?? "");

function uploadHashOf(url: string): string | null {
  return uploadOf(url)?.[1]?.toLowerCase() ?? null;
}

const EXTENSION = /\.(?:jpe?g|png|webp|gif|heic|avif)$/;
const SIZE_SUFFIX = /\.(?:large|small|sized|medium|thumb)$/;
const MIN_PHOTO_NAME_LENGTH = 12;
/** A camera or phone timestamp, `16 22 34` or `15h59m34s`. */
const TIMESTAMP = /\d{1,2}[ h]\d{2}[ m]\d{2}/;
const DIGIT_RUN = /\d{4,}/;

/** The Source gives a photo uploaded again a new hash, but not a new name. */
export function photoKeyOf(url: string): string | null {
  const name = uploadOf(url)?.[2];
  if (name === undefined) return null;
  let base = name.toLowerCase().replace(EXTENSION, "");
  while (SIZE_SUFFIX.test(base)) base = base.replace(SIZE_SUFFIX, "");
  const key = base.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const distinctive =
    key.length >= MIN_PHOTO_NAME_LENGTH && (TIMESTAMP.test(key) || DIGIT_RUN.test(key));
  return distinctive ? key : null;
}

function stated<T>(fact: Fact<T> | undefined): T | null {
  return fact === undefined || fact.value === "unknown" ? null : (fact.value as T);
}

const clean = (text: string | undefined): string | null => {
  const trimmed = text?.trim().toLowerCase().replace(/\s+/g, " ");
  return trimmed ? trimmed : null;
};

function streetOf(street: string | null): string | null {
  if (street === null) return null;
  const folded = street
    .toLowerCase()
    .replaceAll("ß", "ss")
    .replace(/stra(?:ss|ß)e|str\./g, "str")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  return folded === "" ? null : folded;
}

function avatarOf(url: string | undefined): string | null {
  if (url === undefined || url === "") return null;
  return uploadHashOf(url) ?? (url.split(/[?#]/)[0] ?? "").replace(/^https?:\/\/[^/]+/i, "");
}

function flatmatesOf(counts: Flatmates | null): string | null {
  if (counts === null) return null;
  const { women, men, diverse, unspecified } = counts;
  if (women + men + diverse + unspecified === 0) return null;
  return `${women}w${men}m${diverse}d${unspecified}n`;
}

export function profileOf(input: {
  category: Category;
  facts: RuleFacts;
  card: SearchCard;
  text: OfferText;
}): AdProfile {
  const { category, facts, card, text } = input;
  const companyProfile = stated(facts.companyProfile);
  const photos = stated(facts.imageUrls) ?? [];
  const images = [
    ...new Set(
      photos.flatMap((url) => {
        const key = typeof url === "string" ? photoKeyOf(url) : null;
        return key === null ? [] : [key];
      }),
    ),
  ];
  // The first free-text section is the one that describes the room or the home; the others (the
  // area, the flat's life) are shared by every room of a flat.
  const description = text.sections[0]?.text ?? "";
  return {
    category,
    postalCode: stated(facts.postalCode),
    street: streetOf(stated(facts.street)),
    flatSize: stated(facts.flatSize),
    roomSize: stated(facts.roomSize),
    flatshareSize: stated(facts.flatshareSize),
    flatmates: flatmatesOf(stated(facts.flatmates)),
    advertiser: {
      name: clean(card.advertiser.name),
      avatar: avatarOf(card.advertiser.avatarUrl),
      memberSince: stated(facts.memberSince),
      companyProfile,
      company: card.advertiser.kind === "company" || companyProfile !== null,
    },
    images,
    text: textSignature(description),
  };
}
