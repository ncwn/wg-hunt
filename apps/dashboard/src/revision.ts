import { type Answer, ask, type Result } from "./api/result.js";

/**
 * The Profile, the Filters and the crawl and analysis settings are each written whole, so the server
 * refuses a write whose `If-Match` is stale (412 `stale-revision`): a save from an old copy cannot
 * undo a change made since in another tab or by `wg.sh filters set`.
 */
export type Doc<T> = { data: T; revision: string | undefined };

/**
 * Compression marks a read's `ETag` weak, while `PUT /seeking` answers with the strong tag in its
 * body. Both name the same revision, and the page compares them to tell its own save from a change
 * made elsewhere.
 */
const revisionOf = (response: Response) =>
  response.headers.get("ETag")?.replace(/^W\//, "") ?? undefined;

export const ifMatch = (revision: string | undefined) =>
  revision === undefined ? {} : { header: { "if-match": revision } };

export const CHANGED_ELSEWHERE =
  "These were changed somewhere else after you started (another tab, Settings, or an agent). Your changes are now laid over what is saved; check them and save again.";

export const changedElsewhereUnread = (why: string) =>
  `These were changed somewhere else after you started, and wg-hunt couldn't read them just now: ${why} Save again to try once more.`;

export function readDoc<T>(call: () => Promise<Answer<T>>): Promise<Result<Doc<T>>> {
  return ask(async () => {
    const { data, ...answer } = await call();
    return {
      ...answer,
      data: data === undefined ? undefined : { data, revision: revisionOf(answer.response) },
    };
  });
}

export async function changeLatest<T, B>({
  read,
  write,
  change,
  start,
  tries = 3,
}: {
  read: () => Promise<Answer<T>>;
  write: (body: B, revision: string | undefined) => Promise<Answer<T>>;
  change: (latest: T) => { body: B } | { problem: string };
  start?: Doc<T> | undefined;
  tries?: number;
}): Promise<Result<Doc<T>>> {
  let latest = start;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (latest === undefined) {
      const fresh = await readDoc(read);
      if (!fresh.ok) return fresh;
      latest = fresh.data;
    }
    const next = change(latest.data);
    if ("problem" in next) return { ok: false, message: next.problem };
    const { revision } = latest;
    const written = await readDoc(() => write(next.body, revision));
    if (written.ok || written.status !== 412) return written;
    latest = undefined;
  }
  return { ok: false, message: CHANGED_ELSEWHERE, status: 412 };
}
