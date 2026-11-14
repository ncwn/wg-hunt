import type { Command } from "commander";
import type { Reply } from "../api/client.js";
import type { Ctx } from "../context.js";
import { CliError, EXIT, usageError } from "../problem.js";

export type RevisionOptions = { ifMatch?: string; base?: string };

export function revisionOptions(command: Command): Command {
  return command
    .option(
      "--base <file>",
      "the `show --json` output the change started from: refused (exit 4) if it is no longer current",
    )
    .option(
      "--if-match <revision>",
      "refuse (exit 4) unless the revision printed by `show` is still current",
    );
}

const quoted = (revision: string) =>
  /^(W\/)?".*"$/.test(revision.trim()) ? revision.trim() : `"${revision.trim()}"`;

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (key) =>
      Object.hasOwn(b, key) &&
      sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

export async function ifMatchFor(
  ctx: Ctx,
  opts: RevisionOptions,
  read: () => Promise<Reply<unknown>>,
  /** The part of the document `set` writes (the crawl settings' constants are read-only). */
  editable: (document: unknown) => unknown = (document) => document,
  flags: { base: string; ifMatch: string } = { base: "--base", ifMatch: "--if-match" },
): Promise<string | undefined> {
  if (opts.ifMatch !== undefined && opts.base !== undefined) {
    throw usageError(`Give ${flags.base} or ${flags.ifMatch}, not both.`);
  }
  if (opts.ifMatch !== undefined) return quoted(opts.ifMatch);
  if (opts.base === undefined) return undefined;
  const base = await ctx.readJson(opts.base);
  const current = await read();
  if (!sameJson(editable(current.data), editable(base))) {
    throw new CliError(
      {
        type: "stale-revision",
        title: "Changed since it was read",
        status: 412,
        detail: `The saved document is no longer what ${opts.base} holds: it was changed after that was read, so nothing was saved. Run show again, make the change to what is there now, and set that.`,
      },
      EXIT.refused,
    );
  }
  return current.headers.get("ETag") ?? undefined;
}

export function showRevisioned<T>(ctx: Ctx, reply: Reply<T>, human: (data: T) => string): void {
  ctx.show(reply, human);
  const etag = reply.headers.get("ETag");
  if (etag) ctx.note(`Revision: ${etag}`);
}

export const ifMatchHeader = (ifMatch: string | undefined) =>
  ifMatch === undefined ? {} : { header: { "if-match": ifMatch } };
