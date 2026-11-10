import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findProjectRoot, loadConfig, relativeToProject } from "../src/config.js";

describe("loadConfig", () => {
  it("defaults the data folder to .data under the working directory", () => {
    expect(loadConfig({}, "/proj").dataDir).toBe("/proj/.data");
  });
  it("reads the data folder and port from the environment", () => {
    const c = loadConfig({ WG_HUNT_DATA_DIR: "/srv/data", WG_HUNT_PORT: "9000" }, "/proj");
    expect(c).toMatchObject({ dataDir: "/srv/data", port: 9000, host: "127.0.0.1" });
  });
  it("serves the dashboard build from apps/dashboard/dist unless told otherwise", () => {
    expect(loadConfig({}, "/proj").dashboardDir).toBe("/proj/apps/dashboard/dist");
    expect(loadConfig({ WG_HUNT_DASHBOARD_DIR: "/srv/web" }, "/proj").dashboardDir).toBe(
      "/srv/web",
    );
  });
  it("rejects an invalid port", () => {
    expect(() => loadConfig({ WG_HUNT_PORT: "abc" }, "/proj")).toThrow(/WG_HUNT_PORT/);
  });
});

describe("relativeToProject", () => {
  it("shows project-relative paths and hides foreign absolute paths", () => {
    expect(relativeToProject("/proj/.data/x.sqlite", "/proj")).toBe(".data/x.sqlite");
    expect(relativeToProject("/srv/data/x.sqlite", "/proj")).toBe("<outside project>/x.sqlite");
  });
});

describe("findProjectRoot", () => {
  it("walks up to the folder holding pnpm-workspace.yaml", () => {
    const root = mkdtempSync(join(tmpdir(), "wg-hunt-root-"));
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    const nested = join(root, "apps", "server");
    mkdirSync(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(root);
  });
  it("falls back to the start folder", () => {
    const lonely = mkdtempSync(join(tmpdir(), "wg-hunt-lonely-"));
    expect(findProjectRoot(lonely)).toBe(lonely);
  });
});
