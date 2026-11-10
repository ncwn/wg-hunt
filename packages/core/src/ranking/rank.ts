import type { OfferFacts } from "../offer-facts/schema.js";
import type { ScamAssessment } from "../scam/assess.js";
import { FILTER_KEYS, type FilterKey, type Filters } from "./filters.js";
import type { SeekerProfile } from "./profile.js";
import { type Band, type Chip, type Effect, type Reason, toReason } from "./reason.js";
import { requirementChips } from "./requirements.js";
import { RULES, type Rule, type RuleInput } from "./rules.js";

/** Pure data: no database, no clock. */
export type RankableOffer = {
  facts: OfferFacts;
  /** Epoch milliseconds. */
  firstSeenAt: number;
  /** Epoch milliseconds; null when no Bump is known. */
  lastBumpAt: number | null;
  /** Deactivated or deleted, or its activity is older than 7 days. */
  stale?: boolean;
  /** No enabled Search matches it any more. */
  untracked?: boolean;
  dismissed?: boolean;
  scam?: Pick<ScamAssessment, "likelyScam" | "cautions">;
};

export type Seeking = { profile: SeekerProfile; filters: Filters };

/** In precedence order: the first that applies is `hiddenBecause`. */
export const HIDDEN_CAUSES = ["stale", "untracked", "dismissed"] as const;
export type HiddenCause = (typeof HIDDEN_CAUSES)[number];

export const hiddenCausesOf = (offer: Pick<RankableOffer, HiddenCause>): HiddenCause[] =>
  HIDDEN_CAUSES.filter((cause) => offer[cause] === true);

export type Ranking = {
  band: Band;
  reasons: Reason[];
  chips: Chip[];
  misses: number;
  hiddenBecause?: HiddenCause;
};

export const recencyOf = (offer: Pick<RankableOffer, "firstSeenAt" | "lastBumpAt">): number =>
  offer.lastBumpAt ?? offer.firstSeenAt;

/**
 * Only a known, non-Doubtful value can hide an Offer or make it a Match: unknown, Doubtful and
 * incomplete evidence always yields a Near match.
 */
export function rankOffer(offer: RankableOffer, seeking: Seeking): Ranking {
  const { profile, filters } = seeking;
  const likelyScam = offer.scam?.likelyScam ?? false;
  const input: RuleInput = { facts: offer.facts, profile, filters, likelyScam };
  const reasons: Reason[] = [];
  for (const key of FILTER_KEYS) {
    const reason = evaluate(key, input);
    if (reason !== null) reasons.push(reason);
  }

  // A hidden Offer still gets its reasons, so the seeker can see what the Filters made of it.
  const [hiddenBecause] = hiddenCausesOf(offer);
  const effects = new Set<Effect>(reasons.map((reason) => reason.effect));
  const band: Band = hiddenBecause
    ? "hidden"
    : likelyScam
      ? reasons.some((reason) => reason.filter === "hideLikelyScams")
        ? "hidden"
        : "warned"
      : effects.has("hidden")
        ? "hidden"
        : effects.has("near-match")
          ? "near-match"
          : "match";
  return {
    band,
    reasons,
    chips: [
      ...chipsOf(offer.facts),
      ...requirementChips(offer.facts, profile),
      ...(likelyScam ? [] : cautionChips(offer)),
    ],
    misses: reasons.filter((reason) => reason.effect !== "none").length,
    ...(hiddenBecause && { hiddenBecause }),
  };
}

function evaluate<K extends FilterKey>(key: K, input: RuleInput): Reason | null {
  const filter = input.filters[key];
  const rule = RULES[key] as Rule<K> | undefined;
  if (!filter.enabled || rule === undefined) return null;
  const check = rule(input, filter);
  return check === null ? null : toReason(key, filter.strength, check);
}

function cautionChips(offer: RankableOffer): Chip[] {
  return (offer.scam?.cautions ?? []).map((caution) => ({
    kind: "scam-caution",
    tone: "warn",
    label: caution.message,
    ...(caution.quote && { quote: caution.quote }),
    ...(caution.evidence && { evidence: caution.evidence }),
  }));
}

function chipsOf(facts: OfferFacts): Chip[] {
  const chips: Chip[] = [];
  const rent = facts.warmRent;
  if (rent && rent.value !== "unknown" && rent.value.converted) {
    chips.push({
      kind: "converted-rent",
      tone: "info",
      label: "Rent converted from a per-night price (x30)",
      quote: rent.quote,
    });
  }
  if (rent && rent.value !== "unknown" && facts.costsComplete?.value !== true) {
    chips.push({
      kind: "costs-incomplete",
      tone: "warn",
      label: "No Nebenkosten stated",
      ...(facts.costsComplete?.quote && { quote: facts.costsComplete.quote }),
    });
  }
  return chips;
}
