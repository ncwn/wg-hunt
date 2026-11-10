import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof openDatabase>;

// Found by walking up so it resolves from src/db/ under tsx and from dist/ in the bundle.
function findMigrationsFolder(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "drizzle", "meta", "_journal.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("drizzle migrations folder not found");
    dir = parent;
  }
  return join(dir, "drizzle");
}

const MIGRATIONS_FOLDER = findMigrationsFolder();

export function openDatabase(file: string) {
  const sqlite = new Database(file);
  // Only takes effect on a new file; an older one is converted by the first nightly prune. With
  // it, pages freed by pruning can be given back to the disk (`incremental_vacuum`).
  sqlite.pragma("auto_vacuum = INCREMENTAL");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}
