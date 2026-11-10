export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export type Page<T> = { items: T[]; nextCursor: string | null };

export function encodeCursor(position: Record<string, unknown>): string {
  const base64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(position))));
  return base64.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function decodeCursor(cursor: string): Record<string, unknown> | null {
  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Callers fetch `limit + 1` rows; the extra row only signals that another page exists. */
export function pageOf<T>(
  rows: T[],
  limit: number,
  position: (row: T) => Record<string, unknown>,
): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const nextCursor = rows.length > limit && last ? encodeCursor(position(last)) : null;
  return { items, nextCursor };
}
