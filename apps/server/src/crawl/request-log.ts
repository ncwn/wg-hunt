import { pageOf } from "@wg-hunt/core";
import { and, count, desc, eq, gte, lt } from "drizzle-orm";
import { cursorPosition } from "../api/pagination.js";
import { ProblemError } from "../api/problem.js";
import type { Db } from "../db/index.js";
import { crawlRequests } from "../db/schema.js";
import type { BotCheckMarker } from "./bot-check.js";
import type { JobKind } from "./constants.js";
import { loggedPath } from "./source-paths.js";

/**
 * A row is written `pending` before the request goes out and becomes `received` once the response
 * (or a network error) is in and its handler runs.
 * - `interrupted`: the server stopped before any response came; the job was still queued.
 * - `handler-interrupted`: the server stopped while its handler ran; the job had already left the
 *   queue.
 */
export const REQUEST_OUTCOMES = [
  "pending",
  "received",
  "ok",
  "redirect",
  "http-error",
  "network-error",
  "bot-check",
  "unexpected-page",
  "handler-error",
  "interrupted",
  "handler-interrupted",
] as const;
export type RequestOutcome = (typeof REQUEST_OUTCOMES)[number];

export type HandledOutcome = Extract<
  RequestOutcome,
  "ok" | "redirect" | "http-error" | "network-error" | "unexpected-page" | "handler-error"
>;

export function responseOutcome(
  response: { status: number } | undefined,
): Extract<HandledOutcome, "ok" | "redirect" | "http-error" | "network-error"> {
  if (response === undefined) return "network-error";
  if (response.status < 300) return "ok";
  if (response.status < 400) return "redirect";
  return "http-error";
}

export type RequestLogEntry = {
  id: number;
  at: string;
  kind: JobKind;
  path: string;
  status: number | null;
  outcome: RequestOutcome;
  /** Set on a `bot-check` row only. */
  marker: BotCheckMarker | null;
};

/** Writes the row before the request goes out, so a crash cannot hide a request from the caps. */
export function logRequestStart(
  db: Db,
  entry: { at: number; kind: JobKind; path: string },
): number {
  const row = db
    .insert(crawlRequests)
    .values({
      at: new Date(entry.at),
      kind: entry.kind,
      path: loggedPath(entry.path),
      outcome: "pending",
    })
    .returning({ id: crawlRequests.id })
    .get();
  return row.id;
}

/** The job has left the queue by now. */
export function logRequestReceived(db: Db, id: number, status: number | null): void {
  db.update(crawlRequests)
    .set({ status, outcome: "received" })
    .where(eq(crawlRequests.id, id))
    .run();
}

export function logRequestEnd(
  db: Db,
  id: number,
  result: {
    status: number | null;
    outcome: HandledOutcome | "bot-check";
    marker?: BotCheckMarker | undefined;
  },
): void {
  db.update(crawlRequests)
    .set({ status: result.status, outcome: result.outcome, marker: result.marker ?? null })
    .where(eq(crawlRequests.id, id))
    .run();
}

/** At boot, before any request. */
export function markInterrupted(db: Db): void {
  db.$client.transaction(() => {
    db.update(crawlRequests)
      .set({ outcome: "interrupted" })
      .where(eq(crawlRequests.outcome, "pending"))
      .run();
    db.update(crawlRequests)
      .set({ outcome: "handler-interrupted" })
      .where(eq(crawlRequests.outcome, "received"))
      .run();
  })();
}

const within = (from: number, to: number) =>
  and(gte(crawlRequests.at, new Date(from)), lt(crawlRequests.at, new Date(to)));

/** Counted in SQL: the engine asks on every step. */
export function requestCount(db: Db, from: number, to: number): number {
  return db.select({ n: count() }).from(crawlRequests).where(within(from, to)).get()?.n ?? 0;
}

export function nthLatestRequestTime(
  db: Db,
  from: number,
  to: number,
  n: number,
): number | undefined {
  return db
    .select({ at: crawlRequests.at })
    .from(crawlRequests)
    .where(within(from, to))
    .orderBy(desc(crawlRequests.at))
    .limit(1)
    .offset(n - 1)
    .get()
    ?.at.getTime();
}

export function lastRequestTime(db: Db): number | undefined {
  return db
    .select({ at: crawlRequests.at })
    .from(crawlRequests)
    .orderBy(desc(crawlRequests.at))
    .limit(1)
    .get()
    ?.at.getTime();
}

export function listRequests(db: Db, query: { limit: number; cursor?: string | undefined }) {
  const position = cursorPosition(query.cursor);
  if (position !== undefined && typeof position.id !== "number") {
    throw new ProblemError("invalid-cursor");
  }
  const after = position?.id as number | undefined;
  const rows = db
    .select()
    .from(crawlRequests)
    .where(after === undefined ? undefined : lt(crawlRequests.id, after))
    .orderBy(desc(crawlRequests.id))
    .limit(query.limit + 1)
    .all();
  return pageOf(
    rows.map(
      (r): RequestLogEntry => ({
        id: r.id,
        at: r.at.toISOString(),
        kind: r.kind,
        path: r.path,
        status: r.status,
        outcome: r.outcome,
        marker: r.marker,
      }),
    ),
    query.limit,
    (row) => ({ id: row.id }),
  );
}
