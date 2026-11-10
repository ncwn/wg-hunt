import { readJson, writeJson } from "../crawl/kv.js";
import type { Db } from "../db/index.js";
import { deleteSetting } from "../db/settings.js";
import { errorKind } from "../error-kind.js";

export { errorKind };

const CATCH_UP_KEY = "offers.catchUp";
const ADOPT_FAILURES_KEY = "offers.adoptFailures";

/** Items handled between two turns of the event loop, so a big backlog never stalls the API. */
const BATCH = 25;

/**
 * A stored page whose Offers step keeps throwing is tried again at each start for this long after
 * the first start that failed on it, so a fixed build can still adopt it.
 */
export const ADOPT_RETRY_DAYS = 7;

const CATCH_UP_PHASES = ["adoptPages", "backfillProfiles", "followCurrent", "reparse"] as const;
export type CatchUpPhaseName = (typeof CATCH_UP_PHASES)[number];

/** `pending`: not reached, and never will be once the catch-up has ended. */
export const CATCH_UP_PHASE_STATES = [
  "pending",
  "running",
  "finished",
  "stopped",
  "failed",
] as const;
type CatchUpPhaseState = (typeof CATCH_UP_PHASE_STATES)[number];

/** `finished`: every phase ran to its end; items may still have been skipped or have failed. */
export const CATCH_UP_STATES = ["running", "finished", "stopped", "failed"] as const;
type CatchUpState = (typeof CATCH_UP_STATES)[number];

type CatchUpCounts = {
  done: number;
  /** Left as it is because it can't be done: its page is deleted, gone or unreadable. */
  skipped: number;
  failed: number;
};

export type CatchUpStep = CatchUpCounts & {
  state: Exclude<CatchUpPhaseState, "pending" | "running">;
};

type PhaseRecord = CatchUpCounts & {
  state: CatchUpPhaseState;
  /** Epoch milliseconds; null until the phase is reached. */
  startedAt: number | null;
  finishedAt: number | null;
};

export type CatchUpRecord = {
  state: CatchUpState;
  /** Epoch milliseconds. */
  startedAt: number;
  finishedAt: number | null;
  phases: Record<CatchUpPhaseName, PhaseRecord>;
};

const isCount = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0;
const isTime = (value: unknown): value is number | null => value === null || isCount(value);

function isPhaseRecord(stored: unknown): stored is PhaseRecord {
  const phase = (stored ?? {}) as Partial<PhaseRecord>;
  return (
    CATCH_UP_PHASE_STATES.includes(phase.state as CatchUpPhaseState) &&
    isTime(phase.startedAt) &&
    isTime(phase.finishedAt) &&
    isCount(phase.done) &&
    isCount(phase.skipped) &&
    isCount(phase.failed)
  );
}

/** It is an earlier start's when this start could not write its own. */
export function readCatchUp(db: Db): CatchUpRecord | undefined {
  const stored = (readJson(db, CATCH_UP_KEY) ?? {}) as Partial<CatchUpRecord>;
  const fits =
    CATCH_UP_STATES.includes(stored.state as CatchUpState) &&
    isCount(stored.startedAt) &&
    isTime(stored.finishedAt) &&
    CATCH_UP_PHASES.every((name) => isPhaseRecord(stored.phases?.[name]));
  return fits ? (stored as CatchUpRecord) : undefined;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function catchUpReadout(record: CatchUpRecord) {
  const phase = (name: CatchUpPhaseName) => {
    const { state, startedAt, finishedAt, done, skipped, failed } = record.phases[name];
    return { state, startedAt: iso(startedAt), finishedAt: iso(finishedAt), done, skipped, failed };
  };
  return {
    state: record.state,
    startedAt: new Date(record.startedAt).toISOString(),
    finishedAt: iso(record.finishedAt),
    phases: {
      adoptPages: phase("adoptPages"),
      backfillProfiles: phase("backfillProfiles"),
      followCurrent: phase("followCurrent"),
      reparse: phase("reparse"),
    },
  };
}

export type StorageCatchUp = ReturnType<typeof catchUpReadout>;

/**
 * When the Offers step first threw on a stored page at a start, by `source/adId`, in epoch
 * milliseconds. Only for pages still waiting.
 */
export type AdoptFailures = Record<string, number>;

export function readAdoptFailures(db: Db): AdoptFailures {
  const stored = readJson(db, ADOPT_FAILURES_KEY);
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {};
  return Object.fromEntries(Object.entries(stored).filter(([, at]) => isCount(at)));
}

/** Not stored (the database is full, or closed after a stop), a page's week starts a start later. */
export function saveAdoptFailures(db: Db, failures: AdoptFailures, now: number): void {
  try {
    writeJson(db, ADOPT_FAILURES_KEY, failures, now);
  } catch {
    // The catch-up's own record says once per start that the database takes no writes.
  }
}

const DATABASE_WIDE = [
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_FULL",
  "SQLITE_IOERR",
  "SQLITE_READONLY",
  "SQLITE_CANTOPEN",
  "SQLITE_CORRUPT",
  "SQLITE_NOTADB",
  "SQLITE_NOMEM",
];

/**
 * The next item would fail the same way, and on a locked database only after waiting out the busy
 * timeout, so a phase stops at the first one.
 */
export function isDatabaseWide(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && DATABASE_WIDE.some((wide) => code.startsWith(wide));
}

const eventLoopTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

type ItemOutcome = keyof CatchUpCounts | "none";

export async function eachItem<T>(
  items: readonly T[],
  phase: {
    stopped: () => boolean;
    describe: (item: T) => string;
  },
  handle: (item: T) => ItemOutcome,
): Promise<CatchUpStep> {
  const counts: CatchUpCounts = { done: 0, skipped: 0, failed: 0 };
  for (const [index, item] of items.entries()) {
    // The wait is before an item, never after the last one, so a stop that arrives during it is
    // always reported.
    if (index > 0 && index % BATCH === 0) await eventLoopTurn();
    if (phase.stopped()) return { ...counts, state: "stopped" };
    try {
      const outcome = handle(item);
      if (outcome !== "none") counts[outcome]++;
    } catch (err) {
      const failure = `Catch-up: ${phase.describe(item)} failed: ${errorKind(err)}`;
      if (isDatabaseWide(err)) {
        console.error(`${failure}; the phase stops here`);
        return { ...counts, state: "failed" };
      }
      if (counts.failed === 0) console.error(failure);
      counts.failed++;
    }
  }
  return { ...counts, state: "finished" };
}

type CatchUpSteps = {
  adoptStoredPages(): Promise<CatchUpStep>;
  backfillProfiles(): Promise<CatchUpStep>;
  dedupePass(): unknown;
  followStoredCurrent(): Promise<CatchUpStep>;
  reparseOutdated(): Promise<CatchUpStep>;
};

const PHASE_LABEL: Record<CatchUpPhaseName, string> = {
  adoptPages: "adopting stored pages",
  backfillProfiles: "filling in dedupe profiles",
  followCurrent: "following current Ad IDs",
  reparse: "re-parsing outdated Offers",
};

const NONE: CatchUpCounts = { done: 0, skipped: 0, failed: 0 };

const pendingPhase = (): PhaseRecord => ({
  state: "pending",
  startedAt: null,
  finishedAt: null,
  ...NONE,
});

/**
 * `done` never rejects. Call `stop()` together with the Offers module's. Call `forget()` inside the
 * transaction that deletes all Offer data.
 */
export function startCatchUp(deps: {
  db: Db;
  /** Epoch milliseconds. */
  clock: () => number;
  offers: CatchUpSteps;
}): { record(): CatchUpRecord; done: Promise<CatchUpRecord>; stop(): void; forget(): void } {
  const { db, clock, offers } = deps;
  let stopping = false;
  /** How often all Offer data was deleted: what a phase counted before that no longer exists. */
  let wipes = 0;
  let unsaved = false;

  const steps: Record<CatchUpPhaseName, () => Promise<CatchUpStep>> = {
    adoptPages: () => offers.adoptStoredPages(),
    backfillProfiles: async () => {
      const step = await offers.backfillProfiles();
      // Profiles filled in just now may show Duplicates among the Offers already stored. After
      // a break-off the pass would only meet the same database, so the next start makes it.
      if (step.done > 0 && step.state !== "failed") offers.dedupePass();
      return step;
    },
    followCurrent: () => offers.followStoredCurrent(),
    reparse: () => offers.reparseOutdated(),
  };

  let record: CatchUpRecord = {
    state: "running",
    startedAt: clock(),
    finishedAt: null,
    phases: {
      adoptPages: pendingPhase(),
      backfillProfiles: pendingPhase(),
      followCurrent: pendingPhase(),
      reparse: pendingPhase(),
    },
  };

  /** The stored copy is bookkeeping: failing to write it never stops the catch-up itself. */
  function save(next: CatchUpRecord): void {
    record = next;
    try {
      writeJson(db, CATCH_UP_KEY, record, clock());
      unsaved = false;
    } catch (err) {
      // After a stop the database may already be closed, which is not worth a line.
      if (!unsaved && !stopping) {
        console.error(
          `Could not store how the catch-up went, so it is kept in memory: ${errorKind(err)}`,
        );
      }
      unsaved = true;
    }
  }

  const savePhase = (name: CatchUpPhaseName, change: Partial<PhaseRecord>) =>
    save({
      ...record,
      phases: { ...record.phases, [name]: { ...record.phases[name], ...change } },
    });

  async function run(): Promise<CatchUpRecord> {
    save(record);
    for (const [index, name] of CATCH_UP_PHASES.entries()) {
      // A phase's first write can sit out the busy timeout before it breaks off, so a shutdown
      // asked for meanwhile is heard here, before the next phase does the same.
      if (index > 0) await eventLoopTurn();
      if (stopping) break;
      savePhase(name, { state: "running", startedAt: clock() });
      const wipesBefore = wipes;
      try {
        const step = await steps[name]();
        if (step.state === "stopped") stopping = true;
        const counts = wipes === wipesBefore ? step : NONE;
        savePhase(name, { ...counts, state: step.state, finishedAt: clock() });
      } catch (err) {
        if (!stopping) console.error(`Catch-up: ${PHASE_LABEL[name]} broke off: ${errorKind(err)}`);
        savePhase(name, { state: "failed", finishedAt: clock() });
      }
    }
    const brokeOff = CATCH_UP_PHASES.some((name) => record.phases[name].state === "failed");
    save({
      ...record,
      state: stopping ? "stopped" : brokeOff ? "failed" : "finished",
      finishedAt: clock(),
    });
    return record;
  }

  return {
    record: () => record,
    done: run(),
    stop(): void {
      stopping = true;
    },
    /**
     * What it did, skipped and failed on is gone with the Offers, so the counts go back to none;
     * the states and times stay, since it did run. No Ad ID is left in the settings either.
     */
    forget(): void {
      deleteSetting(db, ADOPT_FAILURES_KEY);
      wipes++;
      const phases = { ...record.phases };
      for (const name of CATCH_UP_PHASES) phases[name] = { ...phases[name], ...NONE };
      save({ ...record, phases });
    },
  };
}
