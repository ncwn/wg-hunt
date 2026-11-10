import {
  type Band,
  type Chip,
  combineOfferFacts,
  type FactOverride,
  type HiddenCause,
  type ModelFacts,
  type OfferFacts,
  overrideFacts,
  type RankableOffer,
  type Ranking,
  type Reason,
  type RuleFacts,
  type ScamAssessment,
} from "@wg-hunt/core";
import type { OfferAdRow, OfferRow } from "../db/schema.js";
import type { ScamContext } from "./scam.js";
import { isOfferStale } from "./staleness.js";
import type { Visibility } from "./visibility.js";

export type RankingView = {
  band: Band;
  bandChangedAt: string;
  reasons: Reason[];
  chips: Chip[];
  /** The first of `visibility.hidden`; null when not hidden. */
  hiddenBecause: HiddenCause | null;
  visibility: Visibility;
};

/** Model facts are absent until a model pass, so Filters on them count as unknown. */
export function factsOf(
  row: Pick<OfferRow, "category" | "facts" | "modelFacts">,
  overrides: readonly FactOverride[],
): OfferFacts {
  const combined = {
    category: row.category,
    ...combineOfferFacts({
      category: row.category,
      ruleFacts: JSON.parse(row.facts) as RuleFacts,
      modelFacts: row.modelFacts === null ? undefined : (JSON.parse(row.modelFacts) as ModelFacts),
    }),
  } as OfferFacts;
  return overrideFacts(combined, overrides);
}

export function rankableOf(
  row: OfferRow,
  ads: OfferAdRow[],
  current: OfferAdRow,
  now: number,
  tracked: boolean,
  scams: ScamContext,
  overrides: readonly FactOverride[] = [],
): RankableOffer & { scam: ScamAssessment } {
  const facts = factsOf(row, overrides);
  return {
    facts,
    scam: scams.assess(row, facts),
    firstSeenAt: row.firstSeenAt.getTime(),
    lastBumpAt: current.lastBumpAt?.getTime() ?? null,
    stale: isOfferStale(ads, now),
    untracked: !tracked,
    dismissed: row.dismissed,
  };
}

export type RankedEntry = {
  row: OfferRow;
  ads: OfferAdRow[];
  rankable: RankableOffer & { scam: ScamAssessment };
  ranking: Ranking;
  tracked: boolean;
  bandToRemember: Band;
  visibility: Visibility;
  overrides: readonly FactOverride[];
  bandChangedAt: Date;
};
