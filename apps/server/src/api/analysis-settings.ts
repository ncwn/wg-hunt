import { createRoute } from "@hono/zod-openapi";
import {
  analysisSettingsSchema,
  loadAnalysisSettings,
  saveAnalysisSettings,
} from "../analysis-settings.js";
import type { ApiModule } from "./context.js";
import { problemResponses } from "./problem.js";
import { etagHeader, etagOf, ifMatchHeaders, requireRevision } from "./revision.js";

const getRoute = createRoute({
  method: "get",
  path: "/settings/analysis",
  tags: ["Analysis"],
  summary: "Model and effort for the analysis and escalation passes, spend cap and price table",
  responses: {
    200: {
      description:
        "The saved settings, or the defaults. A saved field that no longer parses is shown at its default: `settings` on `GET /analysis` names it",
      headers: etagHeader,
      content: { "application/json": { schema: analysisSettingsSchema } },
    },
  },
});

const putRoute = createRoute({
  method: "put",
  path: "/settings/analysis",
  tags: ["Analysis"],
  summary:
    "Replace the analysis settings. Each model must be in the price table, with an effort it supports",
  request: {
    headers: ifMatchHeaders,
    body: {
      content: { "application/json": { schema: analysisSettingsSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "The settings as saved",
      headers: etagHeader,
      content: { "application/json": { schema: analysisSettingsSchema } },
    },
    ...problemResponses("validation-error", "invalid-body", "origin-not-allowed", "stale-revision"),
  },
});

export const registerAnalysisSettings: ApiModule = (api, { db, analysis }) => {
  api.openapi(getRoute, (c) => {
    const settings = loadAnalysisSettings(db);
    return c.json(settings, 200, { ETag: etagOf(settings) });
  });

  api.openapi(putRoute, (c) => {
    requireRevision(c.req.valid("header")["if-match"], loadAnalysisSettings(db));
    saveAnalysisSettings(db, c.req.valid("json"));
    analysis.syncStatus();
    analysis.poke();
    // A lowered cap may now be below what is in flight: the batch loop cancels it.
    analysis.batch.kick();
    const settings = loadAnalysisSettings(db);
    return c.json(settings, 200, { ETag: etagOf(settings) });
  });
};
