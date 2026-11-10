import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderApiSchema, SCHEMA_PATH } from "../scripts/api-schema.js";

describe("typed API client", () => {
  it("matches the server's openapi.json: run `pnpm --filter @wg-hunt/cli generate:api` after changing the API", async () => {
    const committed = readFileSync(SCHEMA_PATH, "utf8");
    expect(await renderApiSchema()).toBe(committed);
  });
});
