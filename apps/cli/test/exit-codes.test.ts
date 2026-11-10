import { describe, expect, it } from "vitest";
import { MINUTE } from "../../server/test/offers-harness.js";
import { cliFor, serverWith } from "./harness.js";

describe("exit codes", () => {
  it("0 when the command worked", async () => {
    const server = await serverWith();
    const result = await cliFor(server.runtime)("offers", "list");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("1 when the API answers with a problem, which goes to stderr as problem+json", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime, {
      env: { WG_HUNT_URL: "http://wg-hunt.test", WG_HUNT_TOKEN: "x".repeat(43) },
    });
    const result = await wg("offers", "list");
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ type: "unauthorized", status: 401 });
  });

  it("1 when the server cannot be reached", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime, {
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    const result = await wg("offers", "list");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ type: "connection-failed" });
  });

  it("1 when there is no access token to send", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime, { env: {} });
    const result = await wg("offers", "list");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ type: "not-configured" });
  });

  it("2 for a command line that does not parse", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime);
    expect((await wg("offers", "frobnicate")).code).toBe(2);
    expect((await wg("offers", "list", "--sort")).code).toBe(2);
    expect((await wg("offer", "show")).code).toBe(2);
    const bad = await wg("offers", "list", "--limit", "many");
    expect(bad.code).toBe(2);
    expect(JSON.parse(bad.stderr)).toMatchObject({ type: "usage-error" });
    expect(bad.stderr).toContain("--limit");
  });

  it("2 when the API refuses the input as invalid", async () => {
    const server = await serverWith();
    const result = await cliFor(server.runtime)("offers", "list", "--limit", "100000");
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ type: "validation-error" });
  });

  it("3 for an Offer that is not there, and for an Ad ID or URL that is not known", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime);
    for (const ref of ["99999", "https://www.wg-gesucht.de/1234.8000000.html"]) {
      const result = await wg("offer", "show", ref);
      expect(result.code, ref).toBe(3);
      expect(JSON.parse(result.stderr).status, ref).toBe(404);
    }
    expect((await wg("searches", "show", "99999")).code).toBe(3);
  });

  it("4 for a request refused by state: resuming during a Cooldown", async () => {
    const server = await serverWith();
    server.fetcher.fetch = async () => ({ status: 429, body: "" });
    server.runtime.crawl.enqueue({ kind: "poll", path: "/wg-zimmer-in-Berlin.8.0.1.0.html" });
    await server.crawl(30 * MINUTE);
    expect((await server.json("GET", "/crawl")).body.state).toBe("cooling-down");
    const result = await cliFor(server.runtime)("crawl", "resume");
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stderr)).toMatchObject({ type: "bot-check-cooldown", status: 409 });
  });

  it("4 for a Crawl now on a Search that is switched off", async () => {
    const server = await serverWith();
    await server.json("PATCH", "/searches/1", { enabled: false });
    const result = await cliFor(server.runtime)("searches", "crawl-now", "1");
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stderr)).toMatchObject({ type: "search-disabled" });
  });

  it("0 for a Crawl now that waits out a Cooldown which ends by itself", async () => {
    const server = await serverWith();
    server.fetcher.fetch = async () => ({ status: 429, body: "" });
    server.runtime.crawl.enqueue({ kind: "poll", path: "/wg-zimmer-in-Berlin.8.0.1.0.html" });
    await server.crawl(30 * MINUTE);
    const result = await cliFor(server.runtime)("searches", "crawl-now", "1", "--json");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ waiting: "cooldown" });
    expect(JSON.parse(result.stdout).runsAt).not.toBeNull();
  });

  it("4 for a Crawl now during a Cooldown that a person's Resume has to follow", async () => {
    const server = await serverWith();
    server.fetcher.fetch = async () => ({ status: 429, body: "" });
    server.runtime.crawl.enqueue({ kind: "poll", path: "/wg-zimmer-in-Berlin.8.0.1.0.html" });
    await server.crawl(3 * 60 * MINUTE);
    expect((await server.json("GET", "/crawl")).body).toMatchObject({
      state: "cooling-down",
      holds: ["needs-resume"],
    });
    const result = await cliFor(server.runtime)("searches", "crawl-now", "1", "--json");
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stdout)).toMatchObject({ waiting: "cooldown", runsAt: null });
  });

  it("4 for a Crawl now that has to wait for a Pause to be lifted, though the API accepted it", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime);
    await wg("crawl", "pause");
    const result = await wg("searches", "crawl-now", "1", "--json");
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stdout)).toMatchObject({ waiting: "paused" });
  });
});
