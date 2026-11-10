import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("compose.yaml", () => {
  const compose = read("compose.yaml");

  it("publishes every port on 127.0.0.1 only", () => {
    const ports = [...compose.matchAll(/^\s*-\s*["']?(\d[\d.:]*\d)["']?\s*$/gm)];
    expect(ports.length).toBeGreaterThan(0);
    for (const [, mapping] of ports) expect(mapping).toMatch(/^127\.0\.0\.1:\d+:\d+$/);
  });

  it("always pulls the GHCR image and never builds", () => {
    expect(compose).toMatch(/^\s*image:\s*ghcr\.io\/ncwn\/wg-hunt:/m);
    expect(compose).toMatch(/^\s*pull_policy:\s*always\s*$/m);
    expect(compose).not.toMatch(/^\s*build:/m);
  });

  it("lets Watchtower update only the wg-hunt container", () => {
    expect(compose).toMatch(/com\.centurylinklabs\.watchtower\.enable=true/);
    expect(compose).toMatch(/^\s*command:.*--label-enable/m);
  });

  it("mounts the data folder from the project's gitignored .data", () => {
    expect(compose).toMatch(/^\s*-\s*\.\/\.data:\/app\/\.data\s*$/m);
    expect(read(".gitignore")).toMatch(/^\.data$/m);
  });

  it("restarts after a reboot, since wg-hunt is meant to be always on", () => {
    expect(compose).toMatch(/^\s*restart:\s*unless-stopped/m);
  });
});

describe("Dockerfile", () => {
  const dockerfile = read("Dockerfile");

  it("ships the dashboard build and points the server at it, so / serves the dashboard", () => {
    expect(dockerfile).toMatch(/^COPY --from=build \/repo\/apps\/dashboard\/dist \.\/dashboard$/m);
    expect(dockerfile).toMatch(/^\s*WG_HUNT_DASHBOARD_DIR=dashboard\b/m);
  });
});

describe("docker-entrypoint.sh", () => {
  const entrypoint = read("docker-entrypoint.sh");

  it("makes everything wg-hunt writes private to its user, before it starts it", () => {
    const umask = entrypoint.search(/^umask 077$/m);
    expect(umask).toBeGreaterThanOrEqual(0);
    expect(umask).toBeLessThan(entrypoint.search(/^\s*exec /m));
  });
});

describe("the CLI in the image", () => {
  const dockerfile = read("Dockerfile");

  it("is on PATH as wg-hunt, as the single bundled file", () => {
    expect(dockerfile).toMatch(
      /^COPY --from=build --chmod=755 \/repo\/apps\/cli\/dist\/wg-hunt\.mjs \/usr\/local\/bin\/wg-hunt$/m,
    );
  });

  it("finds its token in the data folder the image already points at", () => {
    expect(dockerfile).toMatch(/^\s*WG_HUNT_DATA_DIR=\.data\b/m);
    expect(read("scripts/smoke-container.sh")).toMatch(/docker exec "\$NAME" wg-hunt /);
  });
});

describe("release workflow", () => {
  const workflow = read(".github/workflows/release.yml");

  it("runs on version tags only", () => {
    expect(workflow).toMatch(/tags:\s*\n\s*-\s*["']?v\*/);
    expect(workflow).not.toMatch(/branches:/);
  });

  it("builds arm64 and amd64 and pushes to GHCR", () => {
    expect(workflow).toContain("linux/amd64");
    expect(workflow).toContain("linux/arm64");
    expect(workflow).toContain("ghcr.io");
    expect(workflow).toMatch(/packages:\s*write/);
  });

  it("smoke-tests the image before it is published", () => {
    const smoke = workflow.indexOf("scripts/smoke-container.sh");
    expect(smoke).toBeGreaterThan(-1);
    expect(smoke).toBeLessThan(workflow.indexOf("push: true"));
  });
});

describe("CI workflow", () => {
  it("smoke-tests the image on Linux, so a release is not the first run of it", () => {
    const workflow = read(".github/workflows/ci.yml");
    expect(workflow).toMatch(/^ {2}smoke:\n {4}runs-on: ubuntu-/m);
    expect(workflow).toContain("run: scripts/smoke-container.sh");
  });

  it("checks the data folder through the container, which the host may not read", () => {
    const smoke = read("scripts/smoke-container.sh");
    expect(smoke).not.toMatch(/\$DATA\/access-token/);
    expect(smoke).toMatch(/in_data 'test -s access-token'/);
  });
});

describe("release workflow: the checks", () => {
  const release = read(".github/workflows/release.yml");
  const callsTheChecks = /^ {2}check:\n {4}uses: \.\/\.github\/workflows\/checks\.yml$/m;

  it("pushes no image until lint, tests and build pass on the tagged commit", () => {
    expect(release).toMatch(/^ {2}image:\n {4}needs: \[version, check\]$/m);
    expect(release).toMatch(callsTheChecks);
    const checks = read(".github/workflows/checks.yml");
    for (const command of ["pnpm lint", "pnpm test", "pnpm build"]) {
      expect(checks).toMatch(new RegExp(`^ {6}- run: ${command}$`, "m"));
    }
    expect(checks).not.toMatch(/^\s*ref:/m);
  });

  it("are the checks CI runs, written once, so the two cannot drift", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toMatch(callsTheChecks);
    for (const caller of [ci, release]) {
      expect(caller).not.toMatch(/run: pnpm (lint|test|build)$/m);
    }
  });
});

describe("release workflow: the CLI bundle", () => {
  const workflow = read(".github/workflows/release.yml");

  it("attaches wg-hunt.mjs to the GitHub release of the tag", () => {
    expect(workflow).toMatch(/gh release upload "\$GITHUB_REF_NAME" apps\/cli\/dist\/wg-hunt\.mjs/);
    expect(workflow).toMatch(/contents:\s*write/);
  });

  it("runs the file with plain Node, away from the checkout, before attaching it", () => {
    const check = workflow.indexOf("node wg-hunt.mjs --version");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(workflow.indexOf("gh release upload"));
  });
});

describe("README.md", () => {
  const readme = read("README.md");

  it.each([
    ["the access token", /access-token/],
    ["upgrading", /update right away:\s+```sh\s+docker compose up -d\s+```/],
    ["where the data and secrets live", /API key and access token, is in `\.data\/`/],
    ["the CLI inside the container", /docker compose exec wg-hunt wg-hunt offers list/],
    ["the CLI release bundle", /wg-hunt\.mjs/],
    ["the license", /\[MIT\]\(LICENSE\)/],
  ])("documents %s", (_name, pattern) => {
    expect(readme).toMatch(pattern);
  });

  it("uses project-relative paths and names no one", () => {
    expect(readme).not.toMatch(/\/(Users|home|Volumes)\//);
    expect(readme).not.toMatch(/@(yahoo|gmail)\./);
  });
});
