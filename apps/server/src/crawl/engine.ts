import type { Db } from "../db/index.js";
import { errorKind } from "../error-kind.js";
import type { EventBus } from "../events.js";
import { LOW_DISK_BYTES } from "../retention/constants.js";
import { berlinDayStart, nextActiveInstant } from "./berlin-time.js";
import { type BotCheckMarker, detectBotCheck } from "./bot-check.js";
import {
  COOLDOWN_HISTORY_DAYS,
  COOLDOWN_LADDER_HOURS,
  GAP_FLOOR_SECONDS,
  HALF_BUDGET_HOURS,
  type JobKind,
} from "./constants.js";
import type { SourceFetcher, SourceResponse } from "./fetcher.js";
import { readJson, writeJson } from "./kv.js";
import {
  addJob,
  type Job,
  type NewJob,
  nextDueAt,
  nextDueJob,
  removeJob,
  upcomingJobs,
} from "./queue.js";
import {
  type HandledOutcome,
  lastRequestTime,
  logRequestEnd,
  logRequestReceived,
  logRequestStart,
  markInterrupted,
  nthLatestRequestTime,
  requestCount,
  responseOutcome,
} from "./request-log.js";
import {
  type CrawlSettings,
  loadCrawlSettings,
  readCrawlSettings,
  saveCrawlSettings,
} from "./settings.js";
import { checkSourcePath, ForbiddenPathError, loggedPath } from "./source-paths.js";
import type {
  BotCheckEvent,
  BotCheckRecord,
  CrawlHold,
  CrawlState,
  CrawlStatus,
  PauseCause,
  PauseReason,
  WaitReason,
} from "./status.js";

export type { WaitReason } from "./status.js";

const STATE_KEY = "crawl.engine";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_SLEEP_MS = 30_000;
/** Search pages (robots.txt allows them), in order of preference. */
const PROBE_KINDS: readonly JobKind[] = ["poll", "deeper-page"];
const MAX_RETRY_AFTER_MS = (COOLDOWN_LADDER_HOURS.at(-1) ?? 24) * HOUR;

export type HandlerResult = {
  /** Bot checks are caught before the handler runs. */
  unexpectedPage?: boolean;
};

/**
 * `response` is undefined when the request failed. A throwing handler pauses the crawl and the job
 * is not requeued.
 */
export type JobHandler = (
  job: Job,
  response: SourceResponse | undefined,
) => HandlerResult | undefined | Promise<HandlerResult | undefined>;

export type StepResult =
  | { state: "requested"; job: Job }
  | { state: "skipped"; job: Job }
  /** `until` is infinite while only a Resume helps. */
  | { state: "waiting"; reason: WaitReason; until: number }
  /** `until` is when the next queued job becomes due, if any. */
  | { state: "idle"; until?: number }
  | { state: "busy" };

export type CrawlEngine = ReturnType<typeof createCrawlEngine>;

export type ResumeResult =
  | { ok: true }
  | { ok: false; reason: "bot-check-cooldown"; until: number }
  | { ok: false; reason: "wipe-running" };

type HitEntry = {
  at: number;
  path: string;
  marker: BotCheckMarker;
  hourCount: number;
  dayCount: number;
};

/** Pacing and the stops share one entry so one write advances both. */
type EngineState = {
  nextRequestAt: number;
  sessionCount: number;
  paused?: {
    reason: PauseReason;
    /** A layout change only, and not one stored before causes were recorded. */
    cause?: PauseCause;
    at: number;
    path?: string;
    savedAs?: string;
  };
  /** Kept until the probe after it is answered (or a Resume), so its level is known meanwhile. */
  cooldown?: { until: number; level: number; needsResume: boolean };
  /** Oldest first. */
  hits: HitEntry[];
  lastBotCheck?: HitEntry;
  /** A Resume ended the Cooldown: the next request is the probe. */
  probe: boolean;
  halfBudgetUntil?: number;
};

export type CapSettings = Pick<CrawlSettings["pacing"], "hourlyCap" | "dailyCap">;

export type CapsInForce = {
  hourly: number;
  daily: number;
  /** Epoch ms the post-Cooldown halving ends; null when the caps are not halved. */
  halfBudgetUntil: number | null;
};

const halfBudgetUntilAt = (now: number, state: EngineState): number | null =>
  state.halfBudgetUntil !== undefined && now < state.halfBudgetUntil ? state.halfBudgetUntil : null;

function probePending(state: EngineState, now: number): boolean {
  const c = state.cooldown;
  return state.probe || (c !== undefined && now >= c.until && !c.needsResume);
}

const coolingAt = (state: EngineState, now: number): boolean =>
  state.cooldown !== undefined && now < state.cooldown.until;

function holdsOf(state: EngineState): CrawlHold[] {
  const holds: CrawlHold[] = [];
  if (state.paused) holds.push(state.paused.reason === "user" ? "paused" : state.paused.reason);
  if (state.cooldown?.needsResume) holds.push("needs-resume");
  return holds;
}

const holdReason = (state: EngineState): CrawlHold | undefined => holdsOf(state)[0];

function actionsOf(state: EngineState, now: number, wiping: boolean): CrawlStatus["actions"] {
  const resume = !wiping && !coolingAt(state, now) && holdsOf(state).length > 0;
  return { pause: state.paused === undefined && !resume, resume };
}

const iso = (ms: number) => new Date(ms).toISOString();

const toRecord = (h: HitEntry): BotCheckRecord => ({
  at: iso(h.at),
  path: h.path,
  marker: h.marker,
  hourCount: h.hourCount,
  dayCount: h.dayCount,
});

export function createCrawlEngine(deps: {
  db: Db;
  fetcher: SourceFetcher;
  /** Epoch milliseconds. */
  clock: () => number;
  /** Uniform in [0, 1). */
  random: () => number;
  sleep?: (ms: number) => Promise<void>;
  events?: EventBus;
  /** In the data folder, never the repository; returns its path relative to it. */
  saveRawPage?: (page: {
    at: number;
    kind: JobKind;
    path: string;
    body: string;
  }) => string | undefined;
  rawPageExists?: (savedAs: string) => boolean;
  /** Unknown means not checked. */
  freeBytes?: () => number | null | undefined;
}) {
  // Assumptions: the limits use the wall clock, so a forward clock jump can end a Cooldown early,
  // undetectably. One server process per data folder: the DB lock stops two sends within a gap,
  // but state read-modify-writes (Pause, Resume, hits) are not meant to race a second crawler.
  const { db, fetcher, clock, random } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const handlers = new Map<JobKind, JobHandler>();
  const idleListeners: (() => void)[] = [];
  const dropListeners: ((job: Job) => void)[] = [];
  const failListeners: ((job: Job) => void)[] = [];
  let inFlight: Promise<StepResult> | undefined;
  let stopped = true;
  let loop: Promise<void> | undefined;

  markInterrupted(db);

  function loadState(): EngineState {
    const raw = readJson(db, STATE_KEY) as Partial<EngineState> | undefined;
    return {
      ...raw,
      nextRequestAt: raw?.nextRequestAt ?? 0,
      sessionCount: raw?.sessionCount ?? 0,
      hits: Array.isArray(raw?.hits) ? raw.hits : [],
      probe: raw?.probe === true,
    };
  }

  const saveState = (state: EngineState, now: number) => writeJson(db, STATE_KEY, state, now);

  function capsAt(now: number, s: CapSettings, state: EngineState): CapsInForce {
    const until = halfBudgetUntilAt(now, state);
    const half = until !== null;
    return {
      hourly: half ? Math.max(1, Math.floor(s.hourlyCap / 2)) : s.hourlyCap,
      daily: half ? Math.max(1, Math.floor(s.dailyCap / 2)) : s.dailyCap,
      halfBudgetUntil: until,
    };
  }

  function limits(now: number, s: CrawlSettings["pacing"], state: EngineState) {
    const caps = capsAt(now, s, state);
    const lastAt = lastRequestTime(db);
    const gap = Math.max(
      state.nextRequestAt,
      lastAt === undefined ? 0 : lastAt + GAP_FLOOR_SECONDS * 1000,
    );

    const capth = nthLatestRequestTime(db, now - HOUR, now + 1, caps.hourly);
    const hourly = capth === undefined ? 0 : capth + HOUR;

    const dayEnd = berlinDayStart(now, 1);
    const daily = requestCount(db, berlinDayStart(now), dayEnd) >= caps.daily ? dayEnd : 0;

    const cooldown = state.cooldown !== undefined ? state.cooldown.until : 0;
    const hold = holdReason(state) === undefined ? 0 : Number.POSITIVE_INFINITY;

    return { gap, hourly, daily, cooldown, hold };
  }

  function drawBetween(minMs: number, maxMs: number): number {
    return Math.round(minMs + random() * (maxMs - minMs));
  }

  function afterRequest(state: EngineState, s: CrawlSettings["pacing"], at: number): EngineState {
    const sessionCount = state.sessionCount + 1;
    if (sessionCount >= s.sessionSize) {
      const breakMs = drawBetween(s.breakMinMinutes * 60_000, s.breakMaxMinutes * 60_000);
      return { ...state, nextRequestAt: at + breakMs, sessionCount: 0 };
    }
    return {
      ...state,
      nextRequestAt: at + drawBetween(s.gapMinSeconds * 1000, s.gapMaxSeconds * 1000),
      sessionCount,
    };
  }

  const countsAt = (now: number) => ({
    hour: requestCount(db, now - HOUR, now + 1),
    day: requestCount(db, berlinDayStart(now), berlinDayStart(now, 1)),
  });

  function withBotCheck(state: EngineState, hit: HitEntry, retryAfterSeconds: number | undefined) {
    const earlier = state.hits.filter((h) => hit.at - h.at <= COOLDOWN_HISTORY_DAYS * DAY);
    const index = Math.min(earlier.length, COOLDOWN_LADDER_HOURS.length - 1);
    const ladderMs = (COOLDOWN_LADDER_HOURS[index] as number) * HOUR;
    const requestedMs = Math.min((retryAfterSeconds ?? 0) * 1000, MAX_RETRY_AFTER_MS);
    const cooldown = {
      until: hit.at + Math.max(ladderMs, requestedMs),
      level: index + 1,
      needsResume: earlier.some((h) => hit.at - h.at <= DAY),
    };
    const { halfBudgetUntil: _ended, ...rest } = state;
    const next: EngineState = {
      ...rest,
      sessionCount: 0,
      hits: [...earlier, hit],
      lastBotCheck: hit,
      cooldown,
      probe: false,
    };
    return { state: next, cooldown };
  }

  function currentState(
    now: number,
    state: EngineState,
    pacing: CrawlSettings["pacing"],
  ): CrawlState {
    if (coolingAt(state, now)) return "cooling-down";
    const hold = holdReason(state);
    if (hold !== undefined) return hold;
    const active = nextActiveInstant(now, pacing.activeHours.start, pacing.activeHours.end);
    return active > now ? "outside-hours" : "running";
  }

  function nextRequestAt(
    now: number,
    pacing: CrawlSettings["pacing"],
    state: EngineState,
  ): { at: number | null; waitingFor: WaitReason | null } {
    const wait = waitFor(now, pacing, state);
    const waitingFor = wait?.reason ?? null;
    if (holdReason(state) !== undefined) return { at: null, waitingFor };
    const allowed = wait?.until ?? now;
    const firstDue = nextDueJob(db, now) !== undefined ? now : nextDueAt(db, now);
    if (firstDue === undefined) return { at: null, waitingFor };
    if (firstDue <= allowed) return { at: allowed, waitingFor };
    const at = nextActiveInstant(firstDue, pacing.activeHours.start, pacing.activeHours.end);
    return { at, waitingFor };
  }

  function status(): CrawlStatus {
    const now = clock();
    const state = loadState();
    const read = readCrawlSettings(db);
    const { pacing } = read.settings;
    const caps = capsAt(now, pacing, state);
    const counts = countsAt(now);
    const next = nextRequestAt(now, pacing, state);
    return {
      state: currentState(now, state, pacing),
      cooldown:
        state.cooldown === undefined
          ? null
          : {
              until: iso(state.cooldown.until),
              level: state.cooldown.level,
              needsResume: state.cooldown.needsResume,
            },
      paused: state.paused
        ? {
            reason: state.paused.reason,
            cause: state.paused.cause ?? null,
            since: iso(state.paused.at),
            path: state.paused.path ?? null,
            savedAs: rawPageStill(state.paused.savedAs),
          }
        : null,
      holds: holdsOf(state),
      nextRequest: { at: next.at === null ? null : iso(next.at), waitingFor: next.waitingFor },
      actions: actionsOf(state, now, wipeRunning),
      halfBudgetUntil: caps.halfBudgetUntil === null ? null : iso(caps.halfBudgetUntil),
      counts: {
        hour: { used: counts.hour, cap: caps.hourly },
        day: { used: counts.day, cap: caps.daily },
      },
      nextJobs: upcomingJobs(db, now, 10).map((j) => ({
        kind: j.kind,
        path: loggedPath(j.path),
        dueAt: iso(j.dueAt),
      })),
      lastBotCheck: state.lastBotCheck ? toRecord(state.lastBotCheck) : null,
      settings: { source: read.source, unreadable: read.unreadable },
    };
  }

  function rawPageStill(savedAs: string | undefined): string | null {
    if (savedAs === undefined) return null;
    try {
      return deps.rawPageExists?.(savedAs) === false ? null : savedAs;
    } catch {
      return savedAs;
    }
  }

  let lastPublished: string | undefined;
  let owedPublish: NodeJS.Immediate | undefined;

  /** Whatever changes what `status()` serves ends here: a write calls it (or `publishSoon`). */
  function publishStatus(options: { ifChanged?: boolean } = {}): void {
    if (!deps.events) return;
    const current = status();
    const serialized = JSON.stringify(current);
    if (options.ifChanged && serialized === lastPublished) return;
    lastPublished = serialized;
    clearImmediate(owedPublish);
    owedPublish = undefined;
    deps.events.publish("crawl-status-changed", current);
  }

  /**
   * Not at once: the caller may be inside a transaction that can still take the job back. An event
   * that says nothing new still makes a dashboard read its lists again.
   */
  function publishSoon(): void {
    if (!deps.events || owedPublish !== undefined) return;
    owedPublish = setImmediate(() => {
      owedPublish = undefined;
      // A shutdown may have closed the database since.
      if (!db.$client.open) return;
      try {
        publishStatus({ ifChanged: true });
      } catch (err) {
        // Not lost: the loop publishes whatever its next look finds changed.
        console.error(`Crawl status publish failed: ${err instanceof Error ? err.name : "error"}`);
      }
    });
  }

  function pauseForLayoutChange(
    job: Job,
    body: string | undefined,
    at: number,
    cause: PauseCause,
  ): void {
    const path = loggedPath(job.path);
    let savedAs: string | undefined;
    try {
      if (body !== undefined) savedAs = deps.saveRawPage?.({ at, kind: job.kind, path, body });
    } catch {
      savedAs = undefined;
    }
    db.$client
      .transaction(() => {
        const paused = {
          reason: "layout-changed" as const,
          cause,
          at,
          path,
          ...(savedAs !== undefined && { savedAs }),
        };
        saveState({ ...loadState(), paused }, at);
      })
      .immediate();
  }

  async function send(job: Job, logId: number): Promise<StepResult> {
    let response: SourceResponse | undefined;
    try {
      response = await fetcher.fetch(job.path);
    } catch {
      response = undefined;
    }

    const done = clock();
    const botCheck = response === undefined ? undefined : detectBotCheck(response);

    // The job leaves the queue before its handler runs, so the handler can queue it again.
    let hit: ReturnType<typeof withBotCheck> | undefined;
    db.$client
      .transaction(() => {
        let state = loadState();
        // A slow response must not shorten the gap.
        const floor = done + GAP_FLOOR_SECONDS * 1000;
        if (state.nextRequestAt < floor) state = { ...state, nextRequestAt: floor };
        removeJob(db, job.id);
        // With the job gone, a crash from here on is `handler-interrupted`, not `interrupted`.
        if (botCheck === undefined) logRequestReceived(db, logId, response?.status ?? null);
        if (botCheck !== undefined) {
          const counts = countsAt(done);
          hit = withBotCheck(
            state,
            {
              at: done,
              path: loggedPath(job.path),
              marker: botCheck.marker,
              hourCount: counts.hour,
              dayCount: counts.day,
            },
            response?.retryAfterSeconds,
          );
          state = hit.state;
          logRequestEnd(db, logId, {
            status: response?.status ?? null,
            outcome: "bot-check",
            marker: botCheck.marker,
          });
        } else if (probePending(state, done)) {
          if (response !== undefined && response.status >= 200 && response.status < 300) {
            const { cooldown: _over, ...rest } = state;
            state = { ...rest, probe: false, halfBudgetUntil: done + HALF_BUDGET_HOURS * HOUR };
          } else {
            const { pacing } = loadCrawlSettings(db);
            const breakMs = drawBetween(
              pacing.breakMinMinutes * 60_000,
              pacing.breakMaxMinutes * 60_000,
            );
            state = { ...state, nextRequestAt: Math.max(state.nextRequestAt, done + breakMs) };
          }
        }
        saveState(state, done);
      })
      .immediate();

    if (hit !== undefined) {
      const record = hit.state.lastBotCheck as HitEntry;
      const event: BotCheckEvent = {
        ...toRecord(record),
        cooldownUntil: iso(hit.cooldown.until),
        level: hit.cooldown.level,
        needsResume: hit.cooldown.needsResume,
      };
      deps.events?.publish("bot-check-cooldown", event);
      for (const listener of dropListeners) {
        try {
          listener(job);
        } catch (err) {
          console.error(`Drop listener failed: ${err instanceof Error ? err.name : "error"}`);
        }
      }
      publishStatus();
      return { state: "requested", job };
    }

    let outcome: HandledOutcome = responseOutcome(response);
    let unexpectedPage = false;
    let handlerFailed = false;
    try {
      const result = await handlers.get(job.kind)?.(job, response);
      unexpectedPage = result?.unexpectedPage === true;
    } catch (err) {
      // This line is the only place that says what threw: the disk, the database or the page.
      console.error(`Handling ${job.kind} ${loggedPath(job.path)} failed: ${errorKind(err)}`);
      outcome = "handler-error";
      handlerFailed = true;
    }
    if (unexpectedPage && response !== undefined) {
      outcome = "unexpected-page";
      pauseForLayoutChange(job, response.body, done, "unexpected-page");
    } else if (handlerFailed) {
      pauseForLayoutChange(job, response?.body, done, "handler-error");
    }

    logRequestEnd(db, logId, { status: response?.status ?? null, outcome });
    if (handlerFailed) {
      for (const listener of failListeners) {
        try {
          listener(job);
        } catch (err) {
          console.error(`Failure listener failed: ${err instanceof Error ? err.name : "error"}`);
        }
      }
    }
    publishStatus();
    return { state: "requested", job };
  }

  function waitFor(
    now: number,
    pacing: CrawlSettings["pacing"],
    state: EngineState,
  ): Extract<StepResult, { state: "waiting" }> | undefined {
    const bounds = limits(now, pacing, state);
    const earliest = Math.max(
      bounds.gap,
      bounds.hourly,
      bounds.daily,
      bounds.cooldown,
      bounds.hold,
    );
    const allowedAt =
      earliest === Number.POSITIVE_INFINITY
        ? earliest
        : nextActiveInstant(
            Math.max(earliest, now),
            pacing.activeHours.start,
            pacing.activeHours.end,
          );
    if (allowedAt <= now) return undefined;

    const hold = holdReason(state);
    if (state.cooldown !== undefined && coolingAt(state, now)) {
      // While a Resume is also owed, the Cooldown's end is the next thing that happens: the loop
      // wakes then to say so.
      const until = hold === undefined ? allowedAt : state.cooldown.until;
      return { state: "waiting", reason: "cooldown", until };
    }
    if (hold !== undefined) {
      return { state: "waiting", reason: hold, until: Number.POSITIVE_INFINITY };
    }
    const reason: WaitReason =
      earliest <= now
        ? "active-hours"
        : earliest === bounds.daily
          ? "daily-cap"
          : earliest === bounds.hourly
            ? "hourly-cap"
            : "gap";
    return { state: "waiting", reason, until: allowedAt };
  }

  type Claim = { send: { job: Job; logId: number } } | { result: StepResult };

  let pausedForDisk = false;
  /** In memory only, like the wipe itself. */
  let wipeRunning = false;
  function isDiskNearlyFull(): boolean {
    const free = deps.freeBytes?.();
    return free !== null && free !== undefined && free < LOW_DISK_BYTES;
  }

  /**
   * `.immediate()` takes the write lock first, so two processes cannot both pass the limits check,
   * and a crash after it still leaves the gap and caps owed.
   */
  const claim = db.$client.transaction((): Claim => {
    const now = clock();
    const { pacing } = loadCrawlSettings(db);

    let state = loadState();
    if (state.paused === undefined && isDiskNearlyFull()) {
      state = { ...state, paused: { reason: "disk-full", at: now } };
      saveState(state, now);
      pausedForDisk = true;
    }
    const job =
      (probePending(state, now) ? nextDueJob(db, now, PROBE_KINDS) : undefined) ??
      nextDueJob(db, now);
    if (job === undefined) {
      const until = nextDueAt(db, now);
      return { result: until === undefined ? { state: "idle" } : { state: "idle", until } };
    }

    try {
      checkSourcePath(job.path);
    } catch (err) {
      if (!(err instanceof ForbiddenPathError)) throw err;
      // Only a hand-edited queue gets here.
      removeJob(db, job.id);
      return { result: { state: "skipped", job } };
    }

    const wait = waitFor(now, pacing, state);
    if (wait !== undefined) return { result: wait };

    const logId = logRequestStart(db, { at: now, kind: job.kind, path: job.path });
    saveState(afterRequest(state, pacing, now), now);
    return { send: { job, logId } };
  });

  async function run(): Promise<StepResult> {
    pausedForDisk = false;
    let claimed = claim.immediate();
    if (pausedForDisk) publishStatus();
    if ("result" in claimed && claimed.result.state === "idle" && idleListeners.length > 0) {
      for (const listener of idleListeners) {
        try {
          listener();
        } catch (err) {
          console.error(`Idle listener failed: ${err instanceof Error ? err.name : "error"}`);
        }
      }
      claimed = claim.immediate();
    }
    return "result" in claimed ? claimed.result : send(claimed.send.job, claimed.send.logId);
  }

  function step(): Promise<StepResult> {
    if (inFlight !== undefined) return Promise.resolve({ state: "busy" });
    inFlight = run().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  async function loopUntilStopped(): Promise<void> {
    try {
      while (!stopped) {
        let wait = MAX_SLEEP_MS;
        try {
          const result = await step();
          // Time alone changes the status, and clients hold the last event as their copy.
          publishStatus({ ifChanged: true });
          if (result.state === "requested" || result.state === "skipped") continue;
          if (result.state === "busy") wait = 1000;
          else if (result.until !== undefined)
            wait = Math.min(Math.max(result.until - clock(), 1), MAX_SLEEP_MS);
        } catch (err) {
          console.error(`Crawl step failed: ${err instanceof Error ? err.name : "error"}`);
        }
        await sleep(wait);
      }
    } finally {
      loop = undefined;
    }
  }

  return {
    /** Null when the same kind and path is already queued. Throws on a forbidden path. */
    enqueue(job: Omit<NewJob, "dueAt"> & { dueAt?: number }): Job | null {
      const now = clock();
      const queued = addJob(db, { ...job, dueAt: job.dueAt ?? now });
      // Also when nothing was added: the waiting job's due time may have moved earlier.
      publishSoon();
      return queued;
    },

    onIdle(listener: () => void): void {
      idleListeners.push(listener);
    },

    /** A job dropped on a Bot check. */
    onDropped(listener: (job: Job) => void): void {
      dropListeners.push(listener);
    },

    onHandlerFailed(listener: (job: Job) => void): void {
      failListeners.push(listener);
    },

    on(kind: JobKind, handler: JobHandler): void {
      handlers.set(kind, handler);
    },

    step,

    status,

    /** The next request is the single probe after a Cooldown. */
    probing(): boolean {
      return probePending(loadState(), clock());
    },

    /** The single source for the caps. */
    caps(pacing: CapSettings = loadCrawlSettings(db).pacing): CapsInForce {
      return capsAt(clock(), pacing, loadState());
    },

    /** `at` is null while only a Resume helps or nothing is queued. */
    nextRequest(): { at: number | null; waitingFor: WaitReason | null } {
      return nextRequestAt(clock(), loadCrawlSettings(db).pacing, loadState());
    },

    /** Throws a ZodError on a broken constant. */
    saveSettings(value: CrawlSettings): CrawlSettings {
      const saved = saveCrawlSettings(db, value, clock());
      publishStatus();
      return saved;
    },

    pause(): void {
      const now = clock();
      db.$client
        .transaction(() => {
          const state = loadState();
          if (state.paused === undefined) {
            saveState({ ...state, paused: { reason: "user", at: now } }, now);
          }
        })
        .immediate();
      publishStatus();
    },

    resume(): ResumeResult {
      const now = clock();
      const result = db.$client
        .transaction((): ResumeResult => {
          if (wipeRunning) return { ok: false, reason: "wipe-running" };
          const state = loadState();
          if (state.cooldown !== undefined && coolingAt(state, now)) {
            return { ok: false, reason: "bot-check-cooldown", until: state.cooldown.until };
          }
          const { paused: _paused, cooldown, ...rest } = state;
          saveState({ ...rest, probe: state.probe || cooldown !== undefined }, now);
          return { ok: true };
        })
        .immediate();
      if (result.ok) publishStatus();
      return result;
    },

    /** Callers must not run two at once. */
    async whileWiping<T>(work: () => T): Promise<T> {
      const now = clock();
      const pauseForWipe = () =>
        db.$client
          .transaction(() => {
            const { paused: _paused, ...rest } = loadState();
            saveState({ ...rest, paused: { reason: "wiped", at: now } }, now);
          })
          .immediate();
      wipeRunning = true;
      try {
        pauseForWipe();
        publishStatus();
        await inFlight;
        // The request in flight may have paused for a layout change; the wipe deletes its page.
        pauseForWipe();
        return work();
      } finally {
        wipeRunning = false;
        publishStatus();
      }
    },

    /**
     * A `wiped` pause with no wipe at or after it (process stopped mid-wait, or the delete rolled
     * back) becomes a plain Pause, so the status never claims data was deleted that is still there.
     */
    settleWipePause(lastWipeAt: number | undefined): void {
      const now = clock();
      const changed = db.$client
        .transaction(() => {
          const state = loadState();
          const paused = state.paused;
          if (paused?.reason !== "wiped") return false;
          if (lastWipeAt !== undefined && lastWipeAt >= paused.at) return false;
          saveState({ ...state, paused: { reason: "user", at: paused.at } }, now);
          return true;
        })
        .immediate();
      if (changed) publishStatus();
    },

    /** A loop stopped but still asleep is kept going rather than joined by a second one. */
    start(): Promise<void> {
      stopped = false;
      loop ??= loopUntilStopped();
      return loop;
    },

    async stop(): Promise<void> {
      stopped = true;
      await inFlight;
    },
  };
}
