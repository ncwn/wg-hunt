import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Analysis } from "../analysis/worker.js";
import type { CrawlEngine } from "../crawl/engine.js";
import type { Rechecks } from "../crawl/rechecks.js";
import type { SearchPolling } from "../crawl/search-polls.js";
import type { Db } from "../db/index.js";
import type { EventBus } from "../events.js";
import type { Offers } from "../offers/offers.js";
import type { Retention } from "../retention/index.js";
import type { Credential, Sessions } from "../sessions.js";
import type { AccessToken } from "../token.js";

export type AuthEnv = {
  Variables: {
    via: "bearer" | "cookie";
    credential: Credential;
  };
};
export type Api = OpenAPIHono<AuthEnv>;

export type AppDeps = {
  db: Db;
  crawl: CrawlEngine;
  polling: SearchPolling;
  rechecks: Rechecks;
  offers: Offers;
  analysis: Analysis;
  retention: Retention;
  /** Epoch milliseconds. */
  clock: () => number;
  events: EventBus;
  /** Read it per request: rotation replaces it while the server runs. */
  token: AccessToken;
  /** Token rotation goes through here so that it ends them. */
  sessions: Sessions;
  version: string;
  projectRoot: string;
  dashboardDir?: string;
};

export type ApiModule = (api: Api, deps: AppDeps) => void;
