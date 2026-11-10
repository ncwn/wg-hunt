const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Both sides are copies of server JSON, so their key order is the server's. */
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Arrays are taken whole (a list of Places is one answer). Where both changed the same value, the
 * draft's wins, since that is what the seeker meant to save.
 */
export function rebase<T>(base: T, draft: T, fresh: T): T {
  if (same(base, draft)) return fresh;
  if (isRecord(base) && isRecord(draft) && isRecord(fresh)) {
    const out: Record<string, unknown> = { ...fresh };
    for (const key of Object.keys(draft)) {
      out[key] =
        key in base && key in fresh ? rebase(base[key], draft[key], fresh[key]) : draft[key];
    }
    return out as T;
  }
  return draft;
}
