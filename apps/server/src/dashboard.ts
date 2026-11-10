import { existsSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { API_PREFIX } from "./prefix.js";

const INDEX_FILE = "index.html";
const ASSETS_PREFIX = "/assets/";

export function hasDashboardBuild(dashboardDir: string): boolean {
  return existsSync(join(dashboardDir, INDEX_FILE));
}

function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/") || path.startsWith(`${API_PREFIX}/`);
}

/**
 * `serveStatic` builds its response before `onFound` runs, so the dashboard's headers are set on
 * the finished response.
 */
function withHeaders(
  make: (onFound: (path: string, c: Context) => void) => MiddlewareHandler,
  fingerprinted: (c: Context) => boolean,
): MiddlewareHandler {
  const served = new WeakSet<Context>();
  const serve = make((_, c) => {
    served.add(c);
  });
  return async (c, next) => {
    const res = await serve(c, next);
    if (served.has(c)) {
      c.res.headers.set("X-Content-Type-Options", "nosniff");
      c.res.headers.set("X-Frame-Options", "DENY");
      c.res.headers.set("Referrer-Policy", "no-referrer");
      c.res.headers.set(
        "Cache-Control",
        fingerprinted(c) ? "public, max-age=31536000, immutable" : "no-cache",
      );
    }
    return res;
  };
}

/**
 * Public so the login screen loads. Extensionless paths fall back to `index.html` so client routes
 * survive a reload.
 */
export function mountDashboard(app: OpenAPIHono, dashboardDir: string): void {
  const files = withHeaders(
    (onFound) => serveStatic({ root: dashboardDir, onFound }),
    (c) => c.req.path.startsWith(ASSETS_PREFIX),
  );
  const index = withHeaders(
    (onFound) => serveStatic({ path: join(dashboardDir, INDEX_FILE), onFound }),
    () => false,
  );

  app.use("*", (c, next) => (isApiPath(c.req.path) ? next() : files(c, next)));
  app.use("*", (c, next) => {
    const lastSegment = c.req.path.split("/").pop() ?? "";
    const isRoute =
      (c.req.method === "GET" || c.req.method === "HEAD") && !lastSegment.includes(".");
    return isRoute && !isApiPath(c.req.path) ? index(c, next) : next();
  });
}
