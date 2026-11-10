import type { components } from "./api/schema.js";

export type AnalysisStatus = components["schemas"]["OfferAnalysisStatus"];

const time = (iso: string | null) =>
  iso === null
    ? "soon"
    : new Date(iso).toLocaleString("en-GB", {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
const day = (iso: string | null) =>
  iso === null
    ? "next month"
    : new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long" });
const because = (reason: string | null) => (reason === null ? "" : ` (${reason})`);

function toTryAgain(s: AnalysisStatus): string {
  switch (s.next) {
    case "add-key":
      return "To try again, add an Anthropic API key under Advanced › Keys.";
    case "replace-key":
      return "To try again, replace the refused Anthropic API key under Advanced › Keys.";
    case "raise-cap":
      // With no reset date, what is in flight holds the rest of the limit, for minutes.
      return s.at === null
        ? "Ads being read right now hold the rest of the monthly limit: try again once they're done."
        : `The monthly limit is reached: try again once it resets on ${day(s.at)}, or with a higher limit.`;
    case "recheck":
      // A click would read the same stored copy and fail at once.
      return "There is no readable copy of the ad: Recheck it to fetch one.";
    default:
      return "Re-analyse to try again.";
  }
}

export function analysisNote(s: AnalysisStatus): string | null {
  switch (s.status) {
    case "reading":
      return "Reading the ad…";
    case "queued":
    case "in-batch":
      return "Queued to be read.";
    case "provisional":
      return "A first reading is shown; a closer one is on its way.";
    case "words-changed":
      return "The ad changed; it will be read again.";
    case "retry-at":
      return `Couldn't read this ad${because(s.reason)}. Trying again ${time(s.at)}.`;
    case "needs-click":
      return `Couldn't read this ad${because(s.reason)}. ${toTryAgain(s)}`;
    case "waiting-for-page":
      return "There is no readable copy of the ad yet. Recheck it to fetch one.";
    case "waiting-for-key":
      return "Not read yet: add an Anthropic API key under Advanced › Keys.";
    case "key-refused":
      return "Not read: the Anthropic API key was refused. Replace it under Advanced › Keys.";
    case "waiting-for-cap":
      return `Not read yet: the monthly limit is reached. It resets on ${day(s.at)}.`;
    case "waiting-for-in-flight":
      return "Not read yet: ads being read right now hold the rest of the monthly limit. This one is read once they're done.";
    case "kept-previous":
      // Trying again is the seeker's choice here; only a blocker in the way is worth saying.
      return s.next === "reanalyze"
        ? `The last reading failed${because(s.reason)}; the earlier one is shown.`
        : `The last reading failed${because(s.reason)}; the earlier one is shown. ${toTryAgain(s)}`;
    case "escalation-lost":
      return `Only a first reading is shown; the closer one failed. ${toTryAgain(s)}`;
    case "older-version":
    case "analyzed":
    case "stale":
      return null;
  }
}

export const analysisNeedsYou = (s: AnalysisStatus): boolean =>
  !["none", "wait", "start-run"].includes(s.next);
