import { createHash } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { ProblemError } from "./problem.js";

/**
 * A hash of the document as served, so it needs no stored counter, a fresh install's defaults have
 * one too, and writing back unchanged content keeps it.
 */
export function etagOf(document: unknown): string {
  const hash = createHash("sha256").update(JSON.stringify(document)).digest("hex");
  return `"${hash.slice(0, 16)}"`;
}

/**
 * A weak tag (`W/"…"`) matches too: compression marks the ETag weak on almost every read, and the
 * tag hashes the document itself, the same however it was encoded. So does a tag without its
 * quotes, which is how a revision typed by hand often arrives.
 */
export function isCurrent(ifMatch: string | undefined, current: unknown): boolean {
  if (ifMatch === undefined) return true;
  const wanted = ifMatch.trim();
  if (wanted === "*") return true;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, "").replaceAll('"', "");
  const etag = opaque(etagOf(current));
  return wanted.split(",").some((tag) => opaque(tag) === etag);
}

export function requireRevision(ifMatch: string | undefined, current: unknown): void {
  if (isCurrent(ifMatch, current)) return;
  throw new ProblemError(
    "stale-revision",
    "This was changed after you read it, so your change was not saved. Read it again, make the change to what is there now, and save that.",
  );
}

export const ifMatchHeaders = z.object({
  "if-match": z.string().optional().openapi({
    description:
      'The `ETag` from when the document was read, quoted, weak (`W/"…"`) or bare. If it has changed since, the write is refused with `stale-revision` (412) and nothing is saved. Left out, the document is replaced whatever its revision.',
    example: '"3f2a9c0d1b7e4a56"',
  }),
});

export const etagHeader = z.object({
  ETag: z.string().openapi({
    description: "The document's revision. Send it back as `If-Match` with the next PUT.",
    example: '"3f2a9c0d1b7e4a56"',
  }),
});
