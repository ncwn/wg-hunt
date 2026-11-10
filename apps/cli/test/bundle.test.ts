import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { build } from "tsdown";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serverWith } from "./harness.js";

const run = promisify(execFile);

const RELEASE_VERSION: string = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
).version;

describe("the release bundle", () => {
  // Not the harness's temporary folders, which are removed after each test.
  const root = mkdtempSync(join(tmpdir(), "wg-hunt-bundle-"));
  let bundle: string;

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  beforeAll(async () => {
    // Built the way `pnpm build` does, then copied away from the repository, so that nothing
    // can be found through its node_modules.
    const out = join(root, "out");
    await build({
      config: join(import.meta.dirname, "../tsdown.config.ts"),
      cwd: join(import.meta.dirname, ".."),
      outDir: out,
      logLevel: "silent",
    });
    bundle = join(root, "wg-hunt.mjs");
    copyFileSync(join(out, "wg-hunt.mjs"), bundle);
  }, 60_000);

  it("is one executable file that imports nothing from node_modules", () => {
    const text = readFileSync(bundle, "utf8");
    expect(text.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(statSync(bundle).mode & 0o111).not.toBe(0);
    const imports = [...text.matchAll(/^import .* from ["']([^"']+)["']/gm)].map((m) => m[1]);
    for (const specifier of imports) expect(specifier, "import").toMatch(/^node:/);
  });

  it("runs with plain Node on a machine without the repo, against a live server", async () => {
    const server = await serverWith();
    const http = serve({ fetch: server.runtime.app.fetch, port: 0, hostname: "127.0.0.1" });
    try {
      await new Promise((resolve) => http.once("listening", resolve));
      const address = http.address();
      const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      const env = { PATH: process.env.PATH, WG_HUNT_URL: url, WG_HUNT_TOKEN: server.runtime.token };
      const cwd = root;

      const listed = await run(process.execPath, [bundle, "offers", "list", "--json"], {
        env,
        cwd,
      });
      expect(JSON.parse(listed.stdout).items).toHaveLength(3);

      const version = await run(process.execPath, [bundle, "--version"], { env, cwd });
      expect(version.stdout).toBe(`${RELEASE_VERSION}\n`);

      const missing = await run(process.execPath, [bundle, "offer", "show", "99999"], {
        env,
        cwd,
      }).catch((err) => err);
      expect(missing.code).toBe(3);
      expect(JSON.parse(missing.stderr).type).toBe("not-found");

      const secret = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
        const child = execFile(
          process.execPath,
          [bundle, "secret", "set", "anthropic"],
          { env, cwd },
          (err, stdout) =>
            resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout }),
        );
        child.stdin?.end("sk-ant-api03-FROMPIPE0123456789\n");
      });
      expect(secret.code).toBe(0);
      expect(secret.stdout).not.toContain("FROMPIPE");
    } finally {
      http.close();
    }
  }, 30_000);
});
