import { formatBerlin } from "../crawl-status.js";
import { filterLabel } from "../offer-rows.js";
import type { Offer } from "../offers.js";

type HiddenCause = Offer["visibility"]["hidden"][number];

function hiddenLine(cause: HiddenCause, now = new Date()): string {
  const since = cause.since === null ? "" : ` since ${formatBerlin(cause.since, now)}`;
  switch (cause.cause) {
    case "stale":
      if (cause.why === "aged")
        return `Hidden: not bumped for over a week${since}. It comes back when it's bumped.`;
      if (cause.why === "deactivated")
        return "Hidden: its page on wg-gesucht is deactivated. It comes back if the page is reactivated.";
      return "Hidden: its page on wg-gesucht was deleted. It comes back only if it's re-posted.";
    case "untracked":
      return "Hidden: none of your Searches finds it any more. It comes back when one does.";
    case "dismissed":
      return `Hidden: you marked it not for me${since}. It comes back when you undo it.`;
  }
}

export function hiddenLines(offer: Offer, now = new Date()): string[] {
  return offer.visibility.hidden.map((cause) => hiddenLine(cause, now));
}

export function dealbreakers(offer: Offer): string[] {
  return offer.reasons
    .filter((reason) => reason.effect === "hidden" && reason.outcome === "fail")
    .map((reason) => filterLabel(reason.filter));
}
