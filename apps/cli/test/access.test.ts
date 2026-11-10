import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { apiText, cliFor, serverWith, tempDir } from "./harness.js";

const KEY = "sk-ant-api03-TESTKEYVALUE1234567890";

function recordingFetch(server: Awaited<ReturnType<typeof serverWith>>) {
  const urls: string[] = [];
  const fetch = (request: Request) => {
    urls.push(request.url);
    return Promise.resolve(server.runtime.app.request(request));
  };
  return { urls, fetch };
}

describe("configuration", () => {
  it("reads the server and token from WG_HUNT_URL and WG_HUNT_TOKEN", async () => {
    const server = await serverWith();
    const seen = recordingFetch(server);
    const wg = cliFor(server.runtime, {
      fetch: seen.fetch,
      env: { WG_HUNT_URL: "https://wg.example/", WG_HUNT_TOKEN: server.runtime.token },
    });
    expect((await wg("offers", "list")).code).toBe(0);
    expect(seen.urls[0]).toMatch(/^https:\/\/wg\.example\/api\/v1\/offers/);
  });

  it("takes --url over the environment", async () => {
    const server = await serverWith();
    const seen = recordingFetch(server);
    const wg = cliFor(server.runtime, {
      fetch: seen.fetch,
      env: { WG_HUNT_URL: "https://env.example", WG_HUNT_TOKEN: server.runtime.token },
    });
    await wg("--url", "https://flag.example", "crawl", "status");
    expect(seen.urls[0]).toMatch(/^https:\/\/flag\.example\/api\/v1\/crawl/);
  });

  it("falls back to the local server when nothing says where it is", async () => {
    const server = await serverWith();
    const seen = recordingFetch(server);
    const env = { WG_HUNT_TOKEN: server.runtime.token };
    await cliFor(server.runtime, { fetch: seen.fetch, env })("health");
    await cliFor(server.runtime, { fetch: seen.fetch, env: { ...env, WG_HUNT_PORT: "9001" } })(
      "health",
    );
    expect(seen.urls.map((url) => new URL(url).origin)).toEqual([
      "http://127.0.0.1:8787",
      "http://127.0.0.1:9001",
    ]);
  });

  it("needs no setup inside the container: the token is read from the data folder", async () => {
    const server = await serverWith();
    // In the image WG_HUNT_DATA_DIR is a path relative to the working directory.
    const wg = cliFor(server.runtime, {
      env: { WG_HUNT_DATA_DIR: basename(server.dataDir) },
      cwd: dirname(server.dataDir),
    });
    const result = await wg("offers", "list");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Cheap room");
  });

  it("has no token to send when none of the sources has one", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime, { env: { WG_HUNT_DATA_DIR: join(tempDir(), "missing") } });
    const result = await wg("offers", "list");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).detail).toContain("wg-hunt login");
  });
});

describe("--url with the token `login` saved for another address", () => {
  function loggedIn(server: Awaited<ReturnType<typeof serverWith>>, url = "http://wg-hunt.test") {
    const homeDir = tempDir();
    mkdirSync(join(homeDir, ".config", "wg-hunt"), { recursive: true });
    writeFileSync(
      join(homeDir, ".config", "wg-hunt", "config.json"),
      JSON.stringify({ url, token: server.runtime.token }),
    );
    return homeDir;
  }

  it("warns on stderr that the token belongs to the saved address, and still sends it", async () => {
    const server = await serverWith();
    const seen = recordingFetch(server);
    const wg = cliFor(server.runtime, { homeDir: loggedIn(server), env: {}, fetch: seen.fetch });
    const result = await wg("--url", "https://other.example", "offers", "list", "--json");
    expect(result.code).toBe(0);
    expect(seen.urls).toHaveLength(1);
    const sent = new URL(seen.urls[0] ?? "");
    expect(sent.origin).toBe("https://other.example");
    expect(result.stdout).toBe(
      (await apiText(server.runtime, `${sent.pathname.replace("/api/v1", "")}${sent.search}`)).text,
    );
    expect(result.stderr).toMatch(/^wg-hunt: warning: .*http:\/\/wg-hunt\.test/);
    expect(result.stderr).toContain("https://other.example");
    expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(result.stderr).not.toContain(server.runtime.token);
  });

  it("does not warn for the same origin, for a token from the environment, or without a token", async () => {
    const server = await serverWith();
    const homeDir = loggedIn(server);
    const same = await cliFor(server.runtime, { homeDir, env: {} })(
      "--url",
      "http://WG-HUNT.test:80/",
      "offers",
      "list",
    );
    const fromEnv = await cliFor(server.runtime, {
      homeDir,
      env: { WG_HUNT_TOKEN: server.runtime.token },
    })("--url", "https://other.example", "offers", "list");
    const anonymous = await cliFor(server.runtime, { homeDir, env: {} })(
      "--url",
      "https://other.example",
      "health",
    );
    for (const result of [same, fromEnv, anonymous]) {
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
    }
  });
});

describe("a refused token", () => {
  const WRONG = "Z".repeat(43);
  const setups = {
    env: () => ({ env: { WG_HUNT_URL: "http://wg-hunt.test", WG_HUNT_TOKEN: WRONG } }),
    config: () => {
      const homeDir = tempDir();
      mkdirSync(join(homeDir, ".config", "wg-hunt"), { recursive: true });
      writeFileSync(
        join(homeDir, ".config", "wg-hunt", "config.json"),
        JSON.stringify({ url: "http://wg-hunt.test", token: WRONG }),
      );
      return { homeDir, env: {} };
    },
    "data-folder": () => {
      const dataDir = tempDir();
      writeFileSync(join(dataDir, "access-token"), `${WRONG}\n`);
      return { env: { WG_HUNT_URL: "http://wg-hunt.test", WG_HUNT_DATA_DIR: dataDir } };
    },
  };

  it("gets advice that says what to do about where the token came from", async () => {
    const server = await serverWith();
    const details: Record<string, string> = {};
    for (const [source, setup] of Object.entries(setups)) {
      const result = await cliFor(server.runtime, setup())("offers", "list", "--json");
      expect(result.code, source).toBe(1);
      const problem = JSON.parse(result.stderr);
      expect(problem, source).toMatchObject({ type: "unauthorized", status: 401 });
      expect(result.stdout + result.stderr).not.toContain(WRONG);
      details[source] = problem.detail;
    }
    expect(details.env).toMatch(/WG_HUNT_TOKEN/);
    expect(details.config).toMatch(/wg-hunt login/);
    expect(details.config).not.toMatch(/WG_HUNT_TOKEN/);
    expect(details["data-folder"]).toMatch(/again/);
    expect(new Set(Object.values(details)).size).toBe(3);
  });
});

describe("login", () => {
  it("saves the address and the token it was given on stdin, for later runs", async () => {
    const server = await serverWith();
    const homeDir = tempDir();
    const login = cliFor(server.runtime, {
      homeDir,
      env: { WG_HUNT_URL: "http://wg-hunt.test" },
      stdin: `${server.runtime.token}\n`,
    });
    const result = await login("login");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("~/.config/wg-hunt/config.json");
    expect(result.stdout + result.stderr).not.toContain(server.runtime.token);

    const file = join(homeDir, ".config", "wg-hunt", "config.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      url: "http://wg-hunt.test",
      token: server.runtime.token,
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const later = await cliFor(server.runtime, { homeDir, env: {} })("offers", "list");
    expect(later.code).toBe(0);
  });

  it.each([
    { mode: "as text", flags: [] },
    { mode: "under --json", flags: ["--json"] },
  ])(
    "saves, and warns on stderr that WG_HUNT_TOKEN still wins while it is set, $mode",
    async ({ flags }) => {
      const server = await serverWith();
      const homeDir = tempDir();
      const stale = "S".repeat(43);
      const result = await cliFor(server.runtime, {
        homeDir,
        env: { WG_HUNT_URL: "http://wg-hunt.test", WG_HUNT_TOKEN: stale },
        stdin: `${server.runtime.token}\n`,
      })(...flags, "login");
      expect(result.code).toBe(0);
      expect(result.stderr).toMatch(/^wg-hunt: warning: .*WG_HUNT_TOKEN/);
      if (flags.length > 0) expect(result.stdout).toBe("");
      for (const secret of [server.runtime.token, stale]) {
        expect(result.stdout + result.stderr).not.toContain(secret);
      }
      const file = join(homeDir, ".config", "wg-hunt", "config.json");
      expect(JSON.parse(readFileSync(file, "utf8")).token).toBe(server.runtime.token);
    },
  );

  it("says nothing on stderr when no WG_HUNT_TOKEN is set", async () => {
    const server = await serverWith();
    const result = await cliFor(server.runtime, {
      env: { WG_HUNT_URL: "http://wg-hunt.test" },
      stdin: `${server.runtime.token}\n`,
    })("login");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("asks at a prompt that does not echo when stdin is a terminal", async () => {
    const server = await serverWith();
    const asked: string[] = [];
    const result = await cliFor(server.runtime, {
      stdin: null,
      env: { WG_HUNT_URL: "http://wg-hunt.test" },
      prompt: (label) => {
        asked.push(label);
        return server.runtime.token;
      },
    })("login");
    expect(result.code).toBe(0);
    expect(asked).toEqual(["Access token: "]);
    expect(result.stdout + result.stderr).not.toContain(server.runtime.token);
  });

  it("saves nothing when the server does not take the token", async () => {
    const server = await serverWith();
    const homeDir = tempDir();
    const result = await cliFor(server.runtime, {
      homeDir,
      env: { WG_HUNT_URL: "http://wg-hunt.test" },
      stdin: `${"w".repeat(43)}\n`,
    })("login");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ type: "unauthorized" });
    expect(result.stderr).not.toContain("w".repeat(43));
    expect(existsSync(join(homeDir, ".config", "wg-hunt", "config.json"))).toBe(false);
  });

  it("refuses an empty token, and never takes one as an argument", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime, { env: { WG_HUNT_URL: "http://wg-hunt.test" }, stdin: "\n" });
    expect((await wg("login")).code).toBe(2);
    const argv = await wg("login", "--token", "secret-in-argv-123");
    expect(argv.code).toBe(2);
    expect(argv.stdout + argv.stderr).not.toContain("secret-in-argv-123");
  });
});

describe("the access token is never printed", () => {
  it("not on success, not on any kind of failure, not in --help", async () => {
    const server = await serverWith();
    const token = server.runtime.token;
    const wrong = "Z".repeat(43);
    const runs = [
      cliFor(server.runtime)("offers", "list"),
      cliFor(server.runtime)("offers", "list", "--json"),
      cliFor(server.runtime)("offer", "show", "99999"),
      cliFor(server.runtime)("offers", "frobnicate"),
      cliFor(server.runtime)("--help"),
      cliFor(server.runtime, { env: { WG_HUNT_TOKEN: wrong } })("offers", "list"),
      cliFor(server.runtime, {
        env: { WG_HUNT_TOKEN: token },
        fetch: () => Promise.reject(new TypeError("fetch failed")),
      })("offers", "list"),
    ];
    for (const { stdout, stderr } of await Promise.all(runs)) {
      for (const secret of [token, wrong]) {
        expect(stdout).not.toContain(secret);
        expect(stderr).not.toContain(secret);
      }
    }
  });
});

describe("secret", () => {
  it("sets a secret from standard input and shows only a masked hint", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime, { stdin: `${KEY}\n` });
    const result = await wg("secret", "set", "anthropic");
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(KEY);

    const listed = await cliFor(server.runtime)("secret", "list");
    expect(listed.stdout).toMatch(/anthropic +yes/);
    expect(listed.stdout).not.toContain(KEY);
    const stored = JSON.parse((await apiText(server.runtime, "/secrets")).text);
    expect(stored[0]).toMatchObject({ name: "anthropic", set: true });
  });

  it("sets a secret from a prompt that does not echo when stdin is a terminal", async () => {
    const server = await serverWith();
    const asked: string[] = [];
    const wg = cliFor(server.runtime, {
      stdin: null,
      prompt: (label) => {
        asked.push(label);
        return KEY;
      },
    });
    const result = await wg("secret", "set", "anthropic");
    expect(result.code).toBe(0);
    expect(asked).toEqual(["Value for anthropic: "]);
    expect(result.stdout + result.stderr).not.toContain(KEY);
    expect(JSON.parse((await apiText(server.runtime, "/secrets")).text)[0].set).toBe(true);
  });

  it("cannot be given the value as an argument, and the refusal does not repeat it", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime, { stdin: "" });
    for (const argv of [
      ["secret", "set", "anthropic", KEY],
      ["secret", "set", "anthropic", "--value", KEY],
      ["secret", "set", "anthropic", `--value=${KEY}`],
      ["secret", "set", `--key=${KEY}`],
      ["--url", "http://wg-hunt.test", "secret", "set", "anthropic", KEY],
    ]) {
      const result = await wg(...argv);
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.stdout + result.stderr, argv.join(" ")).not.toContain(KEY);
    }
    expect(JSON.parse((await apiText(server.runtime, "/secrets")).text)[0].set).toBe(false);
  });

  it("refuses an empty value without calling the API", async () => {
    const server = await serverWith();
    const result = await cliFor(server.runtime, { stdin: "  \n" })("secret", "set", "anthropic");
    expect(result.code).toBe(2);
  });

  it("does not know a secret by that name", async () => {
    const server = await serverWith();
    const result = await cliFor(server.runtime, { stdin: `${KEY}\n` })("secret", "set", "nope");
    expect(result.code).toBe(3);
    expect(result.stdout + result.stderr).not.toContain(KEY);
  });

  it("clears a secret", async () => {
    const server = await serverWith();
    await cliFor(server.runtime, { stdin: `${KEY}\n` })("secret", "set", "anthropic");
    const cleared = await cliFor(server.runtime)("secret", "clear", "anthropic");
    expect(cleared.code).toBe(0);
    expect(JSON.parse((await apiText(server.runtime, "/secrets")).text)[0].set).toBe(false);
  });

  it("sends nothing to a model provider once a key is saved and Offers wait to be read", async () => {
    const hosts: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      hosts.push(new URL(input instanceof Request ? input.url : input).host);
      return Response.json(
        { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
        { status: 401 },
      );
    });
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const server = await serverWith();
    await cliFor(server.runtime, { stdin: `${KEY}\n` })("secret", "set", "anthropic");
    await server.runtime.analysis.idle();
    expect(hosts).toEqual([]);
  });
});

describe("token rotate", () => {
  async function loggedIn() {
    const server = await serverWith();
    const homeDir = tempDir();
    const old = server.runtime.token;
    await cliFor(server.runtime, {
      homeDir,
      env: { WG_HUNT_URL: "http://wg-hunt.test" },
      stdin: old,
    })("login");
    return { server, homeDir, old };
  }

  it("saves the new token where the old one came from, without printing it", async () => {
    const { server, homeDir, old } = await loggedIn();
    const wg = cliFor(server.runtime, { homeDir, env: {} });
    const result = await wg("token", "rotate");
    expect(result.code).toBe(0);
    const fresh = server.runtime.token;
    expect(fresh).not.toBe(old);
    expect(result.stdout + result.stderr).not.toContain(fresh);
    expect(result.stdout + result.stderr).not.toContain(old);
    expect((await wg("offers", "list")).code).toBe(0);
    const stale = cliFor(server.runtime, {
      env: { WG_HUNT_TOKEN: old, WG_HUNT_URL: "http://x.test" },
    });
    expect((await stale("offers", "list")).code).toBe(1);
  });

  it("under --json says that it rotated and where it saved, without the token", async () => {
    const { server, homeDir, old } = await loggedIn();
    const wg = cliFor(server.runtime, { homeDir, env: {} });
    const result = await wg("--json", "token", "rotate");
    expect(result.code).toBe(0);
    const fresh = server.runtime.token;
    expect(fresh).not.toBe(old);
    expect(JSON.parse(result.stdout)).toEqual({
      rotated: true,
      saved: "~/.config/wg-hunt/config.json",
    });
    expect(result.stdout + result.stderr).not.toContain(fresh);
    expect(result.stdout + result.stderr).not.toContain(old);
    expect((await wg("offers", "list")).code).toBe(0);
  });

  it("under --json prints the new token only when --print is given", async () => {
    const { server, homeDir } = await loggedIn();
    const result = await cliFor(server.runtime, { homeDir, env: {} })(
      "--json",
      "token",
      "rotate",
      "--print",
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ token: server.runtime.token });
  });

  it("under --json will not rotate a token from the environment without --print", async () => {
    const server = await serverWith();
    const old = server.runtime.token;
    const result = await cliFor(server.runtime)("--json", "token", "rotate");
    expect(result.code).toBe(2);
    expect(server.runtime.token).toBe(old);
  });

  it("will not rotate a token from the environment, which would lose the new one", async () => {
    const server = await serverWith();
    const old = server.runtime.token;
    const result = await cliFor(server.runtime)("token", "rotate");
    expect(result.code).toBe(2);
    expect(server.runtime.token).toBe(old);
  });

  it("prints the new token once when asked to", async () => {
    const server = await serverWith();
    const result = await cliFor(server.runtime)("token", "rotate", "--print");
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(server.runtime.token);
  });

  it("in the container, leaves the new token in the data folder where it is read from", async () => {
    const server = await serverWith();
    const wg = cliFor(server.runtime, {
      env: { WG_HUNT_DATA_DIR: server.dataDir },
      fetch: undefined,
    });
    const result = await wg("token", "rotate");
    expect(result.code).toBe(0);
    expect(readFileSync(join(server.dataDir, "access-token"), "utf8").trim()).toBe(
      server.runtime.token,
    );
    expect((await wg("offers", "list")).code).toBe(0);
  });
});
