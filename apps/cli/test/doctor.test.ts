import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import release from "../../../package.json" with { type: "json" };
import { cliFor, problemOf, type Result, type Server, serverWith, tempDir } from "./harness.js";

function saved(config: { url?: string; token?: string }): string {
  const homeDir = tempDir();
  mkdirSync(join(homeDir, ".config", "wg-hunt"), { recursive: true });
  writeFileSync(join(homeDir, ".config", "wg-hunt", "config.json"), JSON.stringify(config));
  return homeDir;
}

function reportOf(result: Result): Record<string, unknown> {
  const report: unknown = JSON.parse(result.stdout);
  expect(typeof report).toBe("object");
  return report as Record<string, unknown>;
}

type Setup = (server: Server) => { argv: string[]; homeDir?: string; env: Record<string, string> };

const urlSetups: { source: string; url: string; setup: Setup }[] = [
  {
    source: "flag",
    url: "http://flag.test",
    setup: (server) => ({
      argv: ["--url", "http://flag.test/"],
      env: { WG_HUNT_URL: "http://env.test", WG_HUNT_TOKEN: server.runtime.token },
    }),
  },
  {
    source: "env",
    url: "http://env.test",
    setup: (server) => ({
      argv: [],
      homeDir: saved({ url: "http://saved.test" }),
      env: { WG_HUNT_URL: "http://env.test", WG_HUNT_TOKEN: server.runtime.token },
    }),
  },
  {
    source: "config",
    url: "http://saved.test",
    setup: (server) => ({
      argv: [],
      homeDir: saved({ url: "http://saved.test", token: server.runtime.token }),
      env: { WG_HUNT_PORT: "9001" },
    }),
  },
  {
    source: "default",
    url: "http://127.0.0.1:9001",
    setup: (server) => ({
      argv: [],
      env: { WG_HUNT_PORT: "9001", WG_HUNT_TOKEN: server.runtime.token },
    }),
  },
];

const tokenSetups: { source: string; setup: Setup }[] = [
  {
    source: "env",
    setup: (server) => ({
      argv: [],
      homeDir: saved({ url: "http://wg-hunt.test", token: "saved-but-shadowed" }),
      env: { WG_HUNT_URL: "http://wg-hunt.test", WG_HUNT_TOKEN: server.runtime.token },
    }),
  },
  {
    source: "config",
    setup: (server) => ({
      argv: [],
      homeDir: saved({ url: "http://wg-hunt.test", token: server.runtime.token }),
      env: { WG_HUNT_DATA_DIR: server.dataDir },
    }),
  },
  {
    source: "data-folder",
    setup: (server) => ({
      argv: [],
      env: { WG_HUNT_URL: "http://wg-hunt.test", WG_HUNT_DATA_DIR: server.dataDir },
    }),
  },
  {
    source: "none",
    setup: () => ({
      argv: [],
      env: { WG_HUNT_URL: "http://wg-hunt.test", WG_HUNT_DATA_DIR: join(tempDir(), "missing") },
    }),
  },
];

async function doctor(server: Server, setup: Setup, json: boolean): Promise<Result> {
  const { argv, homeDir, env } = setup(server);
  const wg = cliFor(server.runtime, { env, ...(homeDir && { homeDir }) });
  return wg(...argv, ...(json ? ["--json"] : []), "doctor");
}

function expectNoToken(server: Server, result: Result): void {
  for (const text of [result.stdout, result.stderr]) {
    expect(text).not.toContain(server.runtime.token);
    expect(text).not.toContain("saved-but-shadowed");
  }
}

describe("doctor", () => {
  it.each(urlSetups)("says the address came from $source", async ({ source, url, setup }) => {
    const server = await serverWith();
    const json = await doctor(server, setup, true);
    expect(reportOf(json)).toMatchObject({ url, urlSource: source });
    expectNoToken(server, json);

    const text = await doctor(server, setup, false);
    expect(text.stdout).toContain(`${url} (${source})`);
    expectNoToken(server, text);
  });

  it.each(tokenSetups)("says the token came from $source", async ({ source, setup }) => {
    const server = await serverWith();
    const json = await doctor(server, setup, true);
    expect(reportOf(json)).toMatchObject({ tokenSource: source });
    expectNoToken(server, json);

    const text = await doctor(server, setup, false);
    expect(text.stdout).toMatch(new RegExp(`^Token: +${source}$`, "m"));
    expectNoToken(server, text);
  });

  it("exits 0 with nothing on stderr when the server answers and takes the token", async () => {
    const server = await serverWith();
    const result = await cliFor(server.runtime)("--json", "doctor");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(reportOf(result)).toEqual({
      url: "http://wg-hunt.test",
      urlSource: "env",
      tokenSource: "env",
      server: "ok",
      serverVersion: release.version,
      signIn: "ok",
    });

    const text = await cliFor(server.runtime)("doctor");
    expect(text.code).toBe(0);
    expect(text.stderr).toBe("");
    expect(text.stdout).toMatch(new RegExp(`^Server: +ok, version ${release.version}$`, "m"));
    expect(text.stdout).toMatch(/^Sign-in: +ok$/m);
  });

  it.each([
    {
      case: "nothing answers",
      options: () => ({ fetch: () => Promise.reject(new TypeError("fetch failed")) }),
      report: { server: "no-answer", signIn: "not-checked" },
      type: "connection-failed",
    },
    {
      case: "something that is not wg-hunt answers",
      options: () => ({
        fetch: async () =>
          new Response("<html></html>", { headers: { "content-type": "text/html" } }),
      }),
      report: { server: "no-answer", signIn: "not-checked" },
      type: "connection-failed",
    },
    {
      case: "the server refuses the token",
      options: () => ({
        env: { WG_HUNT_URL: "http://wg-hunt.test", WG_HUNT_TOKEN: "Z".repeat(43) },
      }),
      report: { server: "ok", signIn: "refused" },
      type: "unauthorized",
    },
    {
      case: "there is no token",
      options: () => ({
        env: { WG_HUNT_URL: "http://wg-hunt.test", WG_HUNT_DATA_DIR: join(tempDir(), "missing") },
      }),
      report: { server: "ok", signIn: "no-token" },
      type: "not-configured",
    },
  ])("exits 1 when $case, with the report on stdout", async ({ options, report, type }) => {
    const server = await serverWith();
    const result = await cliFor(server.runtime, options())("--json", "doctor");
    expect(result.code).toBe(1);
    expect(reportOf(result)).toMatchObject(report);
    expect(problemOf(result).type).toBe(type);
    expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(result.stdout + result.stderr).not.toContain("Z".repeat(43));
  });

  it("does not call a failing wg-hunt something else when /health fails", async () => {
    const server = await serverWith();
    const result = await cliFor(server.runtime, {
      fetch: async () =>
        new Response(JSON.stringify({ type: "internal-error", title: "Internal error" }), {
          status: 500,
          headers: { "content-type": "application/problem+json" },
        }),
    })("--json", "doctor");
    expect(result.code).toBe(1);
    expect(reportOf(result)).toMatchObject({ server: "no-answer", signIn: "not-checked" });
    const problem = problemOf(result);
    expect(problem.type).toBe("connection-failed");
    expect(problem.detail).toContain("http://wg-hunt.test");
    expect(problem.detail).not.toMatch(/not as a wg-hunt server/);
  });
});
