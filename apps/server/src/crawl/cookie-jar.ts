import { CookieJar } from "tough-cookie";
import type { Db } from "../db/index.js";
import { readJson, writeJson } from "./kv.js";

const KEY = "crawl.cookie-jar";

export function loadCookieJar(db: Db): CookieJar {
  const stored = readJson(db, KEY);
  if (typeof stored === "object" && stored !== null) {
    try {
      return CookieJar.deserializeSync(stored as never);
    } catch {
      // Fall through to a fresh jar.
    }
  }
  return new CookieJar();
}

export function saveCookieJar(db: Db, jar: CookieJar, now: number): void {
  writeJson(db, KEY, jar.toJSON(), now);
}
