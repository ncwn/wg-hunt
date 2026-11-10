import { apiSchema } from "@wg-hunt/api-codegen";

export const { SCHEMA_PATH, renderApiSchema, writeApiSchema } = apiSchema({
  schemaFile: new URL("../src/api/schema.d.ts", import.meta.url),
  generateCommand: "pnpm --filter @wg-hunt/cli generate:api",
});
