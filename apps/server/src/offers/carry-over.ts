import { parseStoredAnalysis } from "../analysis/record.js";
import type { OfferRow } from "../db/schema.js";
import { mergedClocks, mergedPinRelease } from "../retention/clocks.js";

/**
 * Nothing else decides what a merge or split does with a column; a new column of `offers` does not
 * compile until it has an entry here.
 */

type MergeRule =
  | "survivor"
  | "page"
  | "words"
  | "earliest"
  | "earliest-set"
  /** A seeker's mark is never lost to a merge. */
  | "either"
  | "earliest-dismissed"
  /** A warning the seeker gave on either side stays. */
  | "scam-first"
  | "clocks"
  | "pin-release"
  | "now";

type SplitRule =
  | "new"
  | "own-page"
  | "own-words"
  | "leaving"
  /**
   * Marks and the band were about the room as the seeker saw it, so the split-off part neither
   * comes back as new nor loses a Dismiss.
   */
  | "copy"
  | "none"
  | "now";

type CarryOver = { merge: MergeRule; split: SplitRule };

const CARRY_OVER = {
  id: { merge: "survivor", split: "new" },
  category: { merge: "page", split: "own-page" },
  title: { merge: "page", split: "own-page" },
  facts: { merge: "page", split: "own-page" },
  card: { merge: "page", split: "own-page" },
  // An Offer whose page fields came from older rules keeps its older version, so the re-parse
  // after a rules bump still finds it.
  rulesVersion: { merge: "page", split: "own-page" },
  analysisState: { merge: "words", split: "own-words" },
  modelFacts: { merge: "words", split: "own-words" },
  analysis: { merge: "words", split: "own-words" },
  firstSeenAt: { merge: "earliest", split: "leaving" },
  createdAt: { merge: "survivor", split: "copy" },
  updatedAt: { merge: "now", split: "now" },
  // The survivor is ranked again right after the merge, which moves the band if it should.
  band: { merge: "survivor", split: "copy" },
  bandChangedAt: { merge: "survivor", split: "copy" },
  scamMark: { merge: "scam-first", split: "copy" },
  dismissed: { merge: "either", split: "copy" },
  dismissedAt: { merge: "earliest-dismissed", split: "copy" },
  shortlisted: { merge: "either", split: "copy" },
  contacted: { merge: "either", split: "copy" },
  // The split-off part was as quiet as the room; both Offers' clocks are refreshed after a split.
  quietSince: { merge: "clocks", split: "copy" },
  recordClockSince: { merge: "clocks", split: "copy" },
  // A split writes fresh "different" verdicts, which pin both Offers again whatever the release.
  pairPinsReleasedAt: { merge: "pin-release", split: "copy" },
  // A read promised on either side is still owed to the room. A split leaves it with the Offer
  // that was clicked; the new one was promised nothing.
  reanalyzeRequestedAt: { merge: "earliest-set", split: "none" },
} as const satisfies Record<keyof OfferRow, CarryOver>;

/** @public What merge and split do outside the `offers` row, for people reading `CARRY_OVER`. */
export const RELATED_CARRY_OVER = {
  adIds: "Follow the merge into the survivor; a split moves only the leaving Ad ID.",
  prices: "Follow their Ad IDs.",
  texts: "Follow their Ad IDs.",
  factOverrides:
    "Merge: the survivor's correction of a fact wins, the absorbed Offer's fill the rest. Split: they stay with the Offer left behind, which is the room they were made on.",
  pairOverrides:
    "Merge: every pair across the two becomes `same`. Split: every pair of the leaving Ad ID with the ones staying becomes `different`.",
  links: "Written afresh for every Ad ID involved.",
  tombstone:
    "Merge: the absorbed id points at the survivor, and so does every id that pointed at the absorbed one. Split: none.",
} as const;

export type MergeContext = {
  /** The absorbed Offer holds the Ad ID that is current after the merge. */
  takesOver: boolean;
  currentHash: string | null;
  pairPinned: { survivor: boolean; absorbed: boolean };
  now: Date;
};

export type SplitContext = {
  /** The leaving Ad ID's own page, read again; undefined when it can't be. */
  page: Pick<OfferRow, "category" | "title" | "facts" | "card" | "rulesVersion"> | undefined;
  leavingHash: string | null;
  leavingFirstSeenAt: Date;
  now: Date;
};

const readWords = (row: OfferRow): string | null =>
  row.analysisState === "analyzed"
    ? (parseStoredAnalysis(row.analysis).run?.contentHash ?? null)
    : null;

const earlier = (a: Date | null, b: Date | null): Date | null =>
  a === null || b === null ? (a ?? b) : a.getTime() <= b.getTime() ? a : b;

export function mergedRow(survivor: OfferRow, absorbed: OfferRow, ctx: MergeContext): OfferRow {
  const page = ctx.takesOver ? absorbed : survivor;
  const other = ctx.takesOver ? survivor : absorbed;
  const words =
    ctx.currentHash !== null && readWords(page) !== ctx.currentHash
      ? readWords(other) === ctx.currentHash
        ? other
        : page
      : page;
  const value = <K extends keyof OfferRow>(key: K, rule: MergeRule): OfferRow[K] => {
    const mine = survivor[key];
    const theirs = absorbed[key];
    switch (rule) {
      case "survivor":
        return mine;
      case "page":
        return page[key];
      case "words":
        return words[key];
      case "earliest":
        return (
          (mine as Date).getTime() <= (theirs as Date).getTime() ? mine : theirs
        ) as OfferRow[K];
      case "earliest-set":
        return earlier(mine as Date | null, theirs as Date | null) as OfferRow[K];
      case "either":
        return (Boolean(mine) || Boolean(theirs)) as OfferRow[K];
      case "earliest-dismissed":
        return earlier(
          survivor.dismissed ? survivor.dismissedAt : null,
          absorbed.dismissed ? absorbed.dismissedAt : null,
        ) as OfferRow[K];
      case "scam-first":
        return (mine === "scam" || theirs === "scam" ? "scam" : (mine ?? theirs)) as OfferRow[K];
      case "clocks":
        return mergedClocks(survivor, absorbed)[
          key as "quietSince" | "recordClockSince"
        ] as OfferRow[K];
      case "pin-release":
        return mergedPinRelease(
          { releasedAt: survivor.pairPinsReleasedAt, pinned: ctx.pairPinned.survivor },
          { releasedAt: absorbed.pairPinsReleasedAt, pinned: ctx.pairPinned.absorbed },
        ) as OfferRow[K];
      case "now":
        return ctx.now as OfferRow[K];
    }
  };
  return Object.fromEntries(
    Object.entries(CARRY_OVER).map(([key, { merge }]) => [
      key,
      value(key as keyof OfferRow, merge),
    ]),
  ) as OfferRow;
}

export function splitRow(source: OfferRow, ctx: SplitContext): Omit<OfferRow, "id"> {
  const ownWords = ctx.leavingHash !== null && readWords(source) === ctx.leavingHash;
  const value = <K extends keyof OfferRow>(key: K, rule: SplitRule): OfferRow[K] | undefined => {
    switch (rule) {
      case "new":
        return undefined;
      case "own-page":
        return ctx.page
          ? (ctx.page[key as keyof SplitContext["page"]] as OfferRow[K])
          : source[key];
      case "own-words":
        if (ownWords) return source[key];
        return (key === "analysisState" ? "pending" : null) as OfferRow[K];
      case "leaving":
        return ctx.leavingFirstSeenAt as OfferRow[K];
      case "copy":
        return source[key];
      case "none":
        return null as OfferRow[K];
      case "now":
        return ctx.now as OfferRow[K];
    }
  };
  return Object.fromEntries(
    Object.entries(CARRY_OVER).flatMap(([key, { split }]) =>
      split === "new" ? [] : [[key, value(key as keyof OfferRow, split)]],
    ),
  ) as Omit<OfferRow, "id">;
}
