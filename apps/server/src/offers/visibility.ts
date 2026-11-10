import { type HiddenCause, hiddenCausesOf } from "@wg-hunt/core";
import type { OfferAdRow, OfferRow } from "../db/schema.js";
import { agedOutAt, isOfferStale } from "./staleness.js";

/** `since` is null when wg-hunt does not record it. */
type HiddenCauseView =
  | {
      cause: "stale";
      why: "aged" | "deactivated" | "deleted";
      /** When the last live Ad ID aged out; null for a deactivated or deleted page. */
      since: string | null;
      /** A Bump on a poll or Sweep, a page live again on a Recheck, or a re-post that joins it. */
      endsWhen: "bumped" | "reactivated" | "reposted";
    }
  | { cause: "untracked"; since: null; endsWhen: "a-search-matches" }
  | { cause: "dismissed"; since: string | null; endsWhen: "undismissed" };

export type Visibility = {
  /** Every cause that hides it whatever the Filters say, in precedence order. */
  hidden: HiddenCauseView[];
  actions: {
    recheck: boolean;
    undismiss: boolean;
  };
};

const iso = (at: number | Date | null) => (at === null ? null : new Date(at).toISOString());

function staleCause(
  ads: readonly OfferAdRow[],
  now: number,
): Extract<HiddenCauseView, { cause: "stale" }> | null {
  if (!isOfferStale(ads, now)) return null;
  const live = ads.filter((ad) => ad.pageStatus === "active");
  if (live.length > 0) {
    const since = Math.max(...live.map(agedOutAt));
    return { cause: "stale", why: "aged", since: iso(since), endsWhen: "bumped" };
  }
  if (ads.some((ad) => ad.pageStatus === "deactivated")) {
    return { cause: "stale", why: "deactivated", since: null, endsWhen: "reactivated" };
  }
  return { cause: "stale", why: "deleted", since: null, endsWhen: "reposted" };
}

/**
 * The causes are the ones ranking hid it for (`hiddenCausesOf`, whose first is `hiddenBecause`), so
 * the two never disagree.
 */
export function visibilityOf(input: {
  row: Pick<OfferRow, "dismissed" | "dismissedAt">;
  ads: readonly OfferAdRow[];
  flags: Partial<Record<HiddenCause, boolean>>;
  currentTracked: boolean;
  now: number;
}): Visibility {
  const { row, ads, flags, currentTracked, now } = input;
  const hidden = hiddenCausesOf(flags).flatMap((cause): HiddenCauseView[] => {
    if (cause === "stale") {
      const stale = staleCause(ads, now);
      return stale === null ? [] : [stale];
    }
    if (cause === "untracked") return [{ cause, since: null, endsWhen: "a-search-matches" }];
    return [{ cause, since: iso(row.dismissedAt), endsWhen: "undismissed" }];
  });
  return { hidden, actions: { recheck: currentTracked, undismiss: row.dismissed } };
}
