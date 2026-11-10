import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bootOffers } from "../../server/test/offers-harness.js";
import { cliFor, tempDir } from "./harness.js";

const DOCUMENTS: [string, string[]][] = [
  ["profile", ["profile"]],
  ["filters", ["filters"]],
  ["settings crawl", ["settings", "crawl"]],
  ["settings analysis", ["settings", "analysis"]],
];

function setup() {
  const server = bootOffers();
  const dir = tempDir();
  const wg = cliFor(server.runtime, { cwd: dir });
  const file = (name: string, value: unknown) => {
    writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
    return name;
  };
  return { server, wg, file };
}

function editable(text: string): unknown {
  const { constants: _constants, ...rest } = JSON.parse(text) as Record<string, unknown>;
  return rest;
}

describe("set with --base: the agent's show, edit, set", () => {
  it.each(DOCUMENTS)("%s set --base saves when nothing changed since show", async (_, cmd) => {
    const { wg, file } = setup();
    const shown = await wg("--json", ...cmd, "show");
    expect(shown.code).toBe(0);
    expect(shown.stderr).toBe("");
    const base = file("base.json", shown.stdout);
    const next = file("next.json", editable(shown.stdout));
    const result = await wg("--json", ...cmd, "set", "--file", next, "--base", base);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });

  it("refuses with stale-revision and exit 4 when the Filters changed after show", async () => {
    const { server, wg, file } = setup();
    const shown = await wg("--json", "filters", "show");
    const base = file("base.json", shown.stdout);
    const draft = JSON.parse(shown.stdout);
    draft.maxRent = { ...draft.maxRent, enabled: true, limit: 650 };
    const next = file("next.json", draft);

    const now = (await server.json("GET", "/filters")).body;
    now.hideLikelyScams.enabled = true;
    await server.json("PUT", "/filters", now);

    const result = await wg("--json", "filters", "set", "--file", next, "--base", base);
    expect(result.code).toBe(4);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ type: "stale-revision" });
    const after = (await server.json("GET", "/filters")).body;
    expect(after.hideLikelyScams.enabled).toBe(true);
    expect(after.maxRent.limit).toBeNull();
  });
});

describe("set with --if-match", () => {
  it("prints the revision with show and set for people, and refuses an old one", async () => {
    const { wg, file } = setup();
    const shown = await wg("profile", "show");
    const revision = /^Revision: ("[0-9a-f]{16}")$/m.exec(shown.stdout)?.[1];
    expect(revision).toBeDefined();
    const body = file("profile.json", (await wg("--json", "profile", "show")).stdout);

    const saved = await wg("profile", "set", "--file", body, "--if-match", revision ?? "");
    expect(saved.code).toBe(0);
    expect(saved.stdout).toContain(`Revision: ${revision}`);

    const stale = await wg("profile", "set", "--file", body, "--if-match", "0000000000000000");
    expect(stale.code).toBe(4);
    expect(JSON.parse(stale.stderr)).toMatchObject({ type: "stale-revision", status: 412 });
  });

  it("refuses --if-match together with --base", async () => {
    const { wg, file } = setup();
    const body = file("profile.json", (await wg("--json", "profile", "show")).stdout);
    const result = await wg("profile", "set", "--file", body, "--base", body, "--if-match", "x");
    expect(result.code).toBe(2);
  });
});

describe("seeking set", () => {
  async function measuring() {
    const it = setup();
    const profile = (await it.server.json("GET", "/profile")).body;
    await it.server.json("PUT", "/profile", {
      ...profile,
      places: [{ name: "work", plz: "10115" }],
    });
    const filters = (await it.server.json("GET", "/filters")).body;
    filters.distance = { ...filters.distance, enabled: true, place: "work", limit: 5 };
    await it.server.json("PUT", "/filters", filters);
    const profileShown = await it.wg("--json", "profile", "show");
    const filtersShown = await it.wg("--json", "filters", "show");
    const renamedProfile = JSON.parse(profileShown.stdout);
    renamedProfile.places[0].name = "office";
    const renamedFilters = JSON.parse(filtersShown.stdout);
    renamedFilters.distance.place = "office";
    return {
      ...it,
      files: {
        profile: it.file("profile.json", renamedProfile),
        filters: it.file("filters.json", renamedFilters),
        profileBase: it.file("profile-shown.json", profileShown.stdout),
        filtersBase: it.file("filters-shown.json", filtersShown.stdout),
      },
    };
  }

  it("renames a Place the distance Filter measures from, from two files and their two bases", async () => {
    const { server, wg, files } = await measuring();
    const result = await wg(
      "seeking",
      "set",
      "--profile",
      files.profile,
      "--filters",
      files.filters,
      "--profile-base",
      files.profileBase,
      "--filters-base",
      files.filtersBase,
    );
    expect(result.stdout).toMatch(/^Revisions: profile "[0-9a-f]{16}", filters "[0-9a-f]{16}"$/m);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Seeker Profile");
    expect(result.stdout).toContain("Filters");
    expect((await server.json("GET", "/profile")).body.places[0].name).toBe("office");
    expect((await server.json("GET", "/filters")).body.distance.place).toBe("office");
  });

  it("refuses an old --filters-if-match with exit 4 and saves neither half", async () => {
    const { server, wg, files } = await measuring();
    const result = await wg(
      "--json",
      "seeking",
      "set",
      "--profile",
      files.profile,
      "--filters",
      files.filters,
      "--filters-if-match",
      "0000000000000000",
    );
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stderr)).toMatchObject({ type: "stale-revision" });
    expect((await server.json("GET", "/profile")).body.places[0].name).toBe("work");
  });

  it("refuses through --filters-base when the Filters changed after show", async () => {
    const { server, wg, files } = await measuring();
    const now = (await server.json("GET", "/filters")).body;
    now.hideLikelyScams.enabled = true;
    await server.json("PUT", "/filters", now);

    const result = await wg(
      "--json",
      "seeking",
      "set",
      "--profile",
      files.profile,
      "--filters",
      files.filters,
      "--filters-base",
      files.filtersBase,
    );
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stderr)).toMatchObject({ type: "stale-revision" });
    expect((await server.json("GET", "/profile")).body.places[0].name).toBe("work");
  });

  it("needs --profile or --filters, and one of a half's base and if-match", async () => {
    const { wg, files } = await measuring();
    expect((await wg("seeking", "set")).code).toBe(2);
    const both = await wg(
      "seeking",
      "set",
      "--profile",
      files.profile,
      "--profile-base",
      files.profileBase,
      "--profile-if-match",
      "x",
    );
    expect(both.code).toBe(2);
    expect(both.stderr).toContain("--profile-base or --profile-if-match");
  });
});
