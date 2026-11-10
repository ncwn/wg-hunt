import { createRoute, z } from "@hono/zod-openapi";
import { API_PREFIX } from "../prefix.js";
import type { ApiModule } from "./context.js";

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["System"],
  security: [],
  responses: {
    200: {
      description: "The server is up",
      content: {
        "application/json": { schema: z.object({ status: z.literal("ok"), version: z.string() }) },
      },
    },
  },
});

const openApiRoute = createRoute({
  method: "get",
  path: "/openapi.json",
  tags: ["System"],
  security: [],
  responses: {
    200: {
      description: "This API's OpenAPI document",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
  },
});

export const registerSystem: ApiModule = (api, { version }) => {
  api.openapi(healthRoute, (c) => c.json({ status: "ok" as const, version }, 200));

  api.openapi(openApiRoute, (c) =>
    c.json(
      api.getOpenAPI31Document({
        openapi: "3.1.0",
        info: { title: "wg-hunt", version },
        servers: [{ url: API_PREFIX }],
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
      }),
      200,
    ),
  );
};
