import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { putSetting } from "../../server/src/db/settings.js";
import { WIPE_CONFIRMATION } from "../../server/src/retention/constants.js";
import { apiText, cliFor, limitRent, problemOf, serverWith, tempDir } from "./harness.js";

describe("--json", () => {
  const reads: [string[], string][] = [
    [["offers", "list"], "/offers"],
    [
      ["offers", "list", "--band", "match", "--sort", "warm-rent"],
      "/offers?band=match&sort=warm-rent",
    ],
    [["offers", "list", "--include-hidden", "--limit", "2"], "/offers?includeHidden=true&limit=2"],
    [["offers", "list", "--shortlisted"], "/offers?shortlisted=true"],
    [["offers", "counts"], "/offers/counts"],
    [["offer", "show", "1"], "/offers/1"],
    [["offer", "show", "ad:9000001"], "/offers/lookup?adId=9000001"],
    [["offers", "overrides"], "/offers/overrides"],
    [["searches", "list"], "/searches?limit=200"],
    [["search", "show", "1"], "/searches/1"],
    [["crawl", "status"], "/crawl"],
    [["crawl", "requests"], "/crawl/requests"],
    [["crawl", "forecast"], "/crawl/forecast"],
    [["profile", "show"], "/profile"],
    [["filters", "show"], "/filters"],
    [["preset", "example"], "/presets/example"],
    [["settings", "crawl", "show"], "/settings/crawl"],
    [["settings", "analysis", "show"], "/settings/analysis"],
    [["analysis", "status"], "/analysis"],
    [["storage", "show"], "/storage"],
    [["secret", "list"], "/secrets"],
    [["health"], "/health"],
  ];

  it.each(reads)("%j prints the API's response byte for byte", async (argv, path) => {
    const server = await serverWith();
    const expected = await apiText(server.runtime, path);
    expect(expected.status).toBe(200);
    const result = await cliFor(server.runtime)(...argv, "--json");
    expect(result.code).toBe(0);
    const steady = (text: string) => text.replace(/"freeBytes":\d+/, '"freeBytes":0');
    expect(steady(result.stdout)).toBe(steady(expected.text));
  });

  it("is also switched on by WG_HUNT_OUTPUT=json", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime, {
      env: {
        WG_HUNT_URL: "http://wg-hunt.test",
        WG_HUNT_TOKEN: server.runtime.token,
        WG_HUNT_OUTPUT: "json",
      },
    });
    expect((await wg("offers", "list")).stdout).toBe(
      (await apiText(server.runtime, "/offers")).text,
    );
  });

  it("is never switched on by itself: a pipe gets the table", async () => {
    const server = await serverWith();
    const result = await cliFor(server.runtime, { stdoutIsTTY: false })("offers", "list");
    expect(() => JSON.parse(result.stdout)).toThrow();
    expect(result.stdout).toContain("Cheap room");
  });

  it("ends with a newline on a terminal and adds nothing on a pipe", async () => {
    const server = await serverWith();
    const body = (await apiText(server.runtime, "/crawl")).text;
    expect(
      (await cliFor(server.runtime, { stdoutIsTTY: true })("crawl", "status", "--json")).stdout,
    ).toBe(`${body}\n`);
    expect((await cliFor(server.runtime)("crawl", "status", "--json")).stdout).toBe(body);
  });

  it("works before the command name too", async () => {
    const server = await serverWith();
    const result = await cliFor(server.runtime)("--json", "crawl", "status");
    expect(JSON.parse(result.stdout)).toHaveProperty("counts");
  });

  it("prints a problem the way the API sent it, on stderr", async () => {
    const server = await serverWith();
    const expected = await apiText(server.runtime, "/offers/99999");
    const result = await cliFor(server.runtime)("offer", "show", "99999", "--json");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`${expected.text}\n`);
  });

  it("prints a usage error as a problem too", async () => {
    const server = await serverWith();
    const result = await cliFor(server.runtime)("offers", "frobnicate", "--json");
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ type: "usage-error" });
  });
});

describe("human output", () => {
  it("lists Offers band by band with rent, size and what they miss", async () => {
    const server = await serverWith();
    await limitRent(server);
    const result = await cliFor(server.runtime)("offers", "list", "--include-hidden");
    const rows = result.stdout.trimEnd().split("\n");
    expect(rows[0]).toMatch(/^ID +BAND +RENT/);
    const cheap = rows.find((row) => row.includes("Cheap room"));
    const dear = rows.find((row) => row.includes("Dear room"));
    const dearest = rows.find((row) => row.includes("Dearest room"));
    expect(cheap).toMatch(/\bmatch\b/);
    expect(cheap).toContain("€450");
    expect(dear).toMatch(/near-match/);
    expect(dear).toContain("maxRent");
    expect(dearest).toMatch(/\bhidden\b/);
  });

  it("filters the list by band, and leaves Hidden out unless asked", async () => {
    const server = await serverWith();
    await limitRent(server);
    const wg = cliFor(server.runtime);
    const matches = (await wg("offers", "list", "--band", "match")).stdout;
    expect(matches).toContain("Cheap room");
    expect(matches).not.toContain("Dear room");
    expect((await wg("offers", "list")).stdout).not.toContain("Dearest room");
    expect((await wg("offers", "list", "--include-hidden")).stdout).toContain("Dearest room");
  });

  it("sorts, and reports an empty list in words", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime);
    const byRent = (await wg("offers", "list", "--sort", "warm-rent")).stdout;
    expect(byRent.indexOf("Cheap room")).toBeLessThan(byRent.indexOf("Dearest room"));
    expect((await wg("offers", "list", "--band", "hidden")).stdout.trim()).toBe("No Offers.");
  });

  it("limits to what is new since a span back from now", async () => {
    const server = await serverWith();
    const now = () => server.clock.now;
    const wg = cliFor(server.runtime, { now });
    expect((await wg("offers", "list", "--since", "24h")).stdout).toContain("Cheap room");
    const future = cliFor(server.runtime, { now: () => server.clock.now + 3 * 24 * 3_600_000 });
    expect((await future("offers", "list", "--since", "1h")).stdout.trim()).toBe("No Offers.");
    expect((await future("offers", "counts", "--since", "1h", "--json")).code).toBe(0);
  });

  it("says where the next page starts", async () => {
    const server = await serverWith();
    const first = await cliFor(server.runtime)("offers", "list", "--limit", "1");
    const cursor = /--cursor (\S+)/.exec(first.stdout)?.[1];
    expect(cursor).toBeTruthy();
    const second = await cliFor(server.runtime)(
      "offers",
      "list",
      "--limit",
      "1",
      "--cursor",
      cursor as string,
    );
    expect(second.code).toBe(0);
    expect(second.stdout).not.toBe(first.stdout);
  });

  it("refuses a cursor with another --sort than the one it came from", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime);
    const first = await wg("offers", "list", "--sort", "warm-rent", "--limit", "1");
    expect(first.stdout).toContain("Cheap room");
    const cursor = /--cursor (\S+)/.exec(first.stdout)?.[1] as string;

    const other = await wg("offers", "list", "--sort", "size", "--limit", "1", "--cursor", cursor);
    expect(other.code).toBe(2);
    expect(other.stdout).toBe("");
    expect(problemOf(other)).toMatchObject({
      type: "invalid-cursor",
      detail: expect.stringContaining("sorted by warm-rent, not by size"),
    });

    const same = await wg(
      "offers",
      "list",
      "--sort",
      "warm-rent",
      "--limit",
      "1",
      "--cursor",
      cursor,
    );
    expect(same.code).toBe(0);
    expect(same.stdout).toContain("Dear room");
  });

  it("shows an Offer by id, Ad ID or page URL, with its reasons, facts and Ad IDs", async () => {
    const server = await serverWith();
    await limitRent(server);
    const wg = cliFor(server.runtime);
    const byId = await wg("offer", "show", "2");
    expect(byId.stdout).toContain("Dear room");
    expect(byId.stdout).toContain("[near-match]");
    expect(byId.stdout).toMatch(/maxRent \(dealbreaker\)/);
    expect(byId.stdout).toContain("Ad IDs");
    expect(byId.stdout).toContain("9000002");
    const detail = JSON.parse((await wg("offer", "show", "2", "--json")).stdout);
    for (const ref of ["9000002", "ad:9000002", detail.url]) {
      const shown = await wg("offer", "show", ref, "--json");
      expect(shown.code, ref).toBe(0);
      expect(JSON.parse(shown.stdout).id, ref).toBe(2);
    }
  });

  it("describes the crawl, the Searches and the other readouts", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime);
    expect((await wg("crawl", "status")).stdout).toMatch(/State: +running/);
    expect((await wg("crawl", "status")).stdout).toMatch(/Next request: +\S/);
    const paused = (await wg("crawl", "pause")).stdout;
    expect(paused).toMatch(/Next request: +only after a Resume \(paused\)/);
    expect(paused).toMatch(/Waits for a person: +paused; Resume lifts them all/);
    await wg("crawl", "resume");
    expect((await wg("searches", "list")).stdout).toContain("Berlin");
    expect((await wg("profile", "show")).stdout).toContain("anmeldungNeeded");
    expect((await wg("filters", "show")).stdout).toContain("maxRent");
    expect((await wg("storage", "show")).stdout).toContain("offers");
    expect((await wg("analysis", "status")).stdout).toContain("Anthropic key");
    expect((await wg("health")).stdout).toMatch(/^ok +version /);
    expect((await wg("crawl", "requests")).stdout).toMatch(/^AT +KIND/);
  });
});

describe("crawl status while Offer data is deleted", () => {
  it("says a Resume waits for the deletion, not a Cooldown", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime);
    server.clock.now += 6 * 60 * 60_000;
    const original = server.fetcher.fetch;
    let release!: () => void;
    const opened = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      started = resolve;
    });
    server.fetcher.fetch = async (path) => {
      server.fetcher.fetch = original;
      started();
      await opened;
      return original(path);
    };
    server.runtime.crawl.enqueue({ kind: "poll", path: "/wg-zimmer-in-Berlin.8.0.1.0.html" });
    const step = server.runtime.crawl.step();
    await inFlight;
    const wipe = server.json("POST", "/storage/wipe", { confirm: WIPE_CONFIRMATION });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect((await wg("crawl", "status")).stdout).toMatch(
      /Waits for a person: +wiped; Resume once the deletion is done/,
    );
    release();
    await step;
    expect((await wipe).status).toBe(200);
    expect((await wg("crawl", "status")).stdout).toMatch(
      /Waits for a person: +wiped; Resume lifts them all/,
    );
  });
});

describe("the settings state", () => {
  it("prints which saved settings went back to their default, and how to keep them", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const server = await serverWith();
    const wg = cliFor(server.runtime);
    const analysis = JSON.parse((await wg("settings", "analysis", "show", "--json")).stdout);
    putSetting(server.runtime.db, "analysis", JSON.stringify({ ...analysis, effort: "extreme" }));
    const crawl = JSON.parse((await wg("settings", "crawl", "show", "--json")).stdout);
    delete crawl.constants;
    crawl.recheck.maxPageAgeHours = 0;
    crawl.recheck.enabled = "yes";
    putSetting(server.runtime.db, "crawl.settings", JSON.stringify(crawl));

    expect((await wg("analysis", "status")).stdout).toMatch(
      /^Settings: +partly-unreadable: effort is back at its default\. Saving the settings ends this: `wg-hunt settings analysis show --json > analysis\.json`, check it, then `wg-hunt settings analysis set --file analysis\.json`\.$/m,
    );
    expect((await wg("crawl", "status")).stdout).toMatch(
      /^Settings: +partly-unreadable: recheck\.enabled, recheck\.maxPageAgeHours are back at their default\. Saving the settings ends this: `wg-hunt settings crawl show --json > crawl\.json`, check it, then `wg-hunt settings crawl set --file crawl\.json`\.$/m,
    );
    expect((await wg("crawl", "pause")).stdout).toContain("recheck.maxPageAgeHours");

    for (const document of ["analysis", "crawl"]) {
      const file = join(tempDir(), `${document}.json`);
      writeFileSync(file, (await wg("settings", document, "show", "--json")).stdout);
      expect((await wg("settings", document, "set", "--file", file)).code).toBe(0);
    }
    expect((await wg("analysis", "status")).stdout).not.toMatch(/^Settings:/m);
    expect((await wg("crawl", "status")).stdout).not.toMatch(/^Settings:/m);
    vi.restoreAllMocks();
  });

  it("prints a line when nothing is saved and none once the settings are", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime);
    server.runtime.db.$client.prepare("DELETE FROM settings WHERE key = 'analysis'").run();
    expect((await wg("analysis", "status")).stdout).toMatch(
      /^Settings: +default: nothing is saved, so the defaults are in use$/m,
    );

    const crawl = JSON.parse((await wg("settings", "crawl", "show", "--json")).stdout);
    delete crawl.constants;
    putSetting(server.runtime.db, "crawl.settings", JSON.stringify(crawl));
    expect((await wg("crawl", "status")).stdout).not.toMatch(/^Settings:/m);
  });
});
