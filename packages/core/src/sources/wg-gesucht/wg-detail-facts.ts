import {
  type AgeRange,
  FLATSHARE_TYPES,
  type FlatshareType,
  type Gender,
  type RuleFacts,
} from "../../offer-facts/index.js";
import { field, unknown } from "./build.js";
import type { WgDetails } from "./flatshare-facts.js";
import { clean } from "./german.js";
import { FLATSHARE_TYPE_LABELS, LANGUAGE_CODES } from "./lexicon.js";

const TYPE_BY_LABEL = new Map<string, FlatshareType>(
  FLATSHARE_TYPES.map((type) => [FLATSHARE_TYPE_LABELS[type].toLowerCase(), type]),
);

const SMOKING: [RegExp, "not_wanted" | "anywhere" | "own_room" | "balcony"][] = [
  [/nicht erwünscht/i, "not_wanted"],
  [/überall erlaubt/i, "anywhere"],
  [/im (?:eigenen )?zimmer/i, "own_room"],
  [/balkon/i, "balcony"],
];

const GENDERS: Record<string, Gender> = {
  frau: "woman",
  frauen: "woman",
  mann: "man",
  männer: "man",
  divers: "diverse",
};

/** "zwischen 23 und 28", "ab 25", "bis 30"; a missing end is left out. */
function ageRange(text: string): AgeRange | undefined {
  const between = text.match(/zwischen\s+(\d+)\s+und\s+(\d+)/i);
  if (between?.[1] && between[2]) return { min: Number(between[1]), max: Number(between[2]) };
  const min = text.match(/\bab\s+(\d+)/i)?.[1];
  const max = text.match(/\bbis\s+(\d+)/i)?.[1];
  if (min === undefined && max === undefined) return undefined;
  return {
    ...(min === undefined ? {} : { min: Number(min) }),
    ...(max === undefined ? {} : { max: Number(max) }),
  };
}

function genderSought(line: string): Gender[] | "any" | undefined {
  const who = line.split(/\s(?:zwischen|ab|bis)\s/i)[0] ?? "";
  if (/^Geschlecht egal$/i.test(who)) return "any";
  const genders = who
    .split(/\s*(?:,|\boder\b|\bund\b|\/)\s*/i)
    .map((word) => GENDERS[word.toLowerCase()]);
  if (genders.length === 0 || genders.some((gender) => gender === undefined)) return undefined;
  return [...new Set(genders as Gender[])];
}

function flatshareTypes(line: string): FlatshareType[] | undefined {
  const types = line.split(",").map((part) => TYPE_BY_LABEL.get(clean(part).toLowerCase()));
  return types.length > 0 && types.every((type) => type !== undefined)
    ? (types as FlatshareType[])
    : undefined;
}

export function wgDetailFacts(details: WgDetails): Partial<RuleFacts> {
  const facts: Partial<RuleFacts> = {
    flatmateAges: unknown(),
    smoking: unknown(),
    languages: unknown(),
    petsPresent: unknown(),
    flatshareTypes: unknown(),
    genderSought: unknown(),
    ageSought: unknown(),
  };

  for (const line of details.flat) {
    const ages = line.match(/^Bewohneralter:\s*(.+)$/);
    if (ages?.[1]) {
      const between = ages[1].match(/^(\d+)\s*bis\s*(\d+)/);
      const single = ages[1].match(/^(\d+)\s*Jahre?$/);
      if (between?.[1] && between[2]) {
        facts.flatmateAges = field({ min: Number(between[1]), max: Number(between[2]) }, line);
      } else if (single?.[1]) {
        facts.flatmateAges = field({ min: Number(single[1]), max: Number(single[1]) }, line);
      }
      continue;
    }
    if (/^Rauchen\b/i.test(line)) {
      const smoking = SMOKING.find(([pattern]) => pattern.test(line))?.[1];
      if (smoking) facts.smoking = field(smoking, line);
      continue;
    }
    const languages = line.match(/^Sprache\/n:\s*(.+)$/);
    if (languages?.[1]) {
      const codes = languages[1]
        .split(",")
        .map((name) => clean(name).toLowerCase())
        .filter((name) => name !== "")
        .map((name) => LANGUAGE_CODES[name] ?? name);
      if (codes.length > 0) facts.languages = field(codes, line);
      continue;
    }
    const pets = line.match(/^Haustiere vorhanden:\s*(Ja|Nein)$/i);
    if (pets?.[1]) {
      facts.petsPresent = field(pets[1].toLowerCase() === "ja", line);
      continue;
    }
    const types = flatshareTypes(line);
    if (types) facts.flatshareTypes = field(types, line);
  }

  const sought = details.sought[0];
  if (sought) {
    const gender = genderSought(sought);
    if (gender) facts.genderSought = field(gender, sought);
    const age = ageRange(sought);
    if (age) facts.ageSought = field(age, sought);
  }
  return facts;
}
