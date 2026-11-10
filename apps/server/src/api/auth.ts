import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { Sessions } from "../sessions.js";
import { type AccessToken, tokenMatches } from "../token.js";
import type { AuthEnv } from "./context.js";
import { ProblemError } from "./problem.js";

export const SESSION_COOKIE = "wg_hunt_session";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function sameOrigin(c: Context): boolean {
  return c.req.header("Origin") === new URL(c.req.url).origin;
}

export function requireAuth(
  access: AccessToken,
  sessions: Sessions,
  isPublic: (method: string, path: string) => boolean,
): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    if (isPublic(c.req.method, c.req.path)) return next();

    const token = access.current();
    const bearer = c.req.header("Authorization")?.match(/^Bearer +(.+)$/i)?.[1];
    if (bearer !== undefined && tokenMatches(token, bearer)) {
      c.set("via", "bearer");
      c.set("credential", { via: "bearer", token: bearer });
      return next();
    }

    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie !== undefined && sessions.isOpen(cookie)) {
      c.set("via", "cookie");
      c.set("credential", { via: "cookie", id: cookie });
      if (!SAFE_METHODS.has(c.req.method) && !sameOrigin(c)) {
        throw new ProblemError(
          "origin-not-allowed",
          "Writes with a session cookie must come from the server's own origin.",
        );
      }
      return next();
    }

    throw new ProblemError(
      "unauthorized",
      "Send the access token as `Authorization: Bearer <token>`.",
    );
  };
}
