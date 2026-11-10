// Dev-only: generates the CLI's and dashboard's API client types from the OpenAPI document. It is
// its own package so openapi-typescript gets the TypeScript 5 compiler API; the server uses TS 7.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString, type OpenAPI3 } from "openapi-typescript";
import { startRuntime } from "../src/runtime.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export async function fetchOpenApiDocument(): Promise<OpenAPI3> {
  const dataDir = mkdtempSync(join(tmpdir(), "wg-hunt-openapi-"));
  const runtime = startRuntime({ dataDir, port: 0, host: "127.0.0.1" });
  try {
    const response = await runtime.app.request("/api/v1/openapi.json");
    return (await response.json()) as OpenAPI3;
  } finally {
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

export interface ApiSchemaTarget {
  schemaFile: URL;
  /** The command the "do not edit" banner names, such as `pnpm --filter @wg-hunt/cli generate:api`. */
  generateCommand: string;
}

export function apiSchema({ schemaFile, generateCommand }: ApiSchemaTarget) {
  const SCHEMA_PATH = fileURLToPath(schemaFile);
  const banner = `/**
 * Generated from the server's /api/v1/openapi.json. Do not edit by hand: change the API, then run
 * \`${generateCommand}\`. A test fails while this file is out of date.
 */

`;

  async function renderApiSchema(): Promise<string> {
    const ast = await openapiTS(await fetchOpenApiDocument());
    return banner + astToString(ast);
  }

  async function writeApiSchema(): Promise<void> {
    writeFileSync(SCHEMA_PATH, await renderApiSchema());
    console.log(`Wrote ${relative(REPO_ROOT, SCHEMA_PATH)}`);
  }

  return { SCHEMA_PATH, renderApiSchema, writeApiSchema };
}
