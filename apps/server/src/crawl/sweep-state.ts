import type { Category } from "@wg-hunt/core";
import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { type SearchSweepRow, searchSweeps } from "../db/schema.js";

/**
 * `backfill`: the first read since the Search was made, edited or became readable; what it does
 * not see is dropped without a fetch. `daily`: each Offer it misses gets one confirmation fetch.
 */
type SweepMode = "backfill" | "daily";

/** Null once the category's results ended. */
type SweepCursors = Partial<Record<Category, number | null>>;

export type SweepState =
  | { status: "idle" }
  /** Epoch ms. */
  | { status: "scheduled"; mode: SweepMode; startAt: number }
  | {
      status: "running";
      mode: SweepMode;
      startedAt: number;
      cursors: SweepCursors;
      pagesRead: number;
      cardCount: number;
    };

export type Sweep = {
  specKey: string;
  generation: number;
  /** Epoch ms. Shown only. */
  lastFinishedAt: number | null;
  state: SweepState;
};

export type InvalidSweep = { invalid: true; specKey: string; generation: number };

export type SweepEvent =
  | { type: "stop"; specKey: string }
  | { type: "start"; specKey: string; mode: SweepMode; startAt: number }
  | {
      type: "page-read";
      categories: readonly Category[];
      category: Category;
      page: number;
      cards: number;
      more: boolean;
      now: number;
    }
  | { type: "give-up"; startAt: number }
  | { type: "finish"; now: number; startAt: number };

export class IllegalSweepTransition extends Error {
  constructor(from: string, event: SweepEvent["type"]) {
    super(`A Sweep that is ${from} can't take "${event}"`);
    this.name = "IllegalSweepTransition";
  }
}

export function isComplete(state: SweepState, categories: readonly Category[]): boolean {
  return (
    state.status === "running" && categories.every((category) => state.cursors[category] === null)
  );
}

export function transition(prev: Sweep | InvalidSweep | undefined, event: SweepEvent): Sweep {
  const generation = (prev?.generation ?? 0) + 1;
  const lastFinishedAt = prev === undefined || "invalid" in prev ? null : prev.lastFinishedAt;

  if (event.type === "stop") {
    return { specKey: event.specKey, generation, lastFinishedAt, state: { status: "idle" } };
  }
  if (event.type === "start") {
    return {
      specKey: event.specKey,
      generation,
      lastFinishedAt,
      state: { status: "scheduled", mode: event.mode, startAt: event.startAt },
    };
  }

  if (prev === undefined || "invalid" in prev) {
    throw new IllegalSweepTransition(prev === undefined ? "missing" : "invalid", event.type);
  }
  const state = prev.state;
  switch (event.type) {
    case "page-read": {
      if (state.status === "idle") throw new IllegalSweepTransition(state.status, event.type);
      const running =
        state.status === "running"
          ? state
          : {
              status: "running" as const,
              mode: state.mode,
              startedAt: event.now,
              cursors: Object.fromEntries(event.categories.map((c) => [c, 0])) as SweepCursors,
              pagesRead: 0,
              cardCount: 0,
            };
      return {
        ...prev,
        state: {
          ...running,
          cursors: { ...running.cursors, [event.category]: event.more ? event.page + 1 : null },
          pagesRead: running.pagesRead + 1,
          cardCount: running.cardCount + event.cards,
        },
      };
    }
    case "give-up": {
      if (state.status === "idle") throw new IllegalSweepTransition(state.status, event.type);
      // A backfill that is given up is still owed: the next try is a backfill too.
      return {
        ...prev,
        generation,
        state: { status: "scheduled", mode: state.mode, startAt: event.startAt },
      };
    }
    case "finish": {
      if (state.status !== "running") throw new IllegalSweepTransition(state.status, event.type);
      return {
        ...prev,
        generation,
        lastFinishedAt: event.now,
        state: { status: "scheduled", mode: "daily", startAt: event.startAt },
      };
    }
  }
}

const MODES: readonly string[] = ["backfill", "daily"] satisfies SweepMode[];
const isMode = (value: unknown): value is SweepMode =>
  typeof value === "string" && MODES.includes(value);

export function readSweep(
  row: SearchSweepRow,
  categories: readonly Category[],
): Sweep | InvalidSweep {
  const base = {
    specKey: row.specKey,
    generation: row.generation,
    lastFinishedAt: row.finishedAt?.getTime() ?? null,
  };
  const invalid: InvalidSweep = {
    invalid: true,
    specKey: row.specKey,
    generation: row.generation,
  };
  switch (row.status) {
    case "idle":
      return { ...base, state: { status: "idle" } };
    case "scheduled":
      if (!isMode(row.mode) || row.startAt === null) return invalid;
      return {
        ...base,
        state: { status: "scheduled", mode: row.mode, startAt: row.startAt.getTime() },
      };
    case "running": {
      const cursors = row.cursors;
      if (!isMode(row.mode) || row.startedAt === null || cursors === null) return invalid;
      const fits = categories.every((category) => {
        const cursor = cursors[category];
        return cursor === null || (Number.isInteger(cursor) && (cursor as number) >= 0);
      });
      if (!fits) return invalid;
      return {
        ...base,
        state: {
          status: "running",
          mode: row.mode,
          startedAt: row.startedAt.getTime(),
          cursors,
          pagesRead: row.pagesRead,
          cardCount: row.cardCount,
        },
      };
    }
    default:
      return invalid;
  }
}

export function sweepRowValues(searchId: number, sweep: Sweep): SearchSweepRow {
  const { state } = sweep;
  return {
    searchId,
    specKey: sweep.specKey,
    generation: sweep.generation,
    status: state.status,
    mode: state.status === "idle" ? null : state.mode,
    startAt: state.status === "scheduled" ? new Date(state.startAt) : null,
    startedAt: state.status === "running" ? new Date(state.startedAt) : null,
    cursors: state.status === "running" ? state.cursors : null,
    cardCount: state.status === "running" ? state.cardCount : 0,
    pagesRead: state.status === "running" ? state.pagesRead : 0,
    finishedAt: sweep.lastFinishedAt === null ? null : new Date(sweep.lastFinishedAt),
  };
}

export function writeSweep(db: Db, searchId: number, sweep: Sweep): void {
  const { searchId: _, ...values } = sweepRowValues(searchId, sweep);
  db.insert(searchSweeps)
    .values({ searchId, ...values })
    .onConflictDoUpdate({ target: searchSweeps.searchId, set: values })
    .run();
}

export function loadSweep(
  db: Db,
  searchId: number,
  categories: readonly Category[],
): Sweep | InvalidSweep | undefined {
  const row = db.select().from(searchSweeps).where(eq(searchSweeps.searchId, searchId)).get();
  return row && readSweep(row, categories);
}

/** Times are epoch ms. */
export type SweepView = {
  status: SweepState["status"];
  mode: SweepMode | null;
  startAt: number | null;
  pagesRead: number;
  lastFinishedAt: number | null;
};

export function sweepView(
  db: Db,
  search: { id: number; categories: readonly Category[] },
): SweepView {
  const sweep = loadSweep(db, search.id, search.categories);
  const lastFinishedAt = sweep === undefined || "invalid" in sweep ? null : sweep.lastFinishedAt;
  const state: SweepState =
    sweep === undefined || "invalid" in sweep ? { status: "idle" } : sweep.state;
  return {
    status: state.status,
    mode: state.status === "idle" ? null : state.mode,
    startAt: state.status === "scheduled" ? state.startAt : null,
    pagesRead: state.status === "running" ? state.pagesRead : 0,
    lastFinishedAt,
  };
}
