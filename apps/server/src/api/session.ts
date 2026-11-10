import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { API_PREFIX } from "../prefix.js";
import type { Sessions } from "../sessions.js";
import { tokenMatches } from "../token.js";
import { SESSION_COOKIE, sameOrigin } from "./auth.js";
import type { ApiModule } from "./context.js";
import { ProblemError, problemResponses } from "./problem.js";

const createSessionRoute = createRoute({
  method: "post",
  path: "/auth/session",
  tags: ["Secrets and access"],
  summary: "Dashboard login: exchange the access token for a session cookie",
  security: [],
  request: {
    body: {
      content: { "application/json": { schema: z.object({ token: z.string().min(1) }) } },
      required: true,
    },
  },
  responses: {
    204: { description: "Session cookie set" },
    ...problemResponses("invalid-token", "origin-not-allowed", "validation-error", "invalid-body"),
  },
});

const checkSessionRoute = createRoute({
  method: "get",
  path: "/auth/session",
  tags: ["Secrets and access"],
  summary: "Check that the request is authenticated; the dashboard uses it to decide on login",
  responses: {
    204: { description: "The request carries a valid Bearer token or session cookie" },
    ...problemResponses("unauthorized"),
  },
});

const deleteSessionRoute = createRoute({
  method: "delete",
  path: "/auth/session",
  tags: ["Secrets and access"],
  summary: "Dashboard logout: end this session on the server and clear its cookie",
  description:
    "With a session cookie, that session ends on the server, so a copy of the cookie stops working; other sessions keep working. With a Bearer token nothing is revoked.",
  responses: {
    204: { description: "Session ended and its cookie cleared" },
    ...problemResponses("unauthorized", "origin-not-allowed"),
  },
});

const rotateTokenRoute = createRoute({
  method: "post",
  path: "/auth/token/rotate",
  tags: ["Secrets and access"],
  summary:
    "Replace the access token. The new token is returned this once; the old one and every dashboard session stop working",
  responses: {
    200: {
      description:
        "The new access token. A dashboard session that made the call is renewed for it; all others end.",
      content: { "application/json": { schema: z.object({ token: z.string() }) } },
    },
    ...problemResponses("unauthorized", "origin-not-allowed"),
  },
});

function startSession(c: Context, sessions: Sessions) {
  setCookie(c, SESSION_COOKIE, sessions.start(), {
    httpOnly: true,
    sameSite: "Strict",
    path: API_PREFIX,
  });
}

export const registerSession: ApiModule = (api, { token: access, sessions }) => {
  api.openapi(createSessionRoute, (c) => {
    // Login needs no credentials, but a browser-supplied foreign Origin is still refused.
    if (c.req.header("Origin") !== undefined && !sameOrigin(c)) {
      throw new ProblemError("origin-not-allowed");
    }
    if (!tokenMatches(access.current(), c.req.valid("json").token)) {
      throw new ProblemError("invalid-token");
    }
    startSession(c, sessions);
    return c.body(null, 204);
  });

  // `requireAuth` has already rejected unauthenticated requests by the time this runs.
  api.openapi(checkSessionRoute, (c) => c.body(null, 204));

  api.openapi(rotateTokenRoute, (c) => {
    const fresh = sessions.rotateToken();
    // Every session has ended; the dashboard that asked gets a new one on the new token.
    if (c.get("via") === "cookie") startSession(c, sessions);
    c.header("Cache-Control", "no-store");
    return c.json({ token: fresh }, 200);
  });

  api.openapi(deleteSessionRoute, (c) => {
    const id = getCookie(c, SESSION_COOKIE);
    if (c.get("via") === "cookie" && id !== undefined) sessions.end(id);
    deleteCookie(c, SESSION_COOKIE, { path: API_PREFIX });
    return c.body(null, 204);
  });
};
