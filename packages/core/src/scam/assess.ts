import { type Fact, UNKNOWN } from "../offer-facts/fact.js";
import type { OfferFacts } from "../offer-facts/schema.js";
import { SCAM_SIGNAL_KINDS } from "../offer-facts/values.js";
import { num, readFact } from "../ranking/read.js";
import { MIN_COMPARABLES, type RentBaseline } from "./baseline.js";

const DAY = 86_400_000;

const NEW_ACCOUNT_DAYS = 30;
const BELOW_MEDIAN_SHARE = 0.6;
const MAX_DEPOSIT_MONTHS = 3;
const SOFT_SIGNALS_FOR_VERDICT = 3;

const DERIVED_SIGNAL_KINDS = [
  "new_unverified_account",
  "rent_below_median",
  "price_mismatch",
  "cloned_offer",
] as const;

/**
 * Kaution over 3 months is both a text and a derived signal: the model reads it from the text and
 * the rules check it on the fields.
 */
export const SCAM_SIGNAL_KINDS_ALL = [...SCAM_SIGNAL_KINDS, ...DERIVED_SIGNAL_KINDS] as const;
type ScamSignalKindAll = (typeof SCAM_SIGNAL_KINDS_ALL)[number];

type ScamStrength = "strong" | "soft";

/** The seeker's override of the verdict; null when cleared. */
type ScamMark = "scam" | "not";

type ScamSignal = {
  kind: ScamSignalKindAll;
  strength: ScamStrength;
  /** `text`: the model read it in the Offer's words. */
  origin: "text" | "derived";
  message: string;
  quote?: string;
  evidence?: string;
  doubtful: boolean;
};

export type ClonedOriginal = {
  offerId: number;
  memberSince: string | null;
  sharedImages: number;
  textSimilarity: number | null;
};

export type ScamInput = {
  facts: OfferFacts;
  /** Epoch milliseconds. */
  now: number;
  mark?: ScamMark | null | undefined;
  baseline?: RentBaseline | null | undefined;
  originals?: readonly ClonedOriginal[] | undefined;
};

export type ScamAssessment = {
  likelyScam: boolean;
  computedLikelyScam: boolean;
  mark: ScamMark | null;
  signals: ScamSignal[];
  cautions: ScamSignal[];
  strong: number;
  soft: number;
  summary: string;
};

const STRONG_TEXT: readonly ScamSignalKindAll[] = [
  "money_before_viewing",
  "keys_by_post",
  "cannot_show_in_person",
];

const MESSAGES: Record<ScamSignalKindAll, string> = {
  money_before_viewing: "Asks for money before a viewing",
  keys_by_post: "Keys by post, courier or a third-party agency",
  cannot_show_in_person: "The Advertiser can't show the place in person",
  deposit_over_three_months: "Kaution over 3 months' rent",
  off_platform_contact: "Moves contact off the platform",
  id_copy_upfront: "Asks for an ID copy before a viewing",
  new_unverified_account: "New account, not Verifiziert",
  rent_below_median: "Rent far below the district median",
  price_mismatch: "The text names a different price than the rent fields",
  cloned_offer: "Copies another Advertiser's Offer",
};

const euro = (amount: number) => `€${num(amount)}`;
const euroPerSqm = (amount: number) => `€${amount.toFixed(2)}/m²`;

function signal(
  kind: ScamSignalKindAll,
  strength: ScamStrength,
  origin: ScamSignal["origin"],
  extra: { quote?: string | undefined; evidence?: string | undefined; doubtful?: boolean } = {},
): ScamSignal {
  const { quote, evidence, doubtful = false } = extra;
  return {
    kind,
    strength,
    origin,
    message: MESSAGES[kind],
    ...(quote ? { quote } : {}),
    ...(evidence ? { evidence } : {}),
    doubtful,
  };
}

function textSignals(facts: OfferFacts): Map<ScamSignalKindAll, ScamSignal> {
  const found = new Map<ScamSignalKindAll, ScamSignal>();
  for (const entry of facts.scamSignals ?? []) {
    if (entry.value === UNKNOWN) continue;
    const kind: ScamSignalKindAll = entry.value;
    const isDoubtful = entry.confidence?.status === "doubtful";
    const strength: ScamStrength = !isDoubtful && STRONG_TEXT.includes(kind) ? "strong" : "soft";
    const earlier = found.get(kind);
    // The first confident reading of a kind wins over a Doubtful one.
    if (earlier !== undefined && (!earlier.doubtful || isDoubtful)) continue;
    found.set(kind, signal(kind, strength, "text", { quote: entry.quote, doubtful: isDoubtful }));
  }
  return found;
}

/** The Source only shows the month. */
const joinedAt = (month: string) => Date.parse(`${month}-15T00:00:00Z`);

function newUnverifiedAccount({ facts, now }: ScamInput): ScamSignal | null {
  const since = readFact<string>(facts, "memberSince");
  const verified = readFact<boolean>(facts, "verified");
  const company = readFact<string>(facts, "companyProfile");
  if (since.state !== "known" || verified.state !== "known") return null;
  if (verified.value || company.state === "known") return null;
  if (joinedAt(since.value) < now - NEW_ACCOUNT_DAYS * DAY) return null;
  return signal("new_unverified_account", "soft", "derived", {
    quote: since.quote,
    evidence: `member since ${since.value}, not Verifiziert`,
  });
}

function rentBelowMedian({ facts, baseline }: ScamInput): ScamSignal | null {
  if (!baseline || baseline.count < MIN_COMPARABLES || baseline.median <= 0) return null;
  const perSqm = readFact<number>(facts, "rentPerSqm");
  if (perSqm.state !== "known") return null;
  const rent = readFact<{ converted: boolean }>(facts, "warmRent");
  if (rent.state === "known" && rent.value.converted) return null;
  if (perSqm.value >= baseline.median * BELOW_MEDIAN_SHARE) return null;
  return signal("rent_below_median", "soft", "derived", {
    quote: perSqm.quote,
    evidence: `warm rent ${euroPerSqm(perSqm.value)} is under ${BELOW_MEDIAN_SHARE * 100}% of the district median ${euroPerSqm(baseline.median)} from ${baseline.count} Offers`,
  });
}

type Money = { amount: number; converted: boolean };

function priceMismatch({ facts }: ScamInput): ScamSignal | null {
  for (const key of ["warmRent", "baseRent"] as const) {
    const rent = facts[key] as Fact<Money> | undefined;
    if (rent === undefined || rent.value === UNKNOWN) continue;
    const fieldAmount = rent.value.amount;
    const text = rent.alternatives?.find(
      (alternative) => alternative.origin === "text" && alternative.value.amount !== fieldAmount,
    );
    if (text === undefined) continue;
    return signal("price_mismatch", "soft", "derived", {
      quote: text.quote,
      evidence: `the text says ${euro(text.value.amount)}, the field says ${euro(fieldAmount)}`,
    });
  }
  return null;
}

function depositEvidence(facts: OfferFacts): { quote: string; evidence: string } | null {
  const deposit = readFact<Money>(facts, "deposit");
  const rent = readFact<Money>(facts, "baseRent");
  if (deposit.state !== "known" || rent.state !== "known") return null;
  if (deposit.value.converted || rent.value.converted || rent.value.amount <= 0) return null;
  if (deposit.value.amount <= rent.value.amount * MAX_DEPOSIT_MONTHS) return null;
  const months = (deposit.value.amount / rent.value.amount).toFixed(1);
  return {
    quote: deposit.quote,
    evidence: `Kaution ${euro(deposit.value.amount)} against a cold rent of ${euro(rent.value.amount)} (${months} months)`,
  };
}

function clonedOffer({ facts, originals }: ScamInput): ScamSignal | null {
  if (originals === undefined || originals.length === 0) return null;
  const verified = readFact<boolean>(facts, "verified");
  const since = readFact<string>(facts, "memberSince");
  const describe = (original: ClonedOriginal) => {
    const photos = `${original.sharedImages} shared photo${original.sharedImages === 1 ? "" : "s"}`;
    const text =
      original.textSimilarity === null
        ? ""
        : `, text ${Math.round(original.textSimilarity * 100)}% alike`;
    return `copies Offer ${original.offerId} (${photos}${text})`;
  };
  const newer = (original: ClonedOriginal) =>
    since.state === "known" &&
    original.memberSince !== null &&
    since.value > original.memberSince &&
    verified.state === "known" &&
    !verified.value;
  const ordered = [...originals].sort((a, b) => a.offerId - b.offerId);
  const strong = ordered.find(newer);
  if (strong !== undefined && since.state === "known") {
    return signal("cloned_offer", "strong", "derived", {
      evidence: `${describe(strong)}; this Advertiser joined ${since.value}, after the original's ${strong.memberSince}, and is not Verifiziert`,
    });
  }
  const [first] = ordered;
  return first === undefined
    ? null
    : signal("cloned_offer", "soft", "derived", { evidence: describe(first) });
}

const ORDER = new Map(SCAM_SIGNAL_KINDS_ALL.map((kind, index) => [kind, index]));

function summaryOf(a: Pick<ScamAssessment, "mark" | "computedLikelyScam" | "strong" | "soft">) {
  const counts = [
    a.strong > 0 ? `${a.strong} strong signal${a.strong === 1 ? "" : "s"}` : null,
    a.soft > 0 ? `${a.soft} soft signal${a.soft === 1 ? "" : "s"}` : null,
  ]
    .filter((part) => part !== null)
    .join(" and ");
  if (a.mark === "scam") return "Marked as a scam by you";
  if (a.mark === "not") {
    return a.computedLikelyScam
      ? `Marked as not a scam by you, though it has ${counts}`
      : "Marked as not a scam by you";
  }
  if (a.computedLikelyScam) return `Likely scam: ${counts}`;
  if (a.soft > 0) {
    return `${counts}; ${SOFT_SIGNALS_FOR_VERDICT} soft signals or 1 strong one make a Likely scam`;
  }
  return "No Scam signals";
}

export function assessScam(input: ScamInput): ScamAssessment {
  const found = textSignals(input.facts);

  const deposit = depositEvidence(input.facts);
  if (deposit !== null) {
    const text = found.get("deposit_over_three_months");
    found.set(
      "deposit_over_three_months",
      text === undefined
        ? signal("deposit_over_three_months", "soft", "derived", deposit)
        : { ...text, evidence: deposit.evidence },
    );
  }
  for (const derived of [
    newUnverifiedAccount(input),
    rentBelowMedian(input),
    priceMismatch(input),
    clonedOffer(input),
  ]) {
    if (derived !== null) found.set(derived.kind, derived);
  }

  const signals = [...found.values()].sort(
    (a, b) =>
      Number(b.strength === "strong") - Number(a.strength === "strong") ||
      (ORDER.get(a.kind) ?? 0) - (ORDER.get(b.kind) ?? 0),
  );
  const strong = signals.filter((s) => s.strength === "strong").length;
  const soft = signals.length - strong;
  const computedLikelyScam = strong >= 1 || soft >= SOFT_SIGNALS_FOR_VERDICT;
  const mark = input.mark ?? null;
  const likelyScam = mark === null ? computedLikelyScam : mark === "scam";
  return {
    likelyScam,
    computedLikelyScam,
    mark,
    signals,
    cautions: !likelyScam && mark === null ? signals.filter((s) => s.strength === "soft") : [],
    strong,
    soft,
    summary: summaryOf({ mark, computedLikelyScam, strong, soft }),
  };
}
