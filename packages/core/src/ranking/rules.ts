import type { OfferFacts } from "../offer-facts/schema.js";
import type { AgeRange, Flatmates, Gender, Money } from "../offer-facts/values.js";
import { distanceToPlace } from "../places/offer-distance.js";
import { findPlace } from "../places/place.js";
import type { Filters, Margin } from "./filters.js";
import type { SeekerProfile } from "./profile.js";
import { addMonths, dayNumber, isoOf, monthsBetween, num, readFact } from "./read.js";
import type { Check } from "./reason.js";
import { checkRequirements } from "./requirements.js";

export type RuleInput = {
  facts: OfferFacts;
  profile: SeekerProfile;
  filters: Filters;
  likelyScam: boolean;
};

/** Null when the rule has nothing to say: not applicable, or the profile is silent. */
export type Rule<K extends keyof Filters> = (input: RuleInput, filter: Filters[K]) => Check | null;

const euro = (amount: number) => `EUR ${num(amount)}`;

function allowance(limit: number, margin: Margin | null): number {
  if (margin === null) return 0;
  return margin.unit === "percent" ? (limit * margin.value) / 100 : margin.value;
}

/**
 * A missing Nebenkosten row, or one that is `n.a.`, leaves the warm rent unconfirmed, and
 * incomplete evidence never makes a Match.
 */
function costsIncomplete(facts: OfferFacts): boolean {
  return facts.costsComplete?.value !== true;
}

type Bound = {
  label: string;
  format: (value: number) => string;
  limit: number;
  margin: Margin | null;
};

function checkBound(
  direction: "max" | "min",
  reading: ReturnType<typeof readFact<number>>,
  bound: Bound,
  options: { incompleteCosts?: boolean } = {},
): Check | null {
  if (reading.state === "not-applicable") return null;
  const { label, format, limit, margin } = bound;
  if (reading.state === "unknown") {
    return { kind: "unknown", message: `${label} is not stated` };
  }
  const { value, quote, doubtful } = reading;
  const room = allowance(limit, margin);
  const word = direction === "max" ? "at most" : "at least";
  const met = direction === "max" ? value <= limit : value >= limit;
  if (met) {
    if (options.incompleteCosts) {
      return {
        kind: "soft",
        cause: "incomplete-costs",
        message: `${label} ${format(value)} is within ${format(limit)}, but Nebenkosten is missing or unconfirmed`,
        quote,
      };
    }
    return {
      kind: "pass",
      message: `${label} ${format(value)} is ${word} ${format(limit)}`,
      quote,
      doubtful,
    };
  }
  const inMargin = direction === "max" ? value <= limit + room : value >= limit - room;
  return {
    kind: "miss",
    message: inMargin
      ? `${label} ${format(value)} misses ${word} ${format(limit)}, inside your margin of ${format(room)}`
      : `${label} ${format(value)} is not ${word} ${format(limit)}`,
    quote,
    doubtful,
    withinMargin: inMargin,
  };
}

const rent = ({ facts }: RuleInput, filter: Filters["maxRent"]): Check | null => {
  if (filter.limit === null) return null;
  const reading = readFact<Money>(facts, "warmRent");
  const amount = reading.state === "known" ? { ...reading, value: reading.value.amount } : reading;
  return checkBound(
    "max",
    amount,
    { label: "Warm rent", format: euro, limit: filter.limit, margin: filter.margin },
    { incompleteCosts: costsIncomplete(facts) },
  );
};

const size = ({ facts }: RuleInput, filter: Filters["minSize"]): Check | null =>
  filter.limit === null
    ? null
    : checkBound("min", readFact<number>(facts, "roomSize"), {
        label: "Size",
        format: (value) => `${num(value)} m²`,
        limit: filter.limit,
        margin: filter.margin,
      });

const rentPerSqm = ({ facts }: RuleInput, filter: Filters["maxRentPerSqm"]): Check | null =>
  filter.limit === null
    ? null
    : checkBound(
        "max",
        readFact<number>(facts, "rentPerSqm"),
        {
          label: "Rent per m²",
          format: (value) => `${euro(value)}/m²`,
          limit: filter.limit,
          margin: filter.margin,
        },
        { incompleteCosts: costsIncomplete(facts) },
      );

const anmeldung = ({ facts, profile }: RuleInput): Check | null => {
  if (!profile.anmeldungNeeded) return null;
  const reading = readFact<"possible" | "not_possible" | "conditional">(facts, "anmeldung");
  if (reading.state === "not-applicable") return null;
  if (reading.state === "unknown") {
    return { kind: "unknown", message: "The Offer does not say whether Anmeldung is possible" };
  }
  const { value, quote, doubtful } = reading;
  if (value === "possible") {
    return { kind: "pass", message: "Anmeldung is possible", quote, doubtful };
  }
  if (value === "conditional") {
    return {
      kind: "soft",
      cause: "conditional",
      message: "Anmeldung is possible only on a condition",
      quote,
    };
  }
  return { kind: "miss", message: "Anmeldung is not possible", quote, doubtful };
};

const PLURAL = { woman: "women", man: "men", diverse: "diverse people" } as const;
const FLATMATES = { woman: "women", man: "men", diverse: "diverse" } as const;

const genderSought = ({ facts, profile }: RuleInput): Check | null => {
  const { gender } = profile;
  if (gender === null) return null;
  const reading = readFact<"any" | Gender[]>(facts, "genderSought");
  if (reading.state === "not-applicable") return null;
  if (reading.state === "unknown") {
    return { kind: "unknown", message: "The Offer does not say who it seeks" };
  }
  const { value, quote, doubtful } = reading;
  if (value === "any" || value.includes(gender)) {
    return {
      kind: "pass",
      message: value === "any" ? "The Offer seeks anyone" : `The Offer seeks ${PLURAL[gender]}`,
      quote,
      doubtful,
    };
  }
  const seeks = value.map((sought) => PLURAL[sought]).join(" or ");
  const living = readFact<Flatmates>(facts, "flatmates");
  if (living.state === "known" && living.value[FLATMATES[gender]] > 0) {
    return {
      kind: "soft",
      cause: "worth-asking",
      message: `The Offer seeks ${seeks}, but ${PLURAL[gender]} already live there: worth asking`,
      quote,
    };
  }
  return {
    kind: "miss",
    message: `The Offer seeks ${seeks}, not ${PLURAL[gender]}`,
    quote,
    doubtful,
  };
};

const ageSought = ({ facts, profile }: RuleInput): Check | null => {
  const { age } = profile;
  if (age === null) return null;
  const reading = readFact<AgeRange>(facts, "ageSought");
  if (reading.state === "not-applicable") return null;
  if (reading.state === "unknown") {
    return { kind: "unknown", message: "The Offer does not say what age it seeks" };
  }
  const { value, quote, doubtful } = reading;
  const sought =
    value.min !== undefined && value.max !== undefined
      ? `${value.min} to ${value.max}`
      : value.min !== undefined
        ? `${value.min} and older`
        : value.max !== undefined
          ? `up to ${value.max}`
          : "any age";
  const inside =
    (value.min === undefined || age >= value.min) && (value.max === undefined || age <= value.max);
  return inside
    ? { kind: "pass", message: `The Offer seeks ${sought}; you are ${age}`, quote, doubtful }
    : { kind: "miss", message: `The Offer seeks ${sought}; you are ${age}`, quote, doubtful };
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const moveIn = ({ facts, profile }: RuleInput, filter: Filters["moveIn"]): Check | null => {
  const { earliest, latest } = profile.moveIn;
  if (earliest === null && latest === null) return null;
  const reading = readFact<string>(facts, "availableFrom");
  if (reading.state === "not-applicable") return null;
  if (reading.state === "unknown") {
    return { kind: "unknown", message: "The Offer does not say when it is free" };
  }
  const { value, quote, doubtful } = reading;
  const free = dayNumber(value);
  if (earliest !== null && free < dayNumber(earliest)) {
    const early = dayNumber(earliest) - free;
    if (doubtful) {
      return {
        kind: "unknown",
        message: `Free ${plural(early, "day")} early, on Doubtful evidence`,
        quote,
      };
    }
    return {
      kind: "soft",
      cause: "early",
      message: `Free from ${value}, ${plural(early, "day")} early for your window`,
      quote,
    };
  }
  if (latest !== null && free > dayNumber(latest)) {
    const late = free - dayNumber(latest);
    return {
      kind: "miss",
      message: `Free from ${value}, ${plural(late, "day")} after your window ends`,
      quote,
      doubtful,
      withinMargin: filter.marginDays !== null && late <= filter.marginDays,
    };
  }
  return { kind: "pass", message: `Free from ${value}, inside your window`, quote, doubtful };
};

const stayAvailable = ({ facts, profile }: RuleInput): Check | null => {
  const minMonths = profile.stay.minMonths;
  if (minMonths === null) return null;
  const until = readFact<string>(facts, "availableUntil");
  if (until.state === "not-applicable") return null;
  if (until.state === "unknown") {
    return { kind: "unknown", message: "The Offer does not say how long it is available" };
  }
  if (until.value === "none") {
    return {
      kind: "pass",
      message: "Available without an end date",
      quote: until.quote,
      doubtful: until.doubtful,
    };
  }
  const from = readFact<string>(facts, "availableFrom");
  const starts = [
    from.state === "known" ? dayNumber(from.value) : null,
    profile.moveIn.earliest === null ? null : dayNumber(profile.moveIn.earliest),
  ].filter((day): day is number => day !== null);
  if (starts.length === 0) {
    return { kind: "unknown", message: "The Offer does not say when it is free" };
  }
  const start = Math.max(...starts);
  const startIso = isoOf(start);
  // The last day of a stay of `minMonths` starting on `start`.
  const needed = addMonths(startIso, minMonths) - 1;
  const last = dayNumber(until.value);
  const doubtful = until.doubtful || (from.state === "known" && from.doubtful);
  const available = monthsBetween(startIso, isoOf(last + 1));
  const message = `Available until ${until.value}: ${plural(available, "month")} from ${startIso}; you want at least ${minMonths}`;
  return last >= needed
    ? { kind: "pass", message, quote: until.quote, doubtful }
    : { kind: "miss", message, quote: until.quote, doubtful };
};

const stayMinimum = ({ facts, profile }: RuleInput): Check | null => {
  const max = profile.stay.maxMonths;
  if (max === null) return null;
  const reading = readFact<number>(facts, "minimumStay");
  if (reading.state === "not-applicable") return null;
  if (reading.state === "unknown") {
    return { kind: "unknown", message: "The Offer does not state a minimum stay" };
  }
  const { value, quote, doubtful } = reading;
  const message = `Minimum stay of ${plural(value, "month")}; you would stay at most ${max}`;
  return value <= max
    ? { kind: "pass", message, quote, doubtful }
    : { kind: "miss", message, quote, doubtful };
};

function decide<T>(
  reading: ReturnType<typeof readFact<T>>,
  unknownMessage: string,
  test: (value: T) => { ok: boolean; message: string },
): Check | null {
  if (reading.state === "not-applicable") return null;
  if (reading.state === "unknown") return { kind: "unknown", message: unknownMessage };
  const { value, quote, doubtful } = reading;
  const { ok, message } = test(value);
  return { kind: ok ? "pass" : "miss", message, quote, doubtful };
}

const FURNISHED = {
  furnished: "furnished",
  partly_furnished: "partly furnished",
  unfurnished: "unfurnished",
} as const;

const furnished = ({ facts }: RuleInput, filter: Filters["furnished"]): Check | null =>
  filter.accept.length === 0
    ? null
    : decide(
        readFact<keyof typeof FURNISHED>(facts, "furnished"),
        "The Offer does not say whether it is furnished",
        (value) => ({
          ok: filter.accept.includes(value),
          message: `The Offer is ${FURNISHED[value]}`,
        }),
      );

const smoking = ({ facts, profile }: RuleInput): Check | null =>
  profile.smoker !== true
    ? null
    : decide(
        readFact<string>(facts, "smoking"),
        "The Offer does not say whether smoking is allowed",
        (value) => ({
          ok: value !== "not_wanted",
          message:
            value === "not_wanted"
              ? "Smoking is not wanted there; you smoke"
              : "Smoking is allowed there",
        }),
      );

const pets = ({ facts, profile }: RuleInput): Check | null =>
  profile.hasPets !== true
    ? null
    : decide(
        readFact<boolean>(facts, "petsAllowed"),
        "The Offer does not say whether pets are allowed",
        (value) => ({
          ok: value,
          message: value ? "Pets are allowed" : "Pets are not allowed; you have pets",
        }),
      );

const flatshareTypes = ({ facts }: RuleInput, filter: Filters["flatshareTypes"]): Check | null =>
  filter.anyOf.length === 0
    ? null
    : decide(
        readFact<string[]>(facts, "flatshareTypes"),
        "The Offer does not state a flatshare type",
        (value) => ({
          ok: value.some((type) => (filter.anyOf as string[]).includes(type)),
          message: `Flatshare type: ${value.join(", ") || "none"}`,
        }),
      );

const area = ({ facts }: RuleInput, filter: Filters["area"]): Check | null => {
  if (filter.anyOf.length === 0) return null;
  const district = readFact<string>(facts, "district");
  const plz = readFact<string>(facts, "postalCode");
  if (district.state === "not-applicable" || plz.state === "not-applicable") return null;
  const wanted = filter.anyOf.map((entry) => entry.trim().toLowerCase());
  const inDistrict =
    district.state === "known" &&
    wanted.some((entry) => district.value.toLowerCase().includes(entry));
  const inPlz =
    plz.state === "known" &&
    wanted.some((entry) => /^\d+$/.test(entry) && plz.value.startsWith(entry));
  const matched = inDistrict ? district : inPlz ? plz : undefined;
  if (matched?.state === "known") {
    return {
      kind: "pass",
      message: `In the area: ${matched.value}`,
      quote: matched.quote,
      doubtful: matched.doubtful,
    };
  }
  if (district.state !== "known" || plz.state !== "known") {
    return {
      kind: "unknown",
      message: "The Offer does not give both its district and postal code",
    };
  }
  return {
    kind: "miss",
    message: `Outside your areas: ${district.value}, ${plz.value}`,
    quote: district.quote,
    doubtful: district.doubtful || plz.doubtful,
  };
};

const km = (value: number) => `${num(Math.round(value * 10) / 10)} km`;

const distance = ({ facts, profile }: RuleInput, filter: Filters["distance"]): Check | null => {
  if (filter.place === null || filter.limit === null) return null;
  const place = findPlace(profile.places, filter.place);
  if (place === undefined) return null;
  const found = distanceToPlace(facts, place);
  if (found === null) {
    return {
      kind: "unknown",
      message: `The Offer's location is not known, so its distance to ${place.name} is not either`,
    };
  }
  const { approximate } = found;
  // No quote: the Offer's own words for its location would be its coordinates.
  const check = checkBound(
    "max",
    { state: "known", value: found.km, quote: "", doubtful: false },
    {
      label: `${approximate ? "Approximate distance" : "Distance"} to ${place.name}`,
      format: km,
      limit: filter.limit,
      margin: filter.margin,
    },
  );
  // A PLZ centre can be kilometres from the address, so an approximate miss never hides an Offer.
  return approximate && check?.kind === "miss" && !check.withinMargin
    ? { kind: "unknown", message: `${check.message}; the Offer gives no coordinates, only its PLZ` }
    : check;
};

const languages = ({ facts, profile }: RuleInput): Check | null =>
  profile.languages.length === 0
    ? null
    : decide(
        readFact<string[]>(facts, "languages"),
        "The Offer does not say which languages are spoken",
        (value) => ({
          ok: value.some((code) => profile.languages.includes(code)),
          message: `Spoken there: ${value.join(", ")}`,
        }),
      );

const flatmateAges = ({ facts }: RuleInput, filter: Filters["flatmateAges"]): Check | null =>
  filter.min === null && filter.max === null
    ? null
    : decide(
        readFact<AgeRange>(facts, "flatmateAges"),
        "The Offer does not give the flatmates' ages",
        (value) => ({
          ok:
            (filter.min === null || value.min === undefined || value.min >= filter.min) &&
            (filter.max === null || value.max === undefined || value.max <= filter.max),
          message: `Flatmates are ${value.min ?? "?"} to ${value.max ?? "?"} years old`,
        }),
      );

const hideLikelyScams = ({ likelyScam }: RuleInput): Check | null =>
  likelyScam
    ? { kind: "miss", message: "Likely scam, hidden because you chose to hide Likely scams" }
    : null;

export const RULES: { [K in keyof Filters]?: Rule<K> } = {
  anmeldung,
  genderSought,
  ageSought,
  requirements: ({ facts, profile }) => checkRequirements(facts, profile),
  moveIn,
  stayAvailable,
  stayMinimum,
  hideLikelyScams,
  maxRent: rent,
  minSize: size,
  maxRentPerSqm: rentPerSqm,
  furnished,
  smoking,
  pets,
  flatshareTypes,
  area,
  distance,
  languages,
  flatmateAges,
};
