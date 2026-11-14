import type { SettingsState } from "../settings-state.js";
import type { BotCheckMarker } from "./bot-check.js";
import type { JobKind } from "./constants.js";

/**
 * - `needs-resume`: two Bot checks within 24 h mean only a manual Resume continues.
 * - `wiped`: once the wipe is done, the next Resume starts a fresh backfill of every Search.
 */
export const CRAWL_STATES = [
  "running",
  "paused",
  "cooling-down",
  "needs-resume",
  "outside-hours",
  "layout-changed",
  "disk-full",
  "wiped",
] as const;
export type CrawlState = (typeof CRAWL_STATES)[number];

export const PAUSE_REASONS = ["user", "layout-changed", "disk-full", "wiped"] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

/**
 * - `unexpected-page`: an update may be needed first.
 * - `handler-error`: a Resume tries again.
 */
export const PAUSE_CAUSES = ["unexpected-page", "handler-error"] as const;
export type PauseCause = (typeof PAUSE_CAUSES)[number];

/** Stops only a Resume ends; one Resume lifts them all. */
export const CRAWL_HOLDS = [
  "paused",
  "layout-changed",
  "disk-full",
  "wiped",
  "needs-resume",
] as const;
export type CrawlHold = (typeof CRAWL_HOLDS)[number];

export const RESUME_REFUSALS = ["bot-check-cooldown", "wipe-running"] as const;
type ResumeRefusal = (typeof RESUME_REFUSALS)[number];

export const WAIT_REASONS = [
  "gap",
  "hourly-cap",
  "daily-cap",
  "active-hours",
  "cooldown",
  "needs-resume",
  "paused",
  "layout-changed",
  "disk-full",
  "wiped",
] as const;
export type WaitReason = (typeof WAIT_REASONS)[number];

export type BotCheckRecord = {
  /** ISO 8601. */
  at: string;
  path: string;
  marker: BotCheckMarker;
  /** Requests in the hour and in the Berlin day up to and including the one that was checked. */
  hourCount: number;
  dayCount: number;
};

export type BotCheckEvent = BotCheckRecord & {
  /** ISO 8601. */
  cooldownUntil: string;
  /** 1 for the first hit within 7 days, up to the length of the ladder. */
  level: number;
  needsResume: boolean;
};

export type CrawlStatus = {
  state: CrawlState;
  cooldown: { until: string; level: number; needsResume: boolean } | null;
  paused: {
    reason: PauseReason;
    /** Layout change only; null as well for one stored before the cause was recorded. */
    cause: PauseCause | null;
    since: string;
    /** Layout change only: the page's path and its raw copy, relative to the data folder. */
    path: string | null;
    savedAs: string | null;
  } | null;
  /** In the order `state` names them. */
  holds: CrawlHold[];
  nextRequest: {
    /** ISO 8601; null while only a Resume lets requests go (see `holds`) or nothing is queued. */
    at: string | null;
    /** What holds it back now; null when the limits let it go and it only waits for a due job. */
    waitingFor: WaitReason | null;
  };
  actions: { pause: boolean; resume: boolean; resumeRefusedBy: ResumeRefusal | null };
  halfBudgetUntil: string | null;
  counts: {
    hour: { used: number; cap: number };
    day: { used: number; cap: number };
  };
  nextJobs: { kind: JobKind; path: string; dueAt: string }[];
  lastBotCheck: BotCheckRecord | null;
  settings: SettingsState;
};
