import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeProviders } from "@wg-hunt/core/analysis/testing";
import { afterEach } from "vitest";
import type { ApiModule } from "../src/api/context.js";
import type { Config } from "../src/config.js";
import { type Runtime, startRuntime } from "../src/runtime.js";

const dirs: string[] = [];
const runtimes: Runtime[] = [];

afterEach(() => {
  for (const r of runtimes.splice(0)) r.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

export function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wg-hunt-test-"));
  dirs.push(dir);
  return dir;
}

export function bootTestApp(
  dataDir = tempDataDir(),
  extraModules: ApiModule[] = [],
  configOverrides: Partial<Config> = {},
) {
  const runtime = startRuntime(
    { dataDir, port: 0, host: "127.0.0.1", ...configOverrides },
    process.cwd(),
    extraModules,
    undefined,
    undefined,
    undefined,
    fakeProviders(),
  );
  runtimes.push(runtime);
  return runtime;
}
