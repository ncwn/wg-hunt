import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { PROBLEMS } from "../../server/src/api/problem.js";
import {
  CRAWL_HOLDS,
  CRAWL_STATES,
  PAUSE_CAUSES,
  WAIT_REASONS,
} from "../../server/src/crawl/status.js";
import { CRAWL_NOW_WAITS } from "../src/commands/searches.js";
import {
  CLI_PROBLEM_TYPES,
  EXIT,
  EXIT_BY_TYPE,
  exitCodeFor,
  exitCodeForStatus,
} from "../src/problem.js";
import {
  cliFor,
  collectGarbage,
  neverAnswers,
  type Server,
  serverWith,
  tempDir,
} from "./harness.js";

const SKILL = new URL("../../../.claude/skills/wg-hunt/", import.meta.url).pathname;
const read = (file: string) => readFileSync(join(SKILL, file), "utf8");

const apiTypes = () =>
  Object.keys(EXIT_BY_TYPE).filter((t) => !(CLI_PROBLEM_TYPES as readonly string[]).includes(t));

describe("the exit-code table", () => {
  it("names every problem type the API defines, and no other", () => {
    expect(apiTypes().sort()).toEqual(Object.keys(PROBLEMS).sort());
  });

  it("agrees with each API problem's status", () => {
    for (const [type, { status }] of Object.entries(PROBLEMS)) {
      expect(exitCodeFor({ type, status }), type).toBe(exitCodeForStatus(status));
    }
  });

  it("gives every 409 exit 4, every 404 exit 3 and every 400 exit 2", () => {
    const byStatus = { 409: EXIT.refused, 404: EXIT.notFound, 400: EXIT.usage } as const;
    for (const [type, { status }] of Object.entries(PROBLEMS)) {
      if (status in byStatus) {
        expect(EXIT_BY_TYPE[type as keyof typeof EXIT_BY_TYPE], type).toBe(
          byStatus[status as keyof typeof byStatus],
        );
      }
    }
  });

  it("falls back on the status for a type it does not know, such as a newer server's", () => {
    expect(exitCodeFor({ type: "some-new-refusal", status: 409 })).toBe(EXIT.refused);
    expect(exitCodeFor({ type: "some-new-conflict", status: 412 })).toBe(EXIT.refused);
    expect(exitCodeFor({ type: "some-new-gone", status: 404 })).toBe(EXIT.notFound);
    expect(exitCodeFor({ type: "some-new-input", status: 400 })).toBe(EXIT.usage);
    expect(exitCodeFor({ type: "some-new-thing", status: 503 })).toBe(EXIT.error);
    expect(exitCodeFor({ type: "http-error", status: 404 })).toBe(EXIT.notFound);
  });
});

describe("Crawl now's waits", () => {
  it("cover every wait reason the server has", () => {
    expect(Object.keys(CRAWL_NOW_WAITS).sort()).toEqual([...WAIT_REASONS].sort());
  });

  it("need a Resume for exactly the server's holds", () => {
    const resume = Object.entries(CRAWL_NOW_WAITS)
      .filter(([, kind]) => kind === "needs-resume")
      .map(([reason]) => reason);
    expect(resume.sort()).toEqual([...CRAWL_HOLDS].sort());
  });

  it("exit 4 with a problem on stderr, and the API's body on stdout", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime);
    await wg("crawl", "pause");
    const result = await wg("searches", "crawl-now", "1", "--json");
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stdout)).toMatchObject({ waiting: "paused", runsAt: null });
    expect(JSON.parse(result.stderr)).toMatchObject({
      type: "crawl-waits-for-resume",
      waiting: "paused",
    });
  });

  it("write nothing to stderr when the poll is on its way", async () => {
    const server = await serverWith();
    const result = await cliFor(server.runtime)("searches", "crawl-now", "1", "--json");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });
});

function eventsFrom(body: ReadableStream<Uint8Array>) {
  return async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

const encoder = new TextEncoder();
const STATUS_EVENT = encoder.encode('event: crawl-status-changed\ndata: {"state":"running"}\n\n');

describe("watch outcomes", () => {
  it("exit 0 when --count events arrived", async () => {
    const server = await serverWith();
    const result = await cliFor(server.runtime)("watch", "--count", "1", "--timeout", "5");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("exit 5 with watch-timeout when --timeout runs out first", async () => {
    const server = await serverWith();
    const result = await cliFor(server.runtime)("watch", "--count", "3", "--timeout", "1");
    expect(result.code).toBe(5);
    expect(JSON.parse(result.stderr)).toMatchObject({ type: "watch-timeout", seen: 1 });
  });

  it("exit 0 when --timeout ends a watch with no --count: that is how it was asked to end", async () => {
    const server = await serverWith();
    const result = await cliFor(server.runtime)("watch", "--timeout", "1", "--json");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout.split("\n")[0] ?? "")).toMatchObject({
      event: "crawl-status-changed",
    });
  });

  it("exit 5, not connection-failed, when --timeout runs out while connecting", async () => {
    const server = await serverWith();
    setTimeout(collectGarbage, 300);
    const result = await cliFor(server.runtime, { fetch: neverAnswers })("watch", "--timeout", "1");
    expect(result.code).toBe(5);
    expect(JSON.parse(result.stderr)).toMatchObject({ type: "watch-timeout", seen: 0 });
  });

  it("exit 5 when --timeout runs out while connecting to a real server, through a garbage collection", async () => {
    const server = await serverWith();
    const sockets = new Set<Socket>();
    const silent = createServer((socket) => sockets.add(socket));
    onTestFinished(() => {
      for (const socket of sockets) socket.destroy();
      silent.close();
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const { port } = silent.address() as AddressInfo;
    setTimeout(collectGarbage, 300);
    const result = await cliFor(server.runtime, {
      fetch: (request) => fetch(request),
      env: { WG_HUNT_URL: `http://127.0.0.1:${port}`, WG_HUNT_TOKEN: server.runtime.token },
    })("watch", "--timeout", "1");
    expect(result.code).toBe(5);
    expect(JSON.parse(result.stderr)).toMatchObject({ type: "watch-timeout", seen: 0 });
  });

  it("exit 0 on Ctrl-C while connecting, without blaming the connection", async () => {
    const server = await serverWith();
    const stop = new AbortController();
    const watching = cliFor(server.runtime, { signal: stop.signal, fetch: neverAnswers })("watch");
    await new Promise((resolve) => setTimeout(resolve, 50));
    collectGarbage();
    stop.abort();
    const result = await watching;
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("exit 1 with stream-reset, not internal-error, when the connection breaks mid-stream", async () => {
    const server = await serverWith();
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(STATUS_EVENT);
          return;
        }
        controller.error(new TypeError("terminated"));
      },
    });
    const result = await cliFor(server.runtime, { fetch: eventsFrom(body) })("watch");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ type: "stream-reset", seen: 1 });
  });

  it("exit 1 with stream-ended when the server closes the stream, as on a restart", async () => {
    const server = await serverWith();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(STATUS_EVENT);
        controller.close();
      },
    });
    const result = await cliFor(server.runtime, { fetch: eventsFrom(body) })("watch");
    expect(result.code).toBe(1);
    const problem = JSON.parse(result.stderr);
    expect(problem).toMatchObject({ type: "stream-ended" });
    expect(problem.detail).toMatch(/restart/);
  });

  it("exit 1 with stream-ended when --count meets a reply with no event stream", async () => {
    const server = await serverWith();
    const result = await cliFor(server.runtime, {
      fetch: async () => new Response(null, { headers: { "Content-Type": "text/event-stream" } }),
    })("watch", "--count", "1");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ type: "stream-ended", seen: 0 });
  });

  const SESSION_ENDED = encoder.encode(
    'event: session-ended\ndata: {"reason":"token-rotated"}\n\n',
  );
  const statusThenSessionEnded = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(STATUS_EVENT);
        controller.enqueue(SESSION_ENDED);
        controller.close();
      },
    });

  it("exit 1 with session-ended, not counting it as an event, when the token was rotated", async () => {
    const server = await serverWith();
    const result = await cliFor(server.runtime, { fetch: eventsFrom(statusThenSessionEnded()) })(
      "watch",
      "--count",
      "2",
      "--json",
    );
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("session-ended");
    expect(JSON.parse(result.stderr)).toMatchObject({
      type: "session-ended",
      reason: "token-rotated",
      seen: 1,
    });
  });

  const tokenFrom = (server: Server) => ({
    env: () => ({
      env: { WG_HUNT_URL: "http://wg-hunt.test", WG_HUNT_TOKEN: server.runtime.token },
    }),
    config: () => {
      const homeDir = tempDir();
      mkdirSync(join(homeDir, ".config", "wg-hunt"), { recursive: true });
      writeFileSync(
        join(homeDir, ".config", "wg-hunt", "config.json"),
        JSON.stringify({ url: "http://wg-hunt.test", token: server.runtime.token }),
      );
      return { homeDir, env: {} };
    },
    "data-folder": () => ({
      env: { WG_HUNT_URL: "http://wg-hunt.test", WG_HUNT_DATA_DIR: server.dataDir },
    }),
  });

  it.each([
    { source: "env", says: /WG_HUNT_TOKEN/ },
    { source: "config", says: /wg-hunt login/ },
    { source: "data-folder", says: /again/ },
  ] as const)(
    "after a rotation, says what to do about a token from $source",
    async ({ source, says }) => {
      const server = await serverWith();
      const result = await cliFor(server.runtime, {
        ...tokenFrom(server)[source](),
        fetch: eventsFrom(statusThenSessionEnded()),
      })("watch");
      expect(result.code).toBe(1);
      const problem = JSON.parse(result.stderr);
      expect(problem).toMatchObject({ type: "session-ended", reason: "token-rotated" });
      expect(problem.detail).toMatch(says);
      expect(problem.detail).not.toMatch(/restart/);
    },
  );

  it("exit 1 with session-ended when the server's token is rotated while watching", async () => {
    const server = await serverWith();
    const watching = cliFor(server.runtime)("watch", "--count", "2", "--timeout", "5", "--json");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const rotated = await server.runtime.app.request("/api/v1/auth/token/rotate", {
      method: "POST",
      headers: { Authorization: `Bearer ${server.runtime.token}` },
    });
    expect(rotated.status).toBe(200);
    const result = await watching;
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ type: "session-ended", seen: 1 });
  });

  const statusMissedStatus = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(STATUS_EVENT);
        controller.enqueue(encoder.encode('event: events-missed\ndata: {"missed":201}\n\n'));
        controller.enqueue(
          encoder.encode('event: crawl-status-changed\ndata: {"state":"paused"}\n\n'),
        );
      },
    });

  it("prints events-missed as its own JSON line, not counting it as an event", async () => {
    const server = await serverWith();
    const result = await cliFor(server.runtime, { fetch: eventsFrom(statusMissedStatus()) })(
      "watch",
      "--count",
      "2",
      "--json",
    );
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1] ?? "")).toEqual({ event: "events-missed", data: { missed: 201 } });
  });

  it("says how many events were missed and to read the state again", async () => {
    const server = await serverWith();
    const result = await cliFor(server.runtime, { fetch: eventsFrom(statusMissedStatus()) })(
      "watch",
      "--count",
      "2",
    );
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/events-missed .*201 events were missed.*read .* again/);
  });
});

describe("token rotate", () => {
  it("says the rotated token was not saved, and where to find it, when saving fails", async () => {
    const server = await serverWith();
    const homeDir = tempDir();
    const old = server.runtime.token;
    const env = { WG_HUNT_URL: "http://wg-hunt.test" };
    expect((await cliFor(server.runtime, { homeDir, env, stdin: old })("login")).code).toBe(0);
    mkdirSync(join(homeDir, ".config", "wg-hunt", "config.json.new"));
    const result = await cliFor(server.runtime, { homeDir, env: {} })("token", "rotate");
    expect(result.code).toBe(1);
    const problem = JSON.parse(result.stderr);
    expect(problem).toMatchObject({ type: "token-not-saved" });
    expect(problem.detail).toMatch(/access-token/);
    expect(server.runtime.token).not.toBe(old);
    expect(result.stdout + result.stderr).not.toContain(server.runtime.token);
  });
});

describe("the skill's docs", () => {
  it("list every crawl state the server has", () => {
    const line = read("flows.md")
      .split("\n")
      .find((l) => l.startsWith("`state` is one of"));
    expect(line).toBeDefined();
    const listed = (line?.split(", but")[0] ?? "")
      .replace("`state` is one of", "")
      .match(/`[^`]+`/g)
      ?.map((s) => s.slice(1, -1));
    expect(listed?.sort()).toEqual([...CRAWL_STATES].sort());
  });

  it("say what to do for each cause of a layout-changed pause", () => {
    const bullet = read("flows.md")
      .split("\n")
      .find((l) => l.startsWith("- **layout-changed**"));
    expect(bullet).toContain("`paused.cause`");
    for (const cause of PAUSE_CAUSES) expect(bullet, cause).toContain(`\`${cause}\`: `);
  });

  it("name every exit code, and every problem type that exits 4", () => {
    const skill = read("SKILL.md");
    for (const code of Object.values(EXIT))
      expect(skill, `exit ${code}`).toMatch(new RegExp(`^\\| ${code} +\\|`, "m"));
    for (const [type, code] of Object.entries(EXIT_BY_TYPE)) {
      if (code === EXIT.refused || code === EXIT.timedOut)
        expect(skill, type).toContain(`\`${type}\``);
    }
  });
});
