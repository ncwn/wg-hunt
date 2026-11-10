import { type Hook, OpenAPIHono, z } from "@hono/zod-openapi";
import { compress } from "hono/compress";
import { HTTPException } from "hono/http-exception";
import { requireAuth } from "./api/auth.js";
import type { Api, ApiModule, AppDeps, AuthEnv } from "./api/context.js";
import { apiModules } from "./api/index.js";
import { fieldErrors, ProblemError, problemResponse, scrubPaths } from "./api/problem.js";
import { hasDashboardBuild, mountDashboard } from "./dashboard.js";
import { API_PREFIX } from "./prefix.js";
import { MIN_TOKEN_LENGTH } from "./token.js";

export type { AppDeps };

const validationHook: Hook<unknown, AuthEnv, string, unknown> = (result) => {
  if (!result.success) {
    throw new ProblemError(
      "validation-error",
      z.prettifyError(result.error),
      fieldErrors(result.error),
    );
  }
};

export function createApp(deps: AppDeps, extraModules: ApiModule[] = []) {
  if (deps.token.current().length < MIN_TOKEN_LENGTH) throw new Error("access token is too short");

  const api: Api = new OpenAPIHono<AuthEnv>({ defaultHook: validationHook });
  api.use("*", requireAuth(deps.token, deps.sessions, publicRouteMatcher(api)));
  for (const register of [...apiModules, ...extraModules]) register(api, deps);
  api.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
  });
  api.openAPIRegistry.registerComponent("securitySchemes", "cookieAuth", {
    type: "apiKey",
    in: "cookie",
    name: "wg_hunt_session",
  });

  const app = new OpenAPIHono();
  // Gzip what the browser asks for: the Offer list is about ten times smaller, and so is the
  // dashboard's script. The event stream is left alone, so its events are not held back.
  app.use("*", compress());
  app.route(API_PREFIX, api);
  if (deps.dashboardDir && hasDashboardBuild(deps.dashboardDir)) {
    mountDashboard(app, deps.dashboardDir);
  }
  for (const target of [api, app]) {
    target.notFound((c) => problemResponse(c, "not-found"));
    target.onError((err, c) => {
      if (err instanceof ProblemError) {
        const detail = err.detail && scrubPaths(err.detail, deps.projectRoot);
        return problemResponse(c, err.type, detail, undefined, err.errors, err.extensions);
      }
      if (err instanceof HTTPException) {
        // Hono raises these itself, for example for malformed JSON bodies.
        const type = err.status === 400 ? "invalid-body" : "http-error";
        return problemResponse(c, type, scrubPaths(err.message, deps.projectRoot), err.status);
      }
      console.error(`Unhandled error: ${scrubPaths(String(err.message), deps.projectRoot)}`);
      return problemResponse(c, "internal-error");
    });
  }
  return app;
}

/** Routes are public when their definition says `security: []`; HEAD follows GET. */
function publicRouteMatcher(api: Api) {
  let routes: { method: string; pattern: RegExp }[] | undefined;
  const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return (method: string, path: string) => {
    routes ??= api.openAPIRegistry.definitions.flatMap((definition) => {
      if (definition.type !== "route" || definition.route.security?.length !== 0) return [];
      const source = definition.route.path
        .split(/\{[^}]+\}/)
        .map(escapeRegExp)
        .join("[^/]+");
      return [
        {
          method: definition.route.method.toUpperCase(),
          pattern: new RegExp(`^${escapeRegExp(API_PREFIX)}${source}/?$`),
        },
      ];
    });
    const effective = method === "HEAD" ? "GET" : method;
    return routes.some((r) => r.method === effective && r.pattern.test(path));
  };
}
