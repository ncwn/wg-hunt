import { encodeCursor, type OrderKey, SORTS, type Sort } from "@wg-hunt/core";
import { cursorPosition } from "./pagination.js";
import { ProblemError } from "./problem.js";

export const DEFAULT_SORT: Sort = "recency";

export type ListOrder = { sort: Sort; place: string | null };

export function offerCursor(key: OrderKey, order: ListOrder): string {
  return encodeCursor({ key, ...order });
}

/**
 * The keys of two orders are compared by position but mean different things, so a cursor used
 * under another order than its own is refused: it would skip rows without saying so.
 */
export function cursorKey(cursor: string | undefined, order: ListOrder): OrderKey | undefined {
  const position = cursorPosition(cursor);
  if (position === undefined) return undefined;
  const { key } = position;
  const from = orderOf(position);
  if (!isKey(key) || from === undefined) throw new ProblemError("invalid-cursor");
  if (from.sort !== order.sort) {
    throw new ProblemError(
      "invalid-cursor",
      `This cursor continues a list sorted by ${from.sort}, not by ${order.sort}. ${HOW_TO_GO_ON}`,
    );
  }
  if (from.place !== order.place) {
    throw new ProblemError(
      "invalid-cursor",
      `This cursor continues a list sorted by distance to another Place. ${HOW_TO_GO_ON}`,
    );
  }
  return key;
}

const HOW_TO_GO_ON =
  "Send it with the sort and the Place it came from, or leave it out to start from the top.";

function orderOf(position: Record<string, unknown>): ListOrder | undefined {
  const { sort, place } = position;
  return isSort(sort) && (place === null || typeof place === "string")
    ? { sort, place }
    : undefined;
}

const isKey = (key: unknown): key is OrderKey =>
  Array.isArray(key) &&
  key.length > 0 &&
  key.every((part) => typeof part === "number" && Number.isFinite(part));

const isSort = (sort: unknown): sort is Sort => SORTS.includes(sort as Sort);
