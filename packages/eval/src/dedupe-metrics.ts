import type { Relation } from "@wg-hunt/core";

/** `apart` is what is left when none applies. */
export const REPORTED_RELATIONS = ["duplicate", "sibling", "cloned"] as const;

type RelationCounts = {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** Null when the rules never called this relation. */
  precision: number | null;
  /** Null when no labelled pair has this relation. */
  recall: number | null;
};

export type DedupeMetrics = {
  pairs: number;
  /** Null with no pairs. */
  accuracy: number | null;
  relations: Record<(typeof REPORTED_RELATIONS)[number], RelationCounts>;
  misses: { id: string; expected: Relation; actual: Relation }[];
};

export type DedupeOutcome = { id: string; expected: Relation; actual: Relation };

const ratio = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

/** A false merge hides a room, so a Duplicate's precision is the number to watch. */
export function dedupeMetrics(outcomes: readonly DedupeOutcome[]): DedupeMetrics {
  const relations = Object.fromEntries(
    REPORTED_RELATIONS.map((relation) => {
      const truePositives = outcomes.filter(
        (o) => o.expected === relation && o.actual === relation,
      ).length;
      const falsePositives = outcomes.filter(
        (o) => o.expected !== relation && o.actual === relation,
      ).length;
      const falseNegatives = outcomes.filter(
        (o) => o.expected === relation && o.actual !== relation,
      ).length;
      const counts: RelationCounts = {
        truePositives,
        falsePositives,
        falseNegatives,
        precision: ratio(truePositives, truePositives + falsePositives),
        recall: ratio(truePositives, truePositives + falseNegatives),
      };
      return [relation, counts];
    }),
  ) as DedupeMetrics["relations"];
  const right = outcomes.filter((o) => o.expected === o.actual).length;
  return {
    pairs: outcomes.length,
    accuracy: ratio(right, outcomes.length),
    relations,
    misses: outcomes
      .filter((o) => o.expected !== o.actual)
      .map(({ id, expected, actual }) => ({ id, expected, actual })),
  };
}
