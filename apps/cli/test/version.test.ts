import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cliFor, serverWith } from "./harness.js";

const RELEASE_VERSION: string = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
).version;

describe("--version", () => {
  it("prints the release version on one line", async () => {
    const server = await serverWith();
    const result = await cliFor(server.runtime)("--version");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${RELEASE_VERSION}\n`);
  });

  it("matches the server it talks to", async () => {
    const server = await serverWith();
    const health = await (await server.runtime.app.request("/api/v1/health")).json();
    const result = await cliFor(server.runtime)("--version");
    expect(result.stdout.trim()).toBe(health.version);
  });
});
