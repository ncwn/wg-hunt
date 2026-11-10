import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchOpenApiDocument } from "@wg-hunt/api-codegen";
import { describe, expect, it } from "vitest";

const commandsDir = join(import.meta.dirname, "../src/commands");
const sources = readdirSync(commandsDir)
  .filter((file) => file.endsWith(".ts"))
  .map((file) => readFileSync(join(commandsDir, file), "utf8"))
  .join("\n");

// What the CLI leaves to other clients: the OpenAPI document itself, and the dashboard's cookie
// session (the CLI sends the token with every request, so it has no session to open or close).
const LEFT_OUT = new Set(["GET /openapi.json", "POST /auth/session", "DELETE /auth/session"]);

const UNSENT_QUERY = new Set([
  // `searches list` reads one page of 200, more Searches than anyone keeps.
  "GET /searches cursor",
  // wg-gesucht, the default, is the only Source.
  "GET /offers/lookup source",
]);

type Operation = { path: string; method: string; query: string[] };

async function operations(): Promise<Operation[]> {
  const document = await fetchOpenApiDocument();
  return Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
    Object.entries(item ?? {})
      .filter(([method]) => ["get", "put", "post", "patch", "delete"].includes(method))
      .map(([method, operation]) => ({
        path,
        method: method.toUpperCase(),
        query: ((operation as { parameters?: { in?: string; name?: string }[] }).parameters ?? [])
          .filter((parameter) => parameter.in === "query")
          .map((parameter) => parameter.name ?? ""),
      })),
  );
}

function callsTo({ path, method }: Operation): string[] {
  const opening = `client.${method}("${path}"`;
  const calls: string[] = [];
  for (
    let start = sources.indexOf(opening);
    start !== -1;
    start = sources.indexOf(opening, start + 1)
  ) {
    let depth = 0;
    let end = start + `client.${method}`.length;
    do {
      if (sources[end] === "(") depth++;
      else if (sources[end] === ")") depth--;
      end++;
    } while (depth > 0 && end < sources.length);
    calls.push(sources.slice(start, end));
  }
  return calls;
}

describe("the CLI covers the whole API", () => {
  it("has a command for every operation in openapi.json", async () => {
    const all = await operations();
    expect(all.length).toBeGreaterThan(40);

    const missing = all
      .filter(({ path, method }) => !LEFT_OUT.has(`${method} ${path}`))
      .filter(({ path, method }) => !sources.includes(`client.${method}("${path}"`))
      // The Ad ID and URL lookups are one call, made by the argument that names an Offer.
      .filter(({ path }) => path !== "/offers/lookup")
      .map(({ path, method }) => `${method} ${path}`);
    expect(missing, "operations no command calls; add one, or list it in LEFT_OUT").toEqual([]);
    expect(sources).toContain('client.GET("/offers/lookup"');
  });

  it("sends every query parameter of the operations it calls, so each has a flag", async () => {
    const all = await operations();
    const withQuery = all.filter((operation) => operation.query.length > 0);
    expect(withQuery.map(({ path }) => path)).toContain("/offers");

    const unsent = withQuery.flatMap((operation) => {
      const calls = callsTo(operation).join("\n");
      return operation.query
        .map((name) => `${operation.method} ${operation.path} ${name}`)
        .filter((key) => !UNSENT_QUERY.has(key))
        .filter((key) => {
          const name = key.split(" ")[2] ?? "";
          return !new RegExp(`\\b${name}\\b\\s*[:,}]`).test(calls);
        });
    });
    expect(
      unsent,
      "query parameters no command sends; add a flag, or list it in UNSENT_QUERY",
    ).toEqual([]);
  });
});
