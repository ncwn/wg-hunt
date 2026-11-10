import { serve } from "@hono/node-server";
import { scrubPaths } from "./api/problem.js";
import { findProjectRoot, loadConfig, relativeToProject } from "./config.js";
import { startRuntime } from "./runtime.js";

const projectRoot = findProjectRoot(process.cwd());

function fail(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`wg-hunt failed to start: ${scrubPaths(message, projectRoot)}`);
  process.exit(1);
}

try {
  const config = loadConfig(process.env, projectRoot);
  const { app, crawl, offers, retention, shutdown } = startRuntime(config, projectRoot);
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`wg-hunt listening on http://${info.address}:${info.port}`);
    console.log(`Data folder: ${relativeToProject(config.dataDir, projectRoot)}`);
  });
  server.on("error", fail);
  void crawl.start();
  retention.start();
  offers.start();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      server.close();
      void shutdown().finally(() => process.exit(0));
    });
  }
} catch (err) {
  fail(err);
}
