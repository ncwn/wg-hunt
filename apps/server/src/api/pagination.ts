import { z } from "@hono/zod-openapi";
import { DEFAULT_PAGE_LIMIT, decodeCursor, MAX_PAGE_LIMIT } from "@wg-hunt/core";
import { ProblemError } from "./problem.js";

export const paginationQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});

export function pageSchema<T extends z.ZodType>(name: string, item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() }).openapi(name);
}

export function cursorPosition(cursor: string | undefined): Record<string, unknown> | undefined {
  if (cursor === undefined) return undefined;
  const position = decodeCursor(cursor);
  if (position === null) throw new ProblemError("invalid-cursor");
  return position;
}
