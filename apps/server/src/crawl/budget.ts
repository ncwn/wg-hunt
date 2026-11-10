import { type Category, MAX_POLL_MINUTES, MAX_RECENCY_DAYS } from "@wg-hunt/core";
import type { Db } from "../db/index.js";
import { type SearchRow, searches } from "../db/schema.js";
import { berlinMinuteOfDay } from "./berlin-time.js";
import { isCrawled, type PollProblem } from "./crawled-search.js";
import type { CapsInForce } from "./engine.js";
import type { CrawlSettings } from "./settings.js";

/** The numbers below are planning assumptions, not measurements. */

const POLL_AND_SWEEP_SHARE = 0.5;
/** About a quarter of polls find news and go on to a second page. */
const PAGES_PER_POLL = 1.25;
/** For one category. */
const SWEEP_PAGES_PER_WEEK = 15;
/** For one category. */
const NEW_OFFERS_PER_DAY = 50;
/** For one category. */
const CONFIRMATIONS_PER_DAY = 10;
const MIN_POLL_MINUTES_BEFORE_WARNING = 120;

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

export type ForecastSearch = {
  /** Drafts of new Searches have none. */
  id?: number;
  categories: readonly Category[];
  recencyDays: number;
  enabled: boolean;
  problem: PollProblem | null;
  pollInterval: { minMinutes: number; maxMinutes: number };
};

type ForecastWarning = {
  type: "polls-below-one-per-2h" | "over-budget" | "no-room-for-polls";
  message: string;
};

export type Forecast = {
  /** The cap in force now, not the configured one. */
  dailyCap: number;
  halfBudget: { until: string; fullDailyCap: number } | null;
  requests: {
    polls: number;
    sweeps: number;
    newOffers: number;
    confirmations: number;
    rechecks: number;
  };
  recheck: { enabled: boolean };
  stretch: { factor: number; applied: boolean };
  searches: {
    id: number | null;
    enabled: boolean;
    problem: PollProblem | null;
    /** Poll requests a day after stretching (all categories). */
    polls: number;
    sweeps: number;
    pollInterval: { minMinutes: number; maxMinutes: number };
    effectiveInterval: { minMinutes: number; maxMinutes: number };
  }[];
  warnings: ForecastWarning[];
};

function activeMinutes(activeHours: CrawlSettings["pacing"]["activeHours"]): number {
  return toMinutes(activeHours.end) - toMinutes(activeHours.start);
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function forecastDay(input: {
  searches: readonly ForecastSearch[];
  settings: CrawlSettings;
  /** Left out, the configured cap applies in full. */
  caps?: Pick<CapsInForce, "daily" | "halfBudgetUntil">;
}): Forecast {
  const { settings } = input;
  const dailyCap = input.caps?.daily ?? settings.pacing.dailyCap;
  const halfUntil = input.caps?.halfBudgetUntil ?? null;
  const minutes = activeMinutes(settings.pacing.activeHours);

  const perSearch = input.searches.filter(isCrawled).map((s) => {
    const categories = s.categories.length;
    const mean = (s.pollInterval.minMinutes + s.pollInterval.maxMinutes) / 2;
    const window = Math.min(Math.max(s.recencyDays, 1), MAX_RECENCY_DAYS);
    return {
      search: s,
      polls: categories * (minutes / mean) * PAGES_PER_POLL,
      sweeps: categories * Math.ceil((SWEEP_PAGES_PER_WEEK * window) / MAX_RECENCY_DAYS),
      newOffers: categories * NEW_OFFERS_PER_DAY,
      confirmations: categories * CONFIRMATIONS_PER_DAY,
    };
  });
  const sum = (pick: (row: (typeof perSearch)[number]) => number) =>
    perSearch.reduce((total, row) => total + pick(row), 0);
  const unstretchedPolls = sum((r) => r.polls);
  const sweeps = sum((r) => r.sweeps);
  const newOffers = sum((r) => r.newOffers);
  const confirmations = sum((r) => r.confirmations);

  const room = Math.floor(dailyCap * POLL_AND_SWEEP_SHARE);
  const pollRoom = Math.max(0, room - sweeps);
  const stretched = unstretchedPolls + sweeps > room;
  // With no room at all, polls are kept to about one a day rather than none.
  const factor = stretched ? unstretchedPolls / Math.max(pollRoom, 1) : 1;
  const polls = Math.round(unstretchedPolls / factor);

  const requests = {
    polls,
    sweeps,
    newOffers,
    confirmations,
    rechecks: Math.max(0, dailyCap - (polls + sweeps + newOffers + confirmations)),
  };

  const warnings: ForecastWarning[] = [];
  const rows = input.searches.map((s) => {
    const row = perSearch.find((r) => r.search === s);
    return {
      id: s.id ?? null,
      enabled: s.enabled,
      problem: s.problem,
      polls: row === undefined ? 0 : Math.round(row.polls / factor),
      sweeps: row?.sweeps ?? 0,
      pollInterval: s.pollInterval,
      effectiveInterval: {
        minMinutes: Math.min(round1(s.pollInterval.minMinutes * factor), MAX_POLL_MINUTES),
        maxMinutes: Math.min(round1(s.pollInterval.maxMinutes * factor), MAX_POLL_MINUTES),
      },
    };
  });
  // Every interval stretches by the same factor, so one warning covers them all.
  const slowest = Math.max(
    0,
    ...rows
      .filter(isCrawled)
      .map((r) => (r.effectiveInterval.minMinutes + r.effectiveInterval.maxMinutes) / 2),
  );
  if (stretched && slowest > MIN_POLL_MINUTES_BEFORE_WARNING) {
    warnings.push({
      type: "polls-below-one-per-2h",
      message: `With this many Searches, polls would drop below one per 2 h (about every ${Math.round(
        slowest / 60,
      )} h for the slowest Search) to stay within half the daily cap.`,
    });
  }
  if (stretched && pollRoom === 0) {
    warnings.push({
      type: "no-room-for-polls",
      message: "Sweeps alone take half the daily cap, so polls are cut to about one a day.",
    });
  }
  const total = polls + sweeps + newOffers + confirmations;
  if (total > dailyCap) {
    warnings.push({
      type: "over-budget",
      message: `About ${total} requests a day are expected against a cap of ${dailyCap}: new Offers will wait and no Rechecks run.`,
    });
  }

  return {
    dailyCap,
    halfBudget:
      halfUntil === null
        ? null
        : { until: new Date(halfUntil).toISOString(), fullDailyCap: settings.pacing.dailyCap },
    requests,
    recheck: { enabled: settings.recheck.enabled },
    stretch: { factor, applied: stretched },
    searches: rows,
    warnings,
  };
}

type ProblemOf = (search: SearchRow) => PollProblem | null;

export function storedForecastSearches(db: Db, problemOf: ProblemOf): ForecastSearch[] {
  return db
    .select()
    .from(searches)
    .orderBy(searches.id)
    .all()
    .map((s) => ({
      id: s.id,
      categories: s.categories,
      recencyDays: s.recencyDays,
      enabled: s.enabled,
      problem: problemOf(s),
      pollInterval: { minMinutes: s.pollMinMinutes, maxMinutes: s.pollMaxMinutes },
    }));
}

export function pollStretch(
  db: Db,
  problemOf: ProblemOf,
  settings: CrawlSettings,
  caps: Pick<CapsInForce, "daily" | "halfBudgetUntil">,
): number {
  const stored = storedForecastSearches(db, problemOf);
  return forecastDay({ searches: stored, settings, caps }).stretch.factor;
}

/** From 1 at opening to 0 at closing. */
function remainingActiveFraction(
  now: number,
  activeHours: CrawlSettings["pacing"]["activeHours"],
): number {
  const open = toMinutes(activeHours.start);
  const length = toMinutes(activeHours.end) - open;
  return Math.min(1, Math.max(0, (toMinutes(activeHours.end) - berlinMinuteOfDay(now)) / length));
}

/**
 * Holds back what the other kinds still need before active hours close, so Rechecks never starve
 * them.
 */
export function recheckRoom(input: {
  forecast: Forecast;
  usedToday: number;
  now: number;
  activeHours: CrawlSettings["pacing"]["activeHours"];
}): number {
  const { requests } = input.forecast;
  const higher = requests.polls + requests.sweeps + requests.newOffers + requests.confirmations;
  const stillNeeded = Math.ceil(higher * remainingActiveFraction(input.now, input.activeHours));
  return Math.max(0, input.forecast.dailyCap - input.usedToday - stillNeeded);
}
