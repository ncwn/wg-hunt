import { createHmac, randomBytes } from "node:crypto";
import { and, eq, lte, ne, or } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { dashboardSessions } from "./db/schema.js";
import { type AccessToken, tokenMatches } from "./token.js";

export const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

/** So a cookie that keeps being used, or a tab left open, still has to log in again. */
export const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** So reads don't each cost a write. */
const RENEW_EVERY_MS = 10 * 60 * 1000;

export type Credential = { via: "bearer"; token: string } | { via: "cookie"; id: string };

/** `expired` also covers reaching the maximum age and a token replaced while the server was down. */
export type EndReason = "signed-out" | "token-rotated" | "expired";

/**
 * The database holds only an HMAC of each session id keyed with the access token, so a database
 * copy is no cookie and a rotated or replaced token ends every session.
 */
export type Sessions = {
  start(): string;
  /** Counts as a use and renews the session. */
  isOpen(id: string): boolean;
  end(id: string): void;
  /** If the token write fails, nothing changes. */
  rotateToken(): string;
  /** Unlike `isOpen` it does not renew, so an open stream cannot keep its own session alive. */
  check(credential: Credential): EndReason | undefined;
  /** Expiry is not announced: `check` finds it. */
  watch(credential: Credential, onEnd: (reason: EndReason) => void): () => void;
};

export function createSessions(deps: {
  db: Db;
  token: AccessToken;
  clock: () => number;
}): Sessions {
  const { db, token, clock } = deps;
  const hash = (id: string) =>
    createHmac("sha256", token.current())
      .update(`wg-hunt dashboard session ${id}`)
      .digest("base64url");
  const tokenTag = () =>
    createHmac("sha256", token.current()).update("wg-hunt access token tag").digest("base64url");

  const watchers = new Set<{ key: string; onEnd: (reason: EndReason) => void }>();
  const notify = (reason: EndReason, key?: string) => {
    for (const watcher of [...watchers]) {
      if (key !== undefined && watcher.key !== key) continue;
      watchers.delete(watcher);
      watcher.onEnd(reason);
    }
  };

  const prune = () => {
    const now = clock();
    db.delete(dashboardSessions)
      .where(
        or(
          ne(dashboardSessions.tokenTag, tokenTag()),
          lte(dashboardSessions.lastUsedAt, new Date(now - SESSION_IDLE_MS)),
          lte(dashboardSessions.createdAt, new Date(now - SESSION_MAX_AGE_MS)),
        ),
      )
      .run();
  };
  prune();

  const lookUp = (id: string, renew: boolean) => {
    const idHash = hash(id);
    const row = db
      .select({ createdAt: dashboardSessions.createdAt, lastUsedAt: dashboardSessions.lastUsedAt })
      .from(dashboardSessions)
      .where(and(eq(dashboardSessions.idHash, idHash), eq(dashboardSessions.tokenTag, tokenTag())))
      .get();
    if (row === undefined) return false;
    const now = clock();
    const idle = now - row.lastUsedAt.getTime();
    if (idle >= SESSION_IDLE_MS || now - row.createdAt.getTime() >= SESSION_MAX_AGE_MS) {
      db.delete(dashboardSessions).where(eq(dashboardSessions.idHash, idHash)).run();
      return false;
    }
    if (renew && idle >= RENEW_EVERY_MS) {
      db.update(dashboardSessions)
        .set({ lastUsedAt: new Date(now) })
        .where(eq(dashboardSessions.idHash, idHash))
        .run();
    }
    return true;
  };

  return {
    start() {
      prune();
      const id = randomBytes(32).toString("base64url");
      const now = new Date(clock());
      db.insert(dashboardSessions)
        .values({ idHash: hash(id), tokenTag: tokenTag(), createdAt: now, lastUsedAt: now })
        .run();
      return id;
    },
    isOpen: (id) => lookUp(id, true),
    end(id) {
      const idHash = hash(id);
      db.delete(dashboardSessions).where(eq(dashboardSessions.idHash, idHash)).run();
      notify("signed-out", `cookie:${idHash}`);
    },
    rotateToken() {
      // The rows are keyed with the old token, so they stop matching the moment it is replaced;
      // deleting them only tidies up.
      const fresh = token.rotate();
      db.delete(dashboardSessions).run();
      notify("token-rotated");
      return fresh;
    },
    check(credential) {
      if (credential.via === "bearer") {
        return tokenMatches(token.current(), credential.token) ? undefined : "token-rotated";
      }
      return lookUp(credential.id, false) ? undefined : "expired";
    },
    watch(credential, onEnd) {
      const key = credential.via === "bearer" ? "bearer" : `cookie:${hash(credential.id)}`;
      const watcher = { key, onEnd };
      watchers.add(watcher);
      return () => {
        watchers.delete(watcher);
      };
    },
  };
}
