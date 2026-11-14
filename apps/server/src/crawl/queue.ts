import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { crawlJobs } from "../db/schema.js";
import { type JobKind, jobPriority } from "./constants.js";
import { checkSourcePath } from "./source-paths.js";

export type Job = {
  id: number;
  kind: JobKind;
  /** Lower is served first. */
  priority: number;
  path: string;
  payload: unknown;
  dueAt: number;
};

export type NewJob = {
  kind: JobKind;
  path: string;
  dueAt: number;
  payload?: unknown;
  /**
   * Serves the job in another kind's place while it stays its own kind for its handler and in the
   * request log.
   */
  priority?: number;
};

type Row = typeof crawlJobs.$inferSelect;

function toJob(row: Row): Job {
  return {
    id: row.id,
    kind: row.kind as JobKind,
    priority: row.priority,
    path: row.path,
    payload: row.payload === null ? undefined : JSON.parse(row.payload),
    dueAt: row.dueAt.getTime(),
  };
}

export function addJob(db: Db, job: NewJob): Job | null {
  const { pathname, search } = checkSourcePath(job.path);
  const row = db
    .insert(crawlJobs)
    .values({
      kind: job.kind,
      priority: job.priority ?? jobPriority(job.kind),
      path: `${pathname}${search}`,
      payload: job.payload === undefined ? null : JSON.stringify(job.payload),
      dueAt: new Date(job.dueAt),
    })
    .onConflictDoNothing()
    .returning()
    .get();
  if (row !== undefined) return toJob(row);
  db.update(crawlJobs)
    .set({ dueAt: sql`min(${crawlJobs.dueAt}, ${job.dueAt})` })
    .where(and(eq(crawlJobs.kind, job.kind), eq(crawlJobs.path, `${pathname}${search}`)))
    .run();
  return null;
}

export function nextDueJob(db: Db, now: number, kinds?: readonly JobKind[]): Job | undefined {
  const row = db
    .select()
    .from(crawlJobs)
    .where(
      kinds === undefined
        ? lte(crawlJobs.dueAt, new Date(now))
        : and(lte(crawlJobs.dueAt, new Date(now)), inArray(crawlJobs.kind, [...kinds])),
    )
    .orderBy(asc(crawlJobs.priority), asc(crawlJobs.dueAt), asc(crawlJobs.id))
    .limit(1)
    .get();
  return row && toJob(row);
}

export function nextDueAt(db: Db, now: number): number | undefined {
  return db
    .select({ dueAt: crawlJobs.dueAt })
    .from(crawlJobs)
    .where(gt(crawlJobs.dueAt, new Date(now)))
    .orderBy(asc(crawlJobs.dueAt))
    .limit(1)
    .get()
    ?.dueAt.getTime();
}

export function queuedJobs(db: Db, kind: JobKind): Job[] {
  return db
    .select()
    .from(crawlJobs)
    .where(eq(crawlJobs.kind, kind))
    .orderBy(asc(crawlJobs.id))
    .all()
    .map(toJob);
}

export function removeJob(db: Db, id: number): void {
  db.delete(crawlJobs).where(eq(crawlJobs.id, id)).run();
}

export function upcomingJobs(db: Db, now: number, limit: number): Job[] {
  const isDue = sql`${crawlJobs.dueAt} <= ${now}`;
  return db
    .select()
    .from(crawlJobs)
    .orderBy(
      sql`${isDue} desc`,
      sql`case when ${isDue} then ${crawlJobs.priority} else 0 end`,
      asc(crawlJobs.dueAt),
      asc(crawlJobs.id),
    )
    .limit(limit)
    .all()
    .map(toJob);
}
