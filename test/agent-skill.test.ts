import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "tsdown";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CLI_PROBLEM_TYPES, EXIT_BY_TYPE, exitCodeFor } from "../apps/cli/src/problem.js";
import { PROBLEMS } from "../apps/server/src/api/problem.js";
import { CRAWL_HOLDS } from "../apps/server/src/crawl/status.js";
import { wgGesuchtSource } from "../packages/core/src/sources/wg-gesucht/index.js";
import { KNOWN_CITIES } from "../packages/core/src/sources/wg-gesucht/search-urls.js";

const SCRIPT = new URL("../.claude/skills/wg-hunt/scripts/wg.sh", import.meta.url).pathname;
const TOKEN = "tok-secret-0123456789";

type Seen = {
  method: string;
  url: string;
  auth: string | undefined;
  ifMatch: string | undefined;
  body: string;
};
let api: Server;
let seen: Seen[];
let apiPort: number;
let apiDown = false;
let serverVersion = "1.4.0";
let respond: (
  req: Seen,
) => { status: number; body: string; headers?: Record<string, string> } | undefined;

const dirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "wg-skill-"));
  dirs.push(dir);
  return dir;
};

beforeAll(async () => {
  api = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const entry: Seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        auth: req.headers.authorization,
        ifMatch: req.headers["if-match"],
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(entry);
      const custom = respond(entry);
      const [status, body] = custom
        ? [custom.status, custom.body]
        : entry.url === "/api/v1/health"
          ? [200, JSON.stringify({ status: "ok", version: serverVersion })]
          : entry.url === "/api/v1/openapi.json"
            ? [
                200,
                JSON.stringify({
                  openapi: "3.1.0",
                  info: { title: "wg-hunt", version: serverVersion },
                  paths: {
                    "/offers": { get: { summary: "List ranked Offers" } },
                    "/crawl/pause": { post: { summary: "Pause the crawler" } },
                  },
                }),
              ]
            : [200, JSON.stringify({ items: [] })];
      res.writeHead(status, { "content-type": "application/json", ...custom?.headers }).end(body);
    });
  });
  await new Promise<void>((done) => api.listen(0, "127.0.0.1", done));
  const address = api.address();
  apiPort = typeof address === "object" && address ? address.port : 0;
});
afterAll(() => api.close());

beforeEach(() => {
  seen = [];
  apiDown = false;
  serverVersion = "1.4.0";
  respond = () => undefined;
});
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A PATH with only plain tools, so a real `wg-hunt` or `docker` is never found. */
function baseBin(): string {
  const bin = tmp();
  for (const tool of "bash sh sed grep cat mktemp date tr cut head awk id curl jq sleep rm mkdir dirname printf cksum".split(
    " ",
  )) {
    for (const dir of ["/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"]) {
      if (existsSync(join(dir, tool))) {
        symlinkSync(join(dir, tool), join(bin, tool));
        break;
      }
    }
  }
  return bin;
}

function stub(bin: string, name: string, body: string): void {
  const file = join(bin, name);
  // Takes the place of a tool `baseBin` linked, rather than writing through the link.
  rmSync(file, { force: true });
  writeFileSync(file, `#!/bin/bash\n${body}\n`);
  chmodSync(file, 0o755);
}

function fakeCli(bin: string, log: string, version = "1.2.0", exitCode = 0): void {
  stub(
    bin,
    "wg-hunt",
    `echo "$*" >> "${log}"
case "$*" in
  *--version*) echo ${version}; exit 0;;
  *health*) [ -n "$FAKE_DOWN" ] && { echo '{"type":"connection-failed"}' >&2; exit 1; }; echo '{"status":"ok","version":"'"$FAKE_SERVER_VERSION"'"}'; exit 0;;
  *doctor*)
    tokens=none
    [ -n "$WG_HUNT_DATA_DIR" ] && tokens=data-folder
    [ -n "$WG_HUNT_TOKEN" ] && tokens=env
    printf '{"url":"%s","urlSource":"env","tokenSource":"%s","server":"ok","serverVersion":"%s","signIn":"ok"}' "$WG_HUNT_URL" "$tokens" "$FAKE_SERVER_VERSION"
    exit 0;;
esac
echo '{"from":"cli"}'
exit ${exitCode}`,
  );
}

function fakeDocker(bin: string, log: string, version = "1.3.0", labelsOnly = false): void {
  stub(
    bin,
    "docker",
    `echo "docker $*" >> "${log}"
case "$*" in
  "compose ps"*) ${labelsOnly ? "exit 1" : "echo abc123; exit 0"};;
  "ps "*) echo abc123; exit 0;;
  *"wg-hunt --json --version"*|*"wg-hunt --version"*) echo ${version}; exit 0;;
  *"wg-hunt --json health"*) echo '{"status":"ok","version":"'"$FAKE_SERVER_VERSION"'"}'; exit 0;;
  *"wg-hunt --json doctor"*) echo '{"url":"http://127.0.0.1:8787","urlSource":"default","tokenSource":"data-folder","server":"ok","serverVersion":"'"$FAKE_SERVER_VERSION"'","signIn":"ok"}'; exit 0;;
  *"wg-hunt --json"*) echo '{"from":"container"}'; exit 0;;
esac
exit 1`,
  );
}

function signedOutCli(
  bin: string,
  log: string,
  problem: "not-configured" | "unauthorized" = "not-configured",
): void {
  stub(
    bin,
    "wg-hunt",
    `echo "$*" >> "${log}"
case "$*" in
  *--version*) echo 1.2.0; exit 0;;
  *health*) echo '{"status":"ok","version":"'"$FAKE_SERVER_VERSION"'"}'; exit 0;;
  *doctor*) printf '{"url":"%s","urlSource":"env","tokenSource":"${problem === "unauthorized" ? "env" : "none"}","server":"ok","serverVersion":"%s","signIn":"${problem === "unauthorized" ? "refused" : "no-token"}"}' "$WG_HUNT_URL" "$FAKE_SERVER_VERSION";;
esac
echo '{"type":"${problem}","title":"Cannot sign in"}' >&2
exit 1`,
  );
}

const ELSEWHERE = "http://wg-hunt.example.test:8787";

const sentToContainer = (dockerLog: string) => lines(dockerLog).filter((l) => l.includes("exec"));

type Result = { code: number; stdout: string; stderr: string };

function problemOf(result: Result): Record<string, unknown> {
  const problems = result.stderr.split("\n").filter((line) => line.startsWith("{"));
  expect(problems, result.stderr).toHaveLength(1);
  return JSON.parse(problems[0] ?? "");
}

function bash(
  bin: string,
  args: string[],
  env: Record<string, string> = {},
  input?: string,
  cwd = tmp(),
): Promise<Result> {
  return new Promise((done) => {
    const child = execFile(
      "bash",
      args,
      {
        env: {
          PATH: bin,
          HOME: tmp(),
          TMPDIR: tmp(),
          WG_HUNT_URL: `http://127.0.0.1:${apiPort}`,
          WG_HUNT_CACHE_TTL: "0",
          FAKE_SERVER_VERSION: serverVersion,
          ...(apiDown && { FAKE_DOWN: "1" }),
          ...env,
        },
        cwd,
      },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        done({ code, stdout, stderr });
      },
    );
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

const wg = (bin: string, args: string[], env: Record<string, string> = {}, input?: string) =>
  bash(bin, [SCRIPT, ...args], env, input);

function flowLine(bin: string, line: string, env: Record<string, string>, cwd: string) {
  stub(bin, "wg.sh", `exec bash "${SCRIPT}" "$@"`);
  return bash(bin, ["-c", line], env, undefined, cwd);
}

const lines = (path: string) =>
  existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];

describe("route 1: wg-hunt on PATH", () => {
  it("runs the command with --json first and prints the CLI's output unchanged", async () => {
    const bin = baseBin();
    const log = join(tmp(), "log");
    fakeCli(bin, log);
    const result = await wg(bin, ["offers", "list", "--band", "match"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{"from":"cli"}\n');
    expect(lines(log)).toContain("--json offers list --band match");
  });

  it("says which route it used", async () => {
    const bin = baseBin();
    fakeCli(bin, join(tmp(), "log"));
    const result = await wg(bin, ["crawl", "status"]);
    expect(result.stderr).toMatch(/route: path/);
  });

  it("passes the CLI's exit code through", async () => {
    const bin = baseBin();
    fakeCli(bin, join(tmp(), "log"), "1.2.0", 4);
    expect((await wg(bin, ["crawl", "resume"])).code).toBe(4);
  });

  it("passes over a CLI that cannot sign in when the container can", async () => {
    const bin = baseBin();
    const log = join(tmp(), "log");
    signedOutCli(bin, log);
    fakeDocker(bin, log);
    const project = tmp();
    mkdirSync(join(project, ".data"));
    writeFileSync(join(project, ".data", "access-token"), `${TOKEN}\n`);
    const env = { WG_HUNT_COMPOSE_DIR: project };

    const result = await wg(bin, ["offers", "list"], env);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{"from":"container"}\n');
    expect(result.stderr).toMatch(/route: compose/);

    const doctor = await wg(bin, ["doctor"], env);
    expect(doctor.stdout).toMatch(/route: compose/);
    expect(doctor.stdout).toMatch(/^token: data-folder$/m);
    expect(doctor.stdout).toMatch(/^sign-in: ok$/m);
  });

  it("stays with a CLI that cannot sign in when the address is another machine's, whatever runs here", async () => {
    const bin = baseBin();
    const dockerLog = join(tmp(), "docker-log");
    signedOutCli(bin, join(tmp(), "log"), "unauthorized");
    fakeDocker(bin, dockerLog);

    const result = await wg(bin, ["offers", "mark", "12", "--dismissed"], {
      WG_HUNT_URL: ELSEWHERE,
    });
    expect(result.stderr).toMatch(/route: path/);
    expect(result.code).toBe(1);
    expect(problemOf(result)).toMatchObject({ type: "unauthorized" });
    expect(result.stdout).toBe("");
    expect(sentToContainer(dockerLog)).toEqual([]);
  });

  it("takes no address, 127.0.0.1, localhost and [::1] for this machine, and nothing that only looks like them", async () => {
    const bin = baseBin();
    signedOutCli(bin, join(tmp(), "log"));
    fakeDocker(bin, join(tmp(), "docker-log"));
    const routeFor = async (url: string) =>
      (await wg(bin, ["offers", "list"], { WG_HUNT_URL: url })).stderr.match(/route: (\w+)/)?.[1];

    for (const here of [
      "",
      "http://127.0.0.1:8787",
      "http://localhost",
      "http://LocalHost:8787/",
      "http://[::1]:8787",
    ]) {
      expect(await routeFor(here), `"${here}"`).toBe("compose");
    }
    for (const elsewhere of [
      "https://wg-hunt.example.test",
      "http://localhost.example.test:8787",
      "http://127.0.0.1.example.test:8787",
      "http://127.0.0.1@wg-hunt.example.test:8787",
      "http://wg-hunt.example.test\\@localhost:8787",
      "http://wg-hunt.example.test/localhost",
      "http://[2001:db8::1]:8787",
    ]) {
      expect(await routeFor(elsewhere), elsewhere).toBe("path");
    }
  });

  it("goes by the address a login saved as it does by WG_HUNT_URL", async () => {
    const bin = baseBin();
    const dockerLog = join(tmp(), "docker-log");
    signedOutCli(bin, join(tmp(), "log"), "unauthorized");
    fakeDocker(bin, dockerLog);
    const home = tmp();
    mkdirSync(join(home, ".config", "wg-hunt"), { recursive: true });
    writeFileSync(
      join(home, ".config", "wg-hunt", "config.json"),
      JSON.stringify({ url: ELSEWHERE, token: "rotated-away" }),
    );

    const result = await wg(bin, ["offers", "list"], { HOME: home, WG_HUNT_URL: "" });
    expect(result.stderr).toMatch(/route: path/);
    expect(problemOf(result)).toMatchObject({ type: "unauthorized" });
    expect(sentToContainer(dockerLog)).toEqual([]);
  });

  it("keeps a CLI that cannot sign in when no other CLI route works, so it says to log in", async () => {
    const bin = baseBin();
    signedOutCli(bin, join(tmp(), "log"));
    const result = await wg(bin, ["offers", "list"]);
    expect(result.stderr).toMatch(/route: path/);
    expect(result.code).toBe(1);
    expect(problemOf(result)).toMatchObject({ type: "not-configured" });
  });

  it("falls through to the next route when the CLI cannot reach a server", async () => {
    apiDown = true;
    const bin = baseBin();
    const log = join(tmp(), "log");
    fakeCli(bin, log);
    fakeDocker(bin, log);
    const result = await wg(bin, ["crawl", "status"]);
    expect(result.stderr).toMatch(/route: compose/);
  });
});

describe("route 2: docker compose exec", () => {
  it("runs wg-hunt in the running service, with --json and no TTY, and says so", async () => {
    const bin = baseBin();
    const log = join(tmp(), "log");
    fakeDocker(bin, log);
    const result = await wg(bin, ["offers", "list"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{"from":"container"}\n');
    expect(result.stderr).toMatch(/route: compose/);
    expect(
      lines(log).some((l) => l.includes("compose exec -T wg-hunt wg-hunt --json offers list")),
    ).toBe(true);
  });

  it("finds a running container by its compose label when no compose file is in reach", async () => {
    const bin = baseBin();
    const log = join(tmp(), "log");
    fakeDocker(bin, log, "1.3.0", true);
    const result = await wg(bin, ["offers", "list"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/route: compose/);
    expect(lines(log).some((l) => l.startsWith("docker exec") && l.includes("abc123"))).toBe(true);
  });

  it("takes the service name from WG_HUNT_SERVICE", async () => {
    const bin = baseBin();
    const log = join(tmp(), "log");
    fakeDocker(bin, log);
    await wg(bin, ["crawl", "status"], { WG_HUNT_SERVICE: "hunter" });
    expect(lines(log).some((l) => l.includes("compose exec -T hunter wg-hunt"))).toBe(true);
  });
});

describe("route 3: curl against the API", () => {
  const withToken = () => {
    const data = tmp();
    writeFileSync(join(data, "access-token"), `${TOKEN}\n`);
    return { WG_HUNT_DATA_DIR: data };
  };

  it("calls the API with the token from the data folder and says so", async () => {
    const bin = baseBin();
    const result = await wg(bin, ["api", "GET", "/offers?band=match"], withToken());
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{"items":[]}');
    expect(result.stderr).toMatch(/route: curl/);
    const call = seen.find((s) => s.url === "/api/v1/offers?band=match");
    expect(call?.method).toBe("GET");
    expect(call?.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("prefers WG_HUNT_TOKEN, and sends a body from the argument or from stdin", async () => {
    const bin = baseBin();
    await wg(bin, ["api", "POST", "/ranking/preview", '{"a":1}'], { WG_HUNT_TOKEN: "from-env" });
    await wg(bin, ["api", "PUT", "/profile", "-"], { WG_HUNT_TOKEN: "from-env" }, '{"b":2}');
    const [first, second] = seen.filter((s) => s.method !== "GET");
    expect(first?.auth).toBe("Bearer from-env");
    expect(first?.body).toBe('{"a":1}');
    expect(second?.body).toBe('{"b":2}');
  });

  it("never prints the token, not even when the call fails", async () => {
    respond = (req) => (req.url.includes("/offers/") ? { status: 500, body: "{}" } : undefined);
    const bin = baseBin();
    const failed = await wg(bin, ["api", "GET", "/offers/1"], withToken());
    const ok = await wg(bin, ["doctor"], withToken());
    for (const r of [failed, ok]) expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });

  it("`doctor` says where the address and the token came from, in the CLI's words", async () => {
    const bin = baseBin();
    const result = await wg(bin, ["doctor"], withToken());
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `route: curl\nserver: 1.4.0\ncli: none\nurl: http://127.0.0.1:${apiPort} (env)\ntoken: data-folder\n`,
    );
    const fromEnv = await wg(bin, ["doctor"], { WG_HUNT_TOKEN: TOKEN });
    expect(fromEnv.stdout).toMatch(/^token: env$/m);
    expect(fromEnv.stdout + fromEnv.stderr).not.toContain(TOKEN);
  });

  it("exits by the problem's type with the CLI's table, the status only for a type it lacks", async () => {
    const bin = baseBin();
    const cases: [type: string, status: number][] = [
      ...Object.entries(PROBLEMS).map(([type, p]): [string, number] => [type, p.status]),
      ["http-error", 404],
      ["some-new-refusal", 409],
      ["some-new-conflict", 412],
      ["some-new-input", 422],
      ["some-new-failure", 503],
    ];
    for (const [type, status] of cases) {
      const problem = JSON.stringify({ type, title: "T", status });
      respond = (req) => (req.url.endsWith("/x") ? { status, body: problem } : undefined);
      const result = await wg(bin, ["api", "GET", "/x"], withToken());
      expect(result.code, `${type} (${status})`).toBe(exitCodeFor({ type, status }));
      expect(result.stderr).toContain(problem);
    }
  }, 30_000);

  it("keeps its table of types the same as the CLI's", () => {
    const script = readFileSync(SCRIPT, "utf8");
    const block = script.slice(
      script.indexOf("# exit-by-type: begin"),
      script.indexOf("# exit-by-type: end"),
    );
    const table: Record<string, number> = {};
    for (const [, types, code] of block.matchAll(/^\s+([a-z|-]+)\) echo (\d) ;;$/gm)) {
      for (const type of (types ?? "").split("|")) table[type] = Number(code);
    }
    const cli = Object.fromEntries(
      Object.entries(EXIT_BY_TYPE).filter(
        ([type, code]) =>
          code !== "by-status" && !(CLI_PROBLEM_TYPES as readonly string[]).includes(type),
      ),
    );
    expect(table).toEqual(cli);
  });

  it("lists the same crawl holds as the server for Crawl now", () => {
    const script = readFileSync(SCRIPT, "utf8");
    const holds = script.match(/# crawl-now-holds\n\s+([a-z|-]+)\)/)?.[1]?.split("|");
    expect(holds?.sort()).toEqual([...CRAWL_HOLDS].sort());
  });

  it("exits 4 for a Crawl now that waits for a Resume, like the CLI, with a problem on stderr", async () => {
    const bin = baseBin();
    const body = (waiting: string, runsAt: string | null) =>
      JSON.stringify({ queued: 1, runsAt, waiting, message: "Queued." });
    for (const [waiting, runsAt, code] of [
      ["paused", null, 4],
      ["cooldown", null, 4],
      ["cooldown", "2026-11-09T12:00:00.000Z", 0],
      ["gap", "2026-11-09T12:00:00.000Z", 0],
    ] as const) {
      respond = (req) =>
        req.url === "/api/v1/searches/1/crawl-now"
          ? { status: 200, body: body(waiting, runsAt) }
          : undefined;
      const result = await wg(bin, ["api", "POST", "/searches/1/crawl-now"], withToken());
      expect(result.code, `${waiting} ${runsAt}`).toBe(code);
      expect(result.stdout).toBe(body(waiting, runsAt));
      if (code === 4) {
        const problem = JSON.parse(result.stderr.trim().split("\n").at(-1) ?? "");
        expect(problem).toMatchObject({ type: "crawl-waits-for-resume", waiting });
      } else {
        expect(result.stderr).not.toContain("crawl-waits-for-resume");
      }
    }
  });

  it("notes a reply's revision on stderr and sends one back with --if-match", async () => {
    const etag = '"rev-1"';
    respond = (req) =>
      req.url === "/api/v1/filters"
        ? req.ifMatch === undefined || req.ifMatch === etag
          ? { status: 200, body: "{}", headers: { ETag: etag } }
          : { status: 412, body: JSON.stringify({ type: "stale-revision" }) }
        : undefined;
    const bin = baseBin();
    const shown = await wg(bin, ["api", "GET", "/filters"], withToken());
    expect(shown.stdout).toBe("{}");
    expect(shown.stderr).toContain(`revision: ${etag}`);

    const fresh = await wg(bin, ["api", "--if-match", etag, "PUT", "/filters", "{}"], withToken());
    expect(fresh.code).toBe(0);
    await wg(bin, ["api", "--if-match", "rev-1", "PUT", "/filters", "{}"], withToken());
    const stale = await wg(
      bin,
      ["api", "--if-match", "rev-0", "PUT", "/filters", "{}"],
      withToken(),
    );
    expect(stale.code).toBe(4);
    expect(stale.stderr).toContain("stale-revision");
    expect(seen.filter((s) => s.method === "PUT").map((s) => s.ifMatch)).toEqual([
      etag,
      etag,
      '"rev-0"',
    ]);
  });

  it("only reaches the wg-hunt API, never another address", async () => {
    const bin = baseBin();
    const result = await wg(bin, ["api", "GET", "https://www.wg-gesucht.de/"], withToken());
    expect(result.code).toBe(2);
    expect(seen.filter((s) => s.url !== "/api/v1/health")).toEqual([]);
  });

  it("lists the operations from the OpenAPI document", async () => {
    const bin = baseBin();
    const result = await wg(bin, ["ops", "crawl"], withToken());
    expect(result.stdout).toContain("POST /crawl/pause");
    expect(result.stdout).not.toContain("GET /offers");
  });

  it("explains that CLI commands need the CLI when only curl is available", async () => {
    const bin = baseBin();
    const result = await wg(bin, ["offers", "list"], withToken());
    expect(result.code).toBe(2);
    expect(problemOf(result)).toMatchObject({ type: "usage-error" });
    expect(result.stderr).toMatch(/api GET/);
  });

  it("writes a problem line for its own refusals too", async () => {
    const bin = baseBin();
    const usage = await wg(bin, ["api", "GET"], withToken());
    expect(usage.code).toBe(2);
    expect(problemOf(usage)).toMatchObject({ type: "usage-error" });

    const tokenless = await wg(bin, ["api", "GET", "/offers"]);
    expect(tokenless.code).toBe(1);
    expect(problemOf(tokenless)).toMatchObject({ type: "not-configured" });
  });

  it("works with a token saved by `wg-hunt login`", async () => {
    const bin = baseBin();
    const home = tmp();
    mkdirSync(join(home, ".config", "wg-hunt"), { recursive: true });
    writeFileSync(
      join(home, ".config", "wg-hunt", "config.json"),
      JSON.stringify({ url: `http://127.0.0.1:${apiPort}`, token: "from-config" }),
    );
    await wg(bin, ["api", "GET", "/offers"], { HOME: home, WG_HUNT_URL: "" });
    expect(seen.find((s) => s.url === "/api/v1/offers")?.auth).toBe("Bearer from-config");
  });
});

describe("the flows", () => {
  const flows = readFileSync(
    new URL("../.claude/skills/wg-hunt/flows.md", import.meta.url).pathname,
    "utf8",
  );

  it("write Filters over curl with a line that sends the edited file at the revision it was read at", async () => {
    const example = flows.match(/`(wg\.sh api --if-match [^`]+)`/)?.[1] ?? "";
    expect(example).toContain("<revision>");
    respond = (req) => {
      if (req.method !== "PUT" || req.url !== "/api/v1/filters") return undefined;
      try {
        JSON.parse(req.body);
        return { status: 200, body: req.body, headers: { ETag: '"rev-2"' } };
      } catch {
        return { status: 400, body: JSON.stringify({ type: "invalid-body" }) };
      }
    };
    const bin = baseBin();
    const data = tmp();
    writeFileSync(join(data, "access-token"), `${TOKEN}\n`);
    const cwd = tmp();
    const edited = '{"rent":{"enabled":true,"strength":"want"}}\n';
    writeFileSync(join(cwd, "filters.json"), edited);

    const result = await flowLine(
      bin,
      example.replace("<revision>", `'"rev-1"'`),
      { WG_HUNT_DATA_DIR: data },
      cwd,
    );
    expect(result.stderr).not.toContain("invalid-body");
    expect(result.code).toBe(0);
    expect(seen.filter((s) => s.method === "PUT")).toEqual([
      expect.objectContaining({ url: "/api/v1/filters", ifMatch: '"rev-1"', body: edited }),
    ]);
    expect(result.stdout).toBe(edited);
  });

  it("rename a Place the distance Filter measures from with one seeking set", () => {
    expect(flows).toMatch(/wg\.sh seeking set --profile \S+ --filters /);
  });

  it("send a Place rename over curl as one PUT /seeking with both halves", async () => {
    const example = flows.match(/`(wg\.sh api PUT \/seeking -[^`]*)`/)?.[1] ?? "";
    expect(example).toContain("both.json");
    respond = (req) =>
      req.method === "PUT" && req.url === "/api/v1/seeking"
        ? { status: 200, body: req.body }
        : undefined;
    const bin = baseBin();
    const data = tmp();
    writeFileSync(join(data, "access-token"), `${TOKEN}\n`);
    const cwd = tmp();
    const both =
      '{"profile":{"places":[{"name":"office","plz":"10115"}]},"filters":{"distance":{"place":"office"}},"revisions":{"profile":"\\"rev-p\\"","filters":"\\"rev-f\\""}}\n';
    writeFileSync(join(cwd, "both.json"), both);

    const result = await flowLine(bin, example, { WG_HUNT_DATA_DIR: data }, cwd);
    expect(result.code).toBe(0);
    const puts = seen.filter((s) => s.method === "PUT");
    expect(puts).toEqual([expect.objectContaining({ url: "/api/v1/seeking", body: both })]);
    expect(puts[0]?.ifMatch).toBeUndefined();
  });

  it("read a Search's Sweep from the JSON the script prints, not from the line the CLI writes for people", () => {
    for (const forPeople of ["Sweep line", "Backfill in progress", "next Sweep at"]) {
      expect(flows).not.toContain(forPeople);
    }
  });
});

describe("version check", () => {
  it("warns when the CLI and the server differ in major version", async () => {
    serverVersion = "2.0.0";
    const bin = baseBin();
    fakeCli(bin, join(tmp(), "log"), "1.2.0");
    const result = await wg(bin, ["crawl", "status"], { FAKE_SERVER_VERSION: "2.0.0" });
    expect(result.stderr).toMatch(/warning.*major/i);
    expect(result.stderr).toContain("1.2.0");
    expect(result.stderr).toContain("2.0.0");
    expect(result.code).toBe(0);
  });

  it("stays quiet when only the minor or patch version differs", async () => {
    const bin = baseBin();
    fakeCli(bin, join(tmp(), "log"), "1.2.0");
    const result = await wg(bin, ["crawl", "status"], { FAKE_SERVER_VERSION: "1.9.3" });
    expect(result.stderr).not.toMatch(/warning/i);
  });

  it("warns on the compose route too", async () => {
    const bin = baseBin();
    fakeDocker(bin, join(tmp(), "log"), "3.0.0");
    const result = await wg(bin, ["crawl", "status"], { FAKE_SERVER_VERSION: "1.0.0" });
    expect(result.stderr).toMatch(/warning.*major/i);
  });
});

describe("detection", () => {
  it("fails with what it tried when no route works", async () => {
    const bin = baseBin();
    const result = await wg(bin, ["crawl", "status"], { WG_HUNT_URL: "http://127.0.0.1:1" });
    expect(result.code).toBe(1);
    expect(problemOf(result)).toMatchObject({ type: "connection-failed" });
    expect(result.stderr).toMatch(/wg-hunt on PATH/);
    expect(result.stderr).toMatch(/docker compose/);
    expect(result.stderr).toMatch(/curl/);
  });

  it("does not offer a container here when nothing answers at another machine's address", async () => {
    const bin = baseBin();
    const log = join(tmp(), "log");
    fakeDocker(bin, log);
    stub(bin, "curl", `echo "curl $*" >> "${log}"\nexit 6`);

    const result = await wg(bin, ["crawl", "status"], { WG_HUNT_URL: ELSEWHERE });
    expect(result.code).toBe(1);
    expect(problemOf(result)).toMatchObject({
      type: "connection-failed",
      detail: expect.stringContaining(ELSEWHERE),
    });
    expect(lines(log).some((l) => l.includes(`${ELSEWHERE}/api/v1/health`))).toBe(true);
    expect(sentToContainer(log)).toEqual([]);
    expect(result.stderr).not.toMatch(/docker compose/);
    expect(result.stderr).toMatch(/WG_HUNT_ROUTE=compose/);
  });

  it("lets WG_HUNT_ROUTE pick a route", async () => {
    const bin = baseBin();
    const log = join(tmp(), "log");
    fakeCli(bin, log);
    fakeDocker(bin, log);
    const result = await wg(bin, ["offers", "list"], { WG_HUNT_ROUTE: "compose" });
    expect(result.stderr).toMatch(/route: compose/);
  });

  it("uses the container when WG_HUNT_ROUTE asks for it, whatever the address", async () => {
    const bin = baseBin();
    const log = join(tmp(), "log");
    signedOutCli(bin, log, "unauthorized");
    fakeDocker(bin, log);
    const result = await wg(bin, ["offers", "list"], {
      WG_HUNT_ROUTE: "compose",
      WG_HUNT_URL: ELSEWHERE,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{"from":"container"}\n');
    expect(result.stderr).toMatch(/route: compose/);
  });

  it("`doctor` gives the address the route reaches: the CLI's, or the container's own server", async () => {
    const bin = baseBin();
    const log = join(tmp(), "log");
    signedOutCli(bin, log, "unauthorized");
    fakeDocker(bin, log);

    const cli = await wg(bin, ["doctor"], { WG_HUNT_URL: ELSEWHERE });
    expect(cli.stdout).toMatch(/route: path/);
    expect(cli.stdout).toContain(`url: ${ELSEWHERE} (env)\n`);
    expect(cli.stdout).toMatch(/^sign-in: refused$/m);
    expect(cli.code).toBe(1);
    expect(problemOf(cli).type).toBe("unauthorized");

    const asked = await wg(bin, ["doctor"], { WG_HUNT_URL: ELSEWHERE, WG_HUNT_ROUTE: "compose" });
    expect(asked.stdout).toMatch(/route: compose/);
    expect(asked.stdout).toContain("url: the container's own server (container abc123)\n");
    expect(asked.stdout + asked.stderr).not.toContain("example.test");

    const fellThrough = await wg(bin, ["doctor"]);
    expect(fellThrough.stdout).toMatch(/route: compose/);
    expect(fellThrough.stdout).toContain("url: the container's own server (container abc123)\n");
    expect(fellThrough.stdout + fellThrough.stderr).not.toContain(`127.0.0.1:${apiPort}`);
  });

  it("takes the CLI command from WG_HUNT_CLI, such as a downloaded wg-hunt.mjs", async () => {
    const bin = baseBin();
    const log = join(tmp(), "log");
    const elsewhere = tmp();
    fakeCli(elsewhere, log);
    const result = await wg(bin, ["offers", "list"], { WG_HUNT_CLI: join(elsewhere, "wg-hunt") });
    expect(result.stdout).toBe('{"from":"cli"}\n');
    expect(result.stderr).toMatch(/route: path/);
  });

  it("`doctor` reports the route, the versions, and what the CLI says of its address and token", async () => {
    const bin = baseBin();
    const log = join(tmp(), "log");
    fakeCli(bin, log, "1.2.0");
    const result = await wg(bin, ["doctor"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `route: path\nserver: 1.4.0\ncli: 1.2.0\nurl: http://127.0.0.1:${apiPort} (env)\ntoken: none\nsign-in: ok\n`,
    );
    expect(lines(log)).toContain("--json doctor");
  });

  it("`doctor` names the token the chosen route's CLI reads, not one only the script would find", async () => {
    const bin = baseBin();
    fakeCli(bin, join(tmp(), "log"));
    const project = tmp();
    mkdirSync(join(project, ".data"));
    writeFileSync(join(project, ".data", "access-token"), `${TOKEN}\n`);
    const guessed = await wg(bin, ["doctor"], { WG_HUNT_COMPOSE_DIR: project });
    expect(guessed.stdout).toMatch(/route: path/);
    expect(guessed.stdout).toMatch(/^token: none$/m);

    const named = await wg(bin, ["doctor"], { WG_HUNT_DATA_DIR: join(project, ".data") });
    expect(named.stdout).toMatch(/^token: data-folder$/m);
  });

  it("`doctor` says unknown, not empty, when the CLI's doctor prints nothing", async () => {
    const bin = baseBin();
    stub(
      bin,
      "wg-hunt",
      `case "$*" in
  *--version*) echo 1.6.0; exit 0;;
  *health*) echo '{"status":"ok","version":"1.6.0"}'; exit 0;;
  *doctor*) exit 1;;
esac
echo '{"items":[]}'`,
    );
    const result = await wg(bin, ["doctor"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^url: unknown$/m);
    expect(result.stdout).toMatch(/^token: unknown$/m);
    expect(result.stdout).toMatch(/^sign-in: unknown$/m);
  });

  it("`doctor` with a CLI too old to have one says so, and still exits 0", async () => {
    const bin = baseBin();
    stub(
      bin,
      "wg-hunt",
      `case "$*" in
  *--version*) echo 1.5.0; exit 0;;
  *health*) echo '{"status":"ok","version":"1.5.0"}'; exit 0;;
  *doctor*) echo '{"type":"usage-error","title":"Usage error","detail":"unknown command"}' >&2; exit 2;;
esac
echo '{"items":[]}'`,
    );
    const result = await wg(bin, ["doctor"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^route: path$/m);
    expect(result.stdout).toMatch(/^url: unknown$/m);
    expect(result.stdout).toMatch(/^token: unknown$/m);
    expect(result.stderr).toMatch(/^wg-hunt: .*update/m);
    expect(result.stderr.split("\n").filter((line) => line.startsWith("{"))).toEqual([]);
  });

  it("drops a remembered route that stopped answering, and says how to start the server", async () => {
    const bin = baseBin();
    const log = join(tmp(), "log");
    stub(
      bin,
      "wg-hunt",
      `echo "$*" >> "${log}"
[ -f "${log}.down" ] && { echo '{"type":"connection-failed","title":"Could not reach the server"}' >&2; exit 1; }
case "$*" in
  *--version*) echo 1.4.0; exit 0;;
  *health*) echo '{"status":"ok","version":"1.4.0"}'; exit 0;;
esac
echo '{"from":"cli"}'`,
    );
    const env = { WG_HUNT_CACHE_TTL: "300", TMPDIR: tmp(), WG_HUNT_URL: "http://127.0.0.1:1" };
    expect((await wg(bin, ["crawl", "status"], env)).code).toBe(0);
    writeFileSync(`${log}.down`, "");
    const down = await wg(bin, ["crawl", "status"], env);
    expect(down.code).toBe(1);
    expect(down.stderr).toContain("connection-failed");
    expect(down.stderr).toMatch(/no route to a wg-hunt server/);
    expect(down.stderr).toMatch(/docker compose up -d/);
    rmSync(`${log}.down`);
    const before = lines(log).length;
    expect((await wg(bin, ["crawl", "status"], env)).stderr).toMatch(/route: path/);
    expect(
      lines(log)
        .slice(before)
        .some((l) => l.includes("health")),
    ).toBe(true);
  });

  it("remembers the route for a while, so a second call skips detection", async () => {
    const bin = baseBin();
    const log = join(tmp(), "log");
    fakeCli(bin, log);
    const env = { WG_HUNT_CACHE_TTL: "300", TMPDIR: tmp() };
    await wg(bin, ["crawl", "status"], env);
    const first = lines(log).length;
    await wg(bin, ["crawl", "status"], env);
    expect(lines(log).length - first).toBe(1);
  });

  describe("a route remembered while the CLI could not sign in", () => {
    function setUp() {
      const bin = baseBin();
      const cliLog = join(tmp(), "cli-log");
      const home = tmp();
      const config = join(home, ".config", "wg-hunt", "config.json");
      mkdirSync(join(home, ".config", "wg-hunt"), { recursive: true });
      stub(
        bin,
        "wg-hunt",
        `echo "$*" >> "${cliLog}"
case "$*" in
  *--version*) echo 1.2.0; exit 0;;
  *health*) echo '{"status":"ok","version":"'"$FAKE_SERVER_VERSION"'"}'; exit 0;;
esac
[ "$WG_HUNT_TOKEN" = "${TOKEN}" ] || grep -q "${TOKEN}" "${config}" 2>/dev/null || {
  echo '{"type":"unauthorized","title":"Cannot sign in"}' >&2; exit 1; }
echo '{"from":"cli"}'`,
      );
      fakeDocker(bin, join(tmp(), "docker-log"));
      const env = { WG_HUNT_CACHE_TTL: "300", TMPDIR: tmp(), HOME: home };
      const list = (extra: Record<string, string> = {}) =>
        wg(bin, ["offers", "list"], { ...env, ...extra });
      const rememberTheContainer = async () => {
        expect((await list()).stdout).toBe('{"from":"container"}\n');
        const asked = lines(cliLog).length;
        expect((await list()).stdout).toBe('{"from":"container"}\n');
        expect(lines(cliLog).length).toBe(asked);
      };
      return { config, list, rememberTheContainer };
    }

    it("is looked for again once WG_HUNT_TOKEN is set", async () => {
      const { list, rememberTheContainer } = setUp();
      await rememberTheContainer();
      const signedIn = await list({ WG_HUNT_TOKEN: TOKEN });
      expect(signedIn.stdout).toBe('{"from":"cli"}\n');
      expect(signedIn.stderr).toMatch(/route: path/);
    });

    it("is looked for again once a login saves a token", async () => {
      const { config, list, rememberTheContainer } = setUp();
      await rememberTheContainer();
      writeFileSync(config, JSON.stringify({ token: TOKEN }));
      const signedIn = await list();
      expect(signedIn.stdout).toBe('{"from":"cli"}\n');
      expect(signedIn.stderr).toMatch(/route: path/);
    });

    it("is looked for again once a login replaces a token the server refused", async () => {
      const { config, list, rememberTheContainer } = setUp();
      writeFileSync(config, JSON.stringify({ token: "rotated-away" }));
      const earlier = new Date(Date.now() - 60_000);
      utimesSync(config, earlier, earlier);
      await rememberTheContainer();
      writeFileSync(config, JSON.stringify({ token: TOKEN }));
      const signedIn = await list();
      expect(signedIn.stdout).toBe('{"from":"cli"}\n');
      expect(signedIn.stderr).toMatch(/route: path/);
    });
  });
});

describe("the token", () => {
  const NEW_TOKEN = "tok-brand-new-9876543210";
  let cliBundle: string;
  const root = mkdtempSync(join(tmpdir(), "wg-skill-cli-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  beforeAll(async () => {
    const cli = new URL("../apps/cli/", import.meta.url).pathname;
    await build({
      config: join(cli, "tsdown.config.ts"),
      cwd: cli,
      outDir: join(root, "out"),
      logLevel: "silent",
    });
    cliBundle = join(root, "out", "wg-hunt.mjs");
  }, 60_000);

  function realCli() {
    const bin = baseBin();
    stub(bin, "wg-hunt", `exec "${process.execPath}" "${cliBundle}" "$@"`);
    const home = tmp();
    mkdirSync(join(home, ".config", "wg-hunt"), { recursive: true });
    const config = join(home, ".config", "wg-hunt", "config.json");
    writeFileSync(config, JSON.stringify({ url: `http://127.0.0.1:${apiPort}`, token: TOKEN }));
    respond = (req) =>
      req.url === "/api/v1/auth/token/rotate"
        ? { status: 200, body: JSON.stringify({ token: NEW_TOKEN }) }
        : undefined;
    return { bin, home, config, env: { HOME: home, WG_HUNT_URL: "" } };
  }

  it("`token rotate` saves the new token and prints no token", async () => {
    const { bin, config, env } = realCli();
    const result = await wg(bin, ["token", "rotate"], env);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      rotated: true,
      saved: expect.stringContaining("config.json"),
    });
    for (const text of [result.stdout, result.stderr]) {
      expect(text).not.toContain(NEW_TOKEN);
      expect(text).not.toContain(TOKEN);
    }
    expect(JSON.parse(readFileSync(config, "utf8")).token).toBe(NEW_TOKEN);
  });

  it("`doctor` shows what the real CLI reports, and no token", async () => {
    const { bin, env } = realCli();
    const result = await wg(bin, ["doctor"], env);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`url: http://127.0.0.1:${apiPort} (config)\n`);
    expect(result.stdout).toMatch(/^token: config$/m);
    expect(result.stdout).toMatch(/^sign-in: ok$/m);
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
  });

  it("`doctor` exits 1 with the CLI's problem when the server refuses the token", async () => {
    const { bin, env } = realCli();
    respond = (req) =>
      req.url === "/api/v1/auth/session"
        ? {
            status: 401,
            body: JSON.stringify({ type: "unauthorized", title: "Unauthorized", status: 401 }),
            headers: { "content-type": "application/problem+json" },
          }
        : undefined;
    const result = await wg(bin, ["doctor"], env);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^sign-in: refused$/m);
    expect(problemOf(result)).toMatchObject({ type: "unauthorized" });
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
  });

  it("will not rotate through `api` either, which would print the new token", async () => {
    const { bin, config, env } = realCli();
    const result = await wg(bin, ["api", "POST", "/auth/token/rotate"], env);
    expect(result.code).toBe(2);
    expect(result.stdout + result.stderr).not.toContain(NEW_TOKEN);
    expect(seen.filter((r) => r.url.includes("/auth/token/rotate"))).toEqual([]);
    expect(JSON.parse(readFileSync(config, "utf8")).token).toBe(TOKEN);
  });
});

describe("the cities flows.md names", () => {
  const flows = readFileSync(
    new URL("../.claude/skills/wg-hunt/flows.md", import.meta.url),
    "utf8",
  );
  const named = (flows.match(/knows the Source's id for (.+?), in any case/)?.[1] ?? "").split(
    /, | and /,
  );

  const idOf = (city: string) => {
    const pages = wgGesuchtSource.searchPages(
      {
        city,
        cityId: null,
        categories: ["flatshare-room"],
        rentTypes: ["unlimited"],
        priceCeiling: null,
        recencyDays: 7,
      },
      0,
    );
    return pages.ok ? pages.requests[0]?.path.match(/\.(\d+)\.0\.1\.0\.html/)?.[1] : undefined;
  };

  it("are the cities the adapter knows the id of, and no others", () => {
    expect(named.map(idOf).sort()).toEqual(KNOWN_CITIES.map((city) => city.id).sort());
  });
});
