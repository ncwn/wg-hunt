import { existsSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";

export type Config = {
  dataDir: string;
  port: number;
  host: string;
  dashboardDir?: string;
};

export const DATABASE_FILE = "wg-hunt.sqlite";
export const TOKEN_FILE = "access-token";
/** Where `pnpm build` leaves the dashboard, relative to the project root. */
const DASHBOARD_BUILD_DIR = "apps/dashboard/dist";

/** `start` itself when run outside the repository. */
export function findProjectRoot(start: string): string {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    if (dirname(dir) === dir) return resolve(start);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv, projectRoot: string): Config {
  const port = env.WG_HUNT_PORT === undefined ? 8787 : Number(env.WG_HUNT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("WG_HUNT_PORT must be an integer between 0 and 65535");
  }
  return {
    dataDir: resolve(projectRoot, env.WG_HUNT_DATA_DIR ?? ".data"),
    port,
    host: env.WG_HUNT_HOST ?? "127.0.0.1",
    dashboardDir: resolve(projectRoot, env.WG_HUNT_DASHBOARD_DIR ?? DASHBOARD_BUILD_DIR),
  };
}

/** Logs and errors show project-relative paths only, so no local path leaks. */
export function relativeToProject(path: string, projectRoot: string): string {
  const rel = relative(projectRoot, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
    return `<outside project>/${basename(path)}`;
  }
  return rel;
}
