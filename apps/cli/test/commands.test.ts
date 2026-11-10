import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JobHandler } from "../../server/src/crawl/engine.js";
import { breakPrune } from "../../server/test/retention-harness.js";
import { apiText, cliFor, limitRent, serverWith, tempDir } from "./harness.js";

const get = async (server: Awaited<ReturnType<typeof serverWith>>, path: string) =>
  JSON.parse((await apiText(server.runtime, path)).text);

describe("offers", () => {
  it("marks an Offer, and takes the mark away again", async () => {
    const server = await serverWith();
    await limitRent(server);
    const wg = cliFor(server.runtime);

    expect((await wg("offer", "mark", "1", "--shortlisted", "--contacted")).code).toBe(0);
    expect((await get(server, "/offers/1")).marks).toEqual({
      dismissed: false,
      shortlisted: true,
      contacted: true,
    });

    expect((await wg("offer", "mark", "1", "--no-shortlisted")).code).toBe(0);
    expect((await get(server, "/offers/1")).marks.shortlisted).toBe(false);

    const dismissed = await wg("offer", "mark", "1", "--dismissed");
    expect(dismissed.stdout).toContain("[hidden]");
    expect((await get(server, "/offers/1")).band).toBe("hidden");
    await wg("offer", "mark", "1", "--no-dismissed");
    expect((await get(server, "/offers/1")).band).toBe("match");
  });

  it("overrides the Likely scam verdict", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime);
    expect((await wg("offer", "mark", "1", "--scam", "scam")).code).toBe(0);
    expect((await get(server, "/offers/1")).band).toBe("warned");
    expect((await wg("offer", "mark", "1", "--scam", "clear")).code).toBe(0);
    expect((await get(server, "/offers/1")).band).not.toBe("warned");
    expect((await wg("offer", "mark", "1", "--scam", "maybe")).code).toBe(2);
  });

  it("marks an Offer named by Ad ID", async () => {
    const server = await serverWith();
    const result = await cliFor(server.runtime)("offer", "mark", "ad:9000003", "--dismissed");
    expect(result.code).toBe(0);
    expect((await get(server, "/offers/3")).marks.dismissed).toBe(true);
  });

  it("corrects a fact by hand and reverts it", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime);
    const set = await wg("offer", "fact", "set", "1", "anmeldung", "possible");
    expect(set.code).toBe(0);
    expect((await get(server, "/offers/1")).facts.anmeldung).toMatchObject({
      origin: "manual",
      value: "possible",
    });
    expect((await wg("offers", "overrides")).stdout).toContain("anmeldung");
    const [listed] = JSON.parse((await wg("offers", "overrides", "--json")).stdout).items;
    expect(Object.keys(listed).sort()).toEqual(
      [
        ...["offerId", "source", "adId", "key", "value", "createdAt"],
        ...["madeOn", "wordsChanged", "adCount"],
      ].sort(),
    );

    const rent = await wg(
      "offer",
      "fact",
      "set",
      "1",
      "warmRent",
      '{"amount":555,"converted":false}',
    );
    expect(rent.code).toBe(0);
    expect((await get(server, "/offers/1")).facts.warmRent.value).toEqual({
      amount: 555,
      converted: false,
    });

    expect((await wg("offer", "fact", "revert", "1", "anmeldung")).code).toBe(0);
    expect((await get(server, "/offers/1")).facts.anmeldung?.origin).not.toBe("manual");
  });

  it("queues a Recheck", async () => {
    const server = await serverWith();
    const result = await cliFor(server.runtime)("offer", "recheck", "1");
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("refuses to run the model without an Anthropic key (exit 4)", async () => {
    const server = await serverWith();
    const result = await cliFor(server.runtime)("offer", "reanalyze", "1");
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stderr)).toMatchObject({ type: "no-api-key" });
  });

  it("merges two Offers and splits an Ad ID out again", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime);
    expect((await wg("offer", "merge", "1", "2")).code).toBe(0);
    expect((await get(server, "/offers/1")).ads).toHaveLength(2);
    expect((await wg("offer", "show", "2")).code).toBe(3);

    const split = await wg("offer", "split", "1", "9000002");
    expect(split.code).toBe(0);
    expect((await get(server, "/offers/1")).ads).toHaveLength(1);
    expect((await wg("offer", "split", "1", "9000001")).code).toBe(4);

    expect((await wg("offer", "show", "1")).stdout).toContain("kept once quiet by pair-override");
    const released = await wg("offer", "release", "1");
    expect(released.code).toBe(0);
    expect(released.stdout).toContain("Retention: not quiet");
    expect((await get(server, "/offers/1")).retention.keptBecause).toEqual([]);
    expect((await get(server, "/offers/lookup?adId=9000002")).retention.keptBecause).toEqual([
      "pair-override",
    ]);
  });
});

describe("searches", () => {
  it("adds, reads, edits and removes a Search", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime);

    const added = await wg(
      "searches",
      "add",
      "--city",
      "Berlin",
      "--category",
      "flat,house",
      "--price-ceiling",
      "900",
      "--json",
    );
    expect(added.code).toBe(0);
    const search = JSON.parse(added.stdout);
    expect(search).toMatchObject({
      city: "Berlin",
      categories: ["flat", "house"],
      priceCeiling: 900,
    });

    const edited = await wg(
      "searches",
      "edit",
      String(search.id),
      "--disable",
      "--no-price-ceiling",
      "--recency-days",
      "3",
      "--poll-min",
      "20",
      "--poll-max",
      "40",
    );
    expect(edited.code).toBe(0);
    expect(await get(server, `/searches/${search.id}`)).toMatchObject({
      enabled: false,
      priceCeiling: null,
      recencyDays: 3,
      pollInterval: { minMinutes: 20, maxMinutes: 40 },
    });

    expect((await wg("searches", "list")).stdout).toMatch(/off/);
    expect((await wg("searches", "show", String(search.id))).stdout).toMatch(
      /^Sweep: +none \(the Search is off or can't be read\)$/m,
    );
    await wg("searches", "edit", String(search.id), "--enable");
    expect((await wg("searches", "show", String(search.id))).stdout).toMatch(
      /^Sweep: +Backfill queued, starts \d{4}-\d\d-\d\d \d\d:\d\dZ$/m,
    );
    expect((await wg("searches", "remove", String(search.id))).code).toBe(0);
    expect((await wg("searches", "show", String(search.id))).code).toBe(3);
  });

  it("takes the options as a person would type them, and refuses nonsense", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime);
    expect((await wg("searches", "add", "--city", "Berlin")).code).toBe(2);
    expect((await wg("searches", "add", "--category", "flat")).code).toBe(2);
    expect((await wg("searches", "add", "--city", "Berlin", "--category", "castle")).code).toBe(2);
    expect((await wg("searches", "edit", "1")).code).toBe(2);
    expect((await wg("searches", "edit", "1", "--poll-min", "20")).code).toBe(2);
    expect((await wg("searches", "edit", "1", "--enable", "--disable")).code).toBe(2);
    expect((await wg("searches", "edit", "one", "--enable")).code).toBe(2);
    const twice = await wg(
      "searches",
      "add",
      "--city",
      "Berlin",
      "--category",
      "flat",
      "--category",
      "house",
      "--json",
    );
    expect(JSON.parse(twice.stdout).categories).toEqual(["flat", "house"]);
  });

  it("asks for a Crawl now, which exits 0 when it is on its way", async () => {
    const server = await serverWith();
    const result = await cliFor(server.runtime)("searches", "crawl-now", "1");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("queued");
  });
});

describe("crawl", () => {
  it("pauses and resumes", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime);
    const paused = (await wg("crawl", "pause")).stdout;
    expect(paused).toMatch(/State: +paused/);
    expect(paused).not.toMatch(/Pause cause/);
    expect((await get(server, "/crawl")).state).toBe("paused");
    expect((await wg("crawl", "resume")).stdout).toMatch(/State: +running/);
  });

  it("says why a layout change paused the crawl: a page it could not read, or a failure while handling one", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime);
    const pausedBy = async (handler: JobHandler) => {
      server.runtime.crawl.on("poll", handler);
      server.runtime.crawl.enqueue({ kind: "poll", path: "/wg-zimmer-in-Berlin.8.0.1.0.html" });
      await server.crawl();
      return (await wg("crawl", "status")).stdout;
    };

    const unread = await pausedBy(() => ({ unexpectedPage: true }));
    expect(unread).toMatch(/Paused: +layout-changed since /);
    expect(unread).toMatch(
      /Pause cause: +unexpected-page: the Source showed a page wg-hunt could not read\. Look for an update/,
    );

    await wg("crawl", "resume");
    const failed = await pausedBy(() => {
      throw new Error("disk full");
    });
    expect(failed).toMatch(/Paused: +layout-changed since /);
    expect(failed).toMatch(
      /Pause cause: +handler-error: wg-hunt failed while handling a page\. A Resume tries again\./,
    );
    expect(failed).toMatch(/the disk, the database, or a page wg-hunt cannot handle/);
    expect(failed).toMatch(/the server's log has the error/);
    expect(failed).toMatch(/newest handler-error row of `crawl requests` names the page/);
    expect(failed).not.toMatch(/could not read/);
    const json = JSON.parse((await wg("crawl", "status", "--json")).stdout);
    expect(json.paused).toMatchObject({ reason: "layout-changed", cause: "handler-error" });
  });

  it("reads the request log page by page", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime);
    const first = await wg("crawl", "requests", "--limit", "2");
    expect(first.stdout).toMatch(/More: --cursor/);
    const cursor = /--cursor (\S+)/.exec(first.stdout)?.[1] as string;
    expect((await wg("crawl", "requests", "--limit", "2", "--cursor", cursor)).code).toBe(0);
    expect((await wg("crawl", "requests", "--cursor", "garbage")).code).toBe(2);
  });

  it("forecasts a draft from a file or from stdin, and saves nothing", async () => {
    const server = await serverWith();
    const draft = {
      searches: [
        {
          categories: ["flat"],
          recencyDays: 7,
          enabled: true,
          pollInterval: { minMinutes: 20, maxMinutes: 40 },
        },
      ],
    };
    const file = join(tempDir(), "draft.json");
    writeFileSync(file, JSON.stringify(draft));
    const viaFile = await cliFor(server.runtime)("crawl", "forecast", "--draft", file, "--json");
    expect(viaFile.code).toBe(0);
    expect(JSON.parse(viaFile.stdout).searches).toHaveLength(1);
    const viaStdin = await cliFor(server.runtime, { stdin: JSON.stringify(draft) })(
      "crawl",
      "forecast",
      "--draft",
      "-",
      "--json",
    );
    expect(viaStdin.stdout).toBe(viaFile.stdout);
    expect((await get(server, "/searches")).items).toHaveLength(1);
  });
});

describe("profile, filters and ranking", () => {
  it("reads the Profile, changes it from stdin, and ranks again", async () => {
    const server = await serverWith();
    const profile = JSON.parse((await cliFor(server.runtime)("profile", "show", "--json")).stdout);
    profile.age = 31;
    const set = await cliFor(server.runtime, { stdin: JSON.stringify(profile) })(
      "profile",
      "set",
      "--file",
      "-",
    );
    expect(set.code).toBe(0);
    expect((await get(server, "/profile")).age).toBe(31);
  });

  it("changes the Filters from a file, previews a draft first without saving it", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime);
    const filters = JSON.parse((await wg("filters", "show", "--json")).stdout);
    filters.maxRent = {
      ...filters.maxRent,
      enabled: true,
      limit: 500,
      margin: { value: 50, unit: "absolute" },
    };
    const file = join(tempDir(), "filters.json");
    writeFileSync(file, JSON.stringify(filters));

    const draft = join(tempDir(), "draft.json");
    writeFileSync(draft, JSON.stringify({ filters }));
    const preview = await wg("ranking", "preview", "--file", draft);
    expect(preview.code).toBe(0);
    expect(preview.stdout).toContain("Dearest room");
    expect((await get(server, "/filters")).maxRent.limit).not.toBe(500);

    expect((await wg("filters", "set", "--file", file)).code).toBe(0);
    expect((await get(server, "/filters")).maxRent.limit).toBe(500);
    expect((await wg("offers", "list", "--band", "match")).stdout).not.toContain("Dearest room");
  });

  it("refuses input that is not JSON, a file that is not there, and a Profile the API rejects", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime, { stdin: "not json" });
    expect((await wg("profile", "set", "--file", "-")).code).toBe(2);
    expect((await wg("profile", "set", "--file", "nowhere.json")).code).toBe(2);
    expect((await wg("profile", "set")).code).toBe(2);
    const bad = await cliFor(server.runtime, { stdin: '{"age":"old"}' })(
      "profile",
      "set",
      "--file",
      "-",
    );
    expect(bad.code).toBe(2);
    expect(JSON.parse(bad.stderr)).toMatchObject({ type: "validation-error" });
  });

  it("refuses a Profile that drops the Place the distance Filter measures from", async () => {
    const server = await serverWith();
    const profile = await get(server, "/profile");
    await server.json("PUT", "/profile", { ...profile, places: [{ name: "work", plz: "10115" }] });
    const filters = await get(server, "/filters");
    filters.distance = { ...filters.distance, enabled: true, place: "work", limit: 5 };
    await server.json("PUT", "/filters", filters);

    const result = await cliFor(server.runtime, {
      stdin: JSON.stringify({ ...profile, places: [] }),
    })("profile", "set", "--file", "-");
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ type: "validation-error" });
    expect((await get(server, "/profile")).places).toHaveLength(1);
  });

  it("shows the example preset as a draft", async () => {
    const server = await serverWith();
    const result = await cliFor(server.runtime)("preset", "example", "--json");
    expect(JSON.parse(result.stdout)).toHaveProperty("search.city");
    expect((await get(server, "/profile")).age).not.toBe(27);
  });
});

describe("settings, analysis and storage", () => {
  it("round-trips the crawl settings it printed", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime);
    const shown = JSON.parse((await wg("settings", "crawl", "show", "--json")).stdout);
    shown.pacing.dailyCap = 321;
    const set = await cliFor(server.runtime, { stdin: JSON.stringify(shown) })(
      "settings",
      "crawl",
      "set",
      "--file",
      "-",
    );
    expect(set.code).toBe(0);
    expect((await get(server, "/settings/crawl")).pacing.dailyCap).toBe(321);
  });

  it("round-trips the analysis settings it printed", async () => {
    const server = await serverWith();
    const shown = JSON.parse(
      (await cliFor(server.runtime)("settings", "analysis", "show", "--json")).stdout,
    );
    shown.monthlySpendCapUsd = 12;
    const set = await cliFor(server.runtime, { stdin: JSON.stringify(shown) })(
      "settings",
      "analysis",
      "set",
      "--file",
      "-",
    );
    expect(set.code).toBe(0);
    expect((await get(server, "/settings/analysis")).monthlySpendCapUsd).toBe(12);
  });

  it("reads a re-analysis run, and says when there is none", async () => {
    const server = await serverWith();
    expect((await cliFor(server.runtime)("analysis", "run", "99")).code).toBe(3);
    expect((await cliFor(server.runtime)("analysis", "run", "x")).code).toBe(2);
  });

  it("starts a re-analysis run, which the API refuses without a key (exit 4)", async () => {
    const server = await serverWith();
    const result = await cliFor(server.runtime)("analysis", "reanalyze");
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stderr)).toMatchObject({ type: "no-api-key", status: 409 });
  });

  it("shows how the nightly prune went: never, ok, then failing with the kind of error", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime);
    expect((await wg("storage", "show")).stdout).toMatch(/^prune:\n {2}state: never$/m);

    server.runtime.retention.tick();
    const ok = (await wg("storage", "show")).stdout;
    expect(ok).toMatch(/^ {2}state: ok$/m);
    expect(ok).toMatch(/^ {2}nextAttemptAt: 2026-11-05T02:00:00\.000Z$/m);

    breakPrune(server);
    server.clock.now = Date.parse("2026-11-05T02:00:00Z");
    expect(() => server.runtime.retention.tick()).toThrow();
    const failing = (await wg("storage", "show")).stdout;
    expect(failing).toMatch(/^ {2}state: failing$/m);
    expect(failing).toMatch(/^ {4}error: database-error$/m);
    expect(failing).toMatch(/^ {2}failingSince: 2026-11-05T02:00:00\.000Z$/m);
    expect(failing).toMatch(/^ {2}failures: 1$/m);
    expect(failing).toMatch(/^ {2}nextAttemptAt: 2026-11-05T02:15:00\.000Z$/m);
    expect(JSON.parse((await wg("storage", "show", "--json")).stdout).prune.state).toBe("failing");
  });

  it("shows how the catch-up after the start went, phase by phase", async () => {
    const server = await serverWith();
    await server.runtime.catchUp;
    const shown = (await cliFor(server.runtime)("storage", "show")).stdout;
    expect(shown).toMatch(/^catchUp:\n {2}state: finished$/m);
    expect(shown).toMatch(/^ {4}reparse:\n {6}state: finished$/m);
  });

  it("deletes all Offer data only with the typed confirmation", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime);
    expect((await wg("storage", "wipe")).code).toBe(2);
    expect((await wg("storage", "wipe", "--confirm", "yes please")).code).toBe(2);
    expect((await get(server, "/offers")).items.length).toBeGreaterThan(0);

    const wiped = await wg("storage", "wipe", "--confirm", "delete all Offer data");
    expect(wiped.code).toBe(0);
    expect((await get(server, "/offers?includeHidden=true")).items).toHaveLength(0);
    expect((await get(server, "/crawl")).state).toBe("wiped");
    expect((await get(server, "/searches")).items).toHaveLength(1);
  });
});

describe("watch", () => {
  it("prints the current crawl status first, as one line, or as JSON", async () => {
    const server = await serverWith();
    const line = await cliFor(server.runtime)("watch", "--count", "1");
    expect(line.code).toBe(0);
    expect(line.stdout).toMatch(/^\d\d:\d\d:\d\d {2}crawl-status-changed {2}crawl running/);

    const json = await cliFor(server.runtime)("watch", "--count", "1", "--json");
    expect(JSON.parse(json.stdout)).toMatchObject({
      event: "crawl-status-changed",
      data: { state: "running" },
    });
  });

  it("tails events as they happen", async () => {
    const server = await serverWith();
    const watching = cliFor(server.runtime)("watch", "--count", "2", "--json");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await cliFor(server.runtime)("crawl", "pause");
    const result = await watching;
    expect(result.code).toBe(0);
    const events = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.map((e) => e.event)).toEqual(["crawl-status-changed", "crawl-status-changed"]);
    expect(events[1].data.state).toBe("paused");
  });

  it("says a crawl status once while its line reads the same, and counts only what it printed", async () => {
    const server = await serverWith();
    const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
    const watching = cliFor(server.runtime)("watch", "--count", "2");
    const everything = cliFor(server.runtime)("watch", "--count", "3", "--json");
    await pause();
    server.runtime.crawl.enqueue({ kind: "recheck", path: "/1234567.html" });
    await pause();
    await cliFor(server.runtime)("crawl", "pause");

    const lines = (await watching).stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/crawl-status-changed {2}crawl running, \d+ of \d+ requests today$/);
    expect(lines[1]).toMatch(/crawl-status-changed {2}crawl paused, .*waits for a person: paused$/);

    const events = (await everything).stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.map((e) => e.data.state)).toEqual(["running", "running", "paused"]);
    expect(events[1].data.nextJobs.map((j: { path: string }) => j.path)).toContain("/1234567.html");
  });

  it("prints the analysis status when it changes, as one line, or as JSON", async () => {
    const server = await serverWith();
    const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
    const line = cliFor(server.runtime)("watch", "--count", "2");
    const json = cliFor(server.runtime)("watch", "--count", "2", "--json");
    await pause();
    // No key is set, so lowering the cap sends no model call.
    const settings = (await server.json("GET", "/settings/analysis")).body;
    await server.json("PUT", "/settings/analysis", { ...settings, monthlySpendCapUsd: 0 });

    const events = (await json).stdout
      .trim()
      .split("\n")
      .map((each) => JSON.parse(each));
    expect(events.map((e) => e.event)).toEqual(["crawl-status-changed", "analysis-status-changed"]);
    expect(events[1].data).toEqual((await server.json("GET", "/analysis")).body);

    const lines = (await line).stdout.trim().split("\n");
    expect(lines[1]).toMatch(
      /analysis-status-changed {2}analysis: key absent; cap reached, \$0 of \$0; \d+ awaiting; \d+ on an older analysis$/,
    );
  });

  it("ends cleanly on Ctrl-C", async () => {
    const server = await serverWith();
    const stop = new AbortController();
    const watching = cliFor(server.runtime, { signal: stop.signal })("watch");
    await new Promise((resolve) => setTimeout(resolve, 100));
    stop.abort();
    expect((await watching).code).toBe(0);
  });

  it("exits 1 when the server hangs up", async () => {
    const server = await serverWith();
    const result = await cliFor(server.runtime, {
      fetch: async () =>
        new Response("event: crawl-status-changed\ndata: {}\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        }),
    })("watch");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ type: "stream-ended" });
  });
});
