import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { encodeCursor } from "@wg-hunt/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cursorPosition, pageSchema, paginationQuery } from "../src/api/pagination.js";
import { ProblemError } from "../src/api/problem.js";

describe("paginationQuery", () => {
  it("defaults the limit to 50 and bounds it to 1..200", () => {
    expect(paginationQuery.parse({}).limit).toBe(50);
    expect(paginationQuery.parse({ limit: "10" }).limit).toBe(10);
    expect(() => paginationQuery.parse({ limit: "0" })).toThrow();
    expect(() => paginationQuery.parse({ limit: "201" })).toThrow();
  });
});

describe("cursorPosition", () => {
  it("returns undefined without a cursor and the position with a valid one", () => {
    expect(cursorPosition(undefined)).toBeUndefined();
    expect(cursorPosition(encodeCursor({ id: 3 }))).toEqual({ id: 3 });
  });
  it("throws an invalid-cursor problem for garbage", () => {
    expect(() => cursorPosition("%%%")).toThrow(ProblemError);
    try {
      cursorPosition("%%%");
    } catch (e) {
      expect((e as ProblemError).type).toBe("invalid-cursor");
    }
  });
});

describe("pageSchema", () => {
  it("registers a named component in the OpenAPI document", () => {
    const api = new OpenAPIHono();
    api.openapi(
      createRoute({
        method: "get",
        path: "/things",
        responses: {
          200: {
            description: "ok",
            content: {
              "application/json": { schema: pageSchema("ThingPage", z.object({ id: z.number() })) },
            },
          },
        },
      }),
      (c) => c.json({ items: [], nextCursor: null }, 200),
    );
    const doc = api.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "0" } });
    expect(Object.keys(doc.components?.schemas ?? {})).toContain("ThingPage");
  });
});
