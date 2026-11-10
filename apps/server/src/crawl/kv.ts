import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { settings } from "../db/schema.js";

export function readJson(db: Db, key: string): unknown {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  if (row === undefined) return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return undefined;
  }
}

export function writeJson(db: Db, key: string, value: unknown, now: number): void {
  const row = { key, value: JSON.stringify(value), updatedAt: new Date(now) };
  db.insert(settings)
    .values(row)
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: row.value, updatedAt: row.updatedAt },
    })
    .run();
}
