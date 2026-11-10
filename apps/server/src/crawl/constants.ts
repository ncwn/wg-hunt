/**
 * Limits the crawler may never change: read-only in `GET /settings/crawl`, and enforced by the
 * engine whatever a stored setting says.
 */

/** The only host the crawler talks to. */
export const SOURCE_ORIGIN = "https://www.wg-gesucht.de";

/** One fixed desktop UA, never rotated. The Source serves different HTML to mobile UAs. */
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

const MAX_IN_FLIGHT = 1;
/** An Offer page is a few hundred kB. */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const GAP_FLOOR_SECONDS = 15;
export const DAILY_CEILING = 600;

export const COOLDOWN_LADDER_HOURS = [2, 4, 8, 24] as const;
export const COOLDOWN_HISTORY_DAYS = 7;
export const HALF_BUDGET_HOURS = 24;

export const ACTIVE_HOURS_ZONE = "Europe/Berlin";

/** In priority order: first is served first. */
export const JOB_KINDS = [
  "poll",
  "new-offer",
  "deeper-page",
  "stale-confirmation",
  "recheck",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export function jobPriority(kind: JobKind): number {
  return JOB_KINDS.indexOf(kind);
}

export const CRAWL_CONSTANTS = {
  maxInFlight: MAX_IN_FLIGHT,
  gapFloorSeconds: GAP_FLOOR_SECONDS,
  dailyCeiling: DAILY_CEILING,
  rotation: "none",
  forbidden: "nothing under /api/ and nothing behind a login",
  cooldownLadderHours: [...COOLDOWN_LADDER_HOURS] as number[],
  halfBudgetHours: HALF_BUDGET_HOURS,
} as const;
