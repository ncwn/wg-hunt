import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const script = new URL("../scripts/check-release-tag.mjs", import.meta.url).pathname;

const RELEASE_VERSION: string = JSON.parse(read("package.json")).version;

const checkTag = (tag: string) =>
  run(process.execPath, [script, tag]).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (err: { code: number; stdout: string; stderr: string }) => err,
  );

describe("the release version", () => {
  it("is a plain semver version in the root package.json", () => {
    expect(RELEASE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is not also declared by the server or the CLI package", () => {
    for (const app of ["server", "cli"]) {
      expect(JSON.parse(read(`apps/${app}/package.json`)), app).not.toHaveProperty("version");
    }
  });
});

describe("check-release-tag", () => {
  it("accepts the tag v<root version>", async () => {
    const result = await checkTag(`v${RELEASE_VERSION}`);
    expect(result.code).toBe(0);
  });

  it.each([
    ["another version", "v0.0.0"],
    ["the version without its v", RELEASE_VERSION],
    ["a suffix", `v${RELEASE_VERSION}-rc.1`],
    ["no tag at all", ""],
  ])("refuses %s, naming both versions", async (_name, tag) => {
    const result = await checkTag(tag);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(RELEASE_VERSION);
  });
});

describe("release workflow: the version guard", () => {
  const workflow = read(".github/workflows/release.yml");

  it("checks the pushed tag against the root version", () => {
    expect(workflow).toMatch(/node scripts\/check-release-tag\.mjs "\$GITHUB_REF_NAME"/);
  });

  const job = (name: string) => {
    const lines = workflow.split("\n");
    const start = lines.indexOf(`  ${name}:`);
    expect(start, name).toBeGreaterThan(-1);
    const end = lines.findIndex((line, i) => i > start && /^ {2}\S/.test(line));
    return lines.slice(start, end === -1 ? undefined : end).join("\n");
  };

  it("runs before the image and the CLI jobs can publish anything", () => {
    expect(job("version")).toContain("check-release-tag");
    expect(job("image")).toMatch(/^ {4}needs: \[version, check\]$/m);
    expect(job("cli")).toMatch(/^ {4}needs: \[version, image\]$/m);
  });
});

describe("the image's version", () => {
  it("is checked by the smoke test against the root version, for the server and the CLI", () => {
    const smoke = read("scripts/smoke-container.sh");
    expect(smoke).toMatch(/package\.json/);
    expect(smoke).toMatch(/docker exec "\$NAME" wg-hunt --version/);
    expect(smoke).toMatch(/api\/v1\/health/);
  });
});

describe("CONTRIBUTING.md: releasing", () => {
  const guide = read("CONTRIBUTING.md");

  it("says to bump the root version, commit, then tag v<version>", () => {
    expect(guide).toMatch(/^#+ Releasing$/m);
    expect(guide).toMatch(/git tag v\d+\.\d+\.\d+/);
    expect(guide).toMatch(/root `package\.json`/);
  });

  it("says a failing check on the tagged commit stops the release", () => {
    const releasing = guide.slice(guide.search(/^#+ Releasing$/m));
    expect(releasing).toMatch(/lint, tests and build/);
    expect(releasing).toMatch(/publishes nothing/);
    expect(releasing).toContain("`.github/workflows/checks.yml`");
  });
});
