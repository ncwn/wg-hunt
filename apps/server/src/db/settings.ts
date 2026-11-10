import { eq } from "drizzle-orm";
import type { Db } from "./index.js";
import { settings } from "./schema.js";

/** Keys are namespaced by the feature that owns them. */
export function getSetting(db: Db, key: string): { value: string; updatedAt: Date } | undefined {
  return db.select().from(settings).where(eq(settings.key, key)).get();
}

export function putSetting(db: Db, key: string, value: string, now = new Date()): Date {
  db.insert(settings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
    .run();
  return now;
}

export function deleteSetting(db: Db, key: string): void {
  db.delete(settings).where(eq(settings.key, key)).run();
}
