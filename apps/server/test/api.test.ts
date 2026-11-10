import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bootTestApp, tempDataDir } from "./helpers.js";

const RELEASE_VERSION: string = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
).version;

const ORIGIN = "http://localhost";

describe("public routes", () => {
  it("serves health with the version and no token", async () => {
    const { app } = bootTestApp();
    const res = await app.request("/api/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: RELEASE_VERSION });
  });

  it("reports the release version in the OpenAPI document", async () => {
    const { app } = bootTestApp();
    const doc = await (await app.request("/api/v1/openapi.json")).json();
    expect(doc.info.version).toBe(RELEASE_VERSION);
  });

  it("serves the generated OpenAPI document with no token", async () => {
    const { app } = bootTestApp();
    const res = await app.request("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.servers).toEqual([{ url: "/api/v1" }]);
    expect(Object.keys(doc.paths)).toContain("/health");
  });
});

describe("authentication", () => {
  it("answers 401 problem+json with a stable type when no credentials are sent", async () => {
    const { app } = bootTestApp();
    const res = await app.request("/api/v1/offers");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(await res.json()).toMatchObject({
      type: "unauthorized",
      status: 401,
      title: expect.any(String),
    });
  });

  it("rejects a wrong Bearer token", async () => {
    const { app } = bootTestApp();
    const res = await app.request("/api/v1/offers", { headers: { Authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });

  it("lets a valid Bearer token through to routing (unknown route → 404 problem)", async () => {
    const { app, token } = bootTestApp();
    const res = await app.request("/api/v1/nothing-here", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect((await res.json()).type).toBe("not-found");
  });
});

describe("dashboard session", () => {
  async function login(app: ReturnType<typeof bootTestApp>["app"], token: string) {
    return app.request("/api/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ token }),
    });
  }

  it("exchanges the token for an HttpOnly SameSite=Strict cookie", async () => {
    const { app, token } = bootTestApp();
    const res = await login(app, token);
    expect(res.status).toBe(204);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).not.toContain(token);
  });

  it("refuses a wrong token", async () => {
    const { app } = bootTestApp();
    const res = await login(app, "wrong");
    expect(res.status).toBe(401);
    expect((await res.json()).type).toBe("invalid-token");
  });

  it("accepts the cookie on reads, and logout clears it", async () => {
    const { app, token } = bootTestApp();
    const cookie = (await login(app, token)).headers.get("set-cookie")?.split(";")[0] ?? "";
    const read = await app.request("/api/v1/nothing-here", { headers: { Cookie: cookie } });
    expect(read.status).toBe(404);
    const out = await app.request("/api/v1/auth/session", {
      method: "DELETE",
      headers: { Cookie: cookie, Origin: ORIGIN },
    });
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
  });

  it("refuses a cookie-authenticated write with a foreign Origin", async () => {
    const { app, token } = bootTestApp();
    const cookie = (await login(app, token)).headers.get("set-cookie")?.split(";")[0] ?? "";
    const res = await app.request("/api/v1/auth/session", {
      method: "DELETE",
      headers: { Cookie: cookie, Origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).type).toBe("origin-not-allowed");
  });

  it("refuses a cookie-authenticated write with no Origin", async () => {
    const { app, token } = bootTestApp();
    const cookie = (await login(app, token)).headers.get("set-cookie")?.split(";")[0] ?? "";
    const res = await app.request("/api/v1/auth/session", {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(403);
  });

  it("does not check Origin for Bearer-authenticated writes", async () => {
    const { app, token } = bootTestApp();
    const res = await app.request("/api/v1/auth/session", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(204);
  });
});

describe("data folder", () => {
  it("holds the SQLite file in WAL mode and the token", () => {
    const dir = tempDataDir();
    const { token, db } = bootTestApp(dir);
    expect(existsSync(join(dir, "wg-hunt.sqlite"))).toBe(true);
    expect(readFileSync(join(dir, "access-token"), "utf8").trim()).toBe(token);
    expect(db.$client.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("creates the data folder when missing", () => {
    const dir = join(tempDataDir(), "nested", "data");
    bootTestApp(dir);
    expect(existsSync(join(dir, "wg-hunt.sqlite"))).toBe(true);
  });

  it("keeps the token and migrations across a second start", () => {
    const dir = tempDataDir();
    const first = bootTestApp(dir);
    first.close();
    const second = bootTestApp(dir);
    expect(second.token).toBe(first.token);
    const journal = JSON.parse(
      readFileSync(join(import.meta.dirname, "../drizzle/meta/_journal.json"), "utf8"),
    ) as {
      entries: unknown[];
    };
    expect(
      second.db.$client.prepare("select count(*) as n from __drizzle_migrations").get(),
    ).toEqual({ n: journal.entries.length });
  });
});

describe("hardening", () => {
  it("refuses a login with an empty token", async () => {
    const { app } = bootTestApp();
    const res = await app.request("/api/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ token: "" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).type).toBe("validation-error");
  });

  it("refuses a login from a foreign Origin", async () => {
    const { app, token } = bootTestApp();
    const res = await app.request("/api/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).type).toBe("origin-not-allowed");
  });

  it("maps malformed JSON to a 400 invalid-body problem", async () => {
    const { app } = bootTestApp();
    const res = await app.request("/api/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: "{",
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect((await res.json()).type).toBe("invalid-body");
  });

  it("describes validation failures readably", async () => {
    const { app } = bootTestApp();
    const res = await app.request("/api/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({}),
    });
    const body = await res.json();
    expect(body.detail).toContain("token");
    expect(body.detail).not.toContain("[");
  });

  it("sends WWW-Authenticate on 401 and accepts the Bearer scheme in any case", async () => {
    const { app, token } = bootTestApp();
    const denied = await app.request("/api/v1/not-a-route");
    expect(denied.headers.get("www-authenticate")).toBe("Bearer");
    const ok = await app.request("/api/v1/not-a-route", {
      headers: { Authorization: `bearer ${token}` },
    });
    expect(ok.status).toBe(404);
  });

  it("lets HEAD reach health without a token", async () => {
    const { app } = bootTestApp();
    expect((await app.request("/api/v1/health", { method: "HEAD" })).status).toBe(200);
  });

  it("declares bearer security globally and none on public routes", async () => {
    const { app } = bootTestApp();
    const doc = await (await app.request("/api/v1/openapi.json")).json();
    expect(doc.security).toEqual([{ bearerAuth: [] }, { cookieAuth: [] }]);
    expect(doc.paths["/health"].get.security).toEqual([]);
    expect(doc.paths["/auth/session"].post.security).toEqual([]);
    expect(doc.paths["/auth/session"].delete.security).toBeUndefined();
  });
});

describe("public routes with path parameters", () => {
  it("are derived from security: [] on the route", async () => {
    const { z, createRoute } = await import("@hono/zod-openapi");
    const route = (security: [] | undefined, path: string) =>
      createRoute({
        method: "get",
        path,
        security,
        request: { params: z.object({ id: z.string() }) },
        responses: {
          200: { description: "ok", content: { "application/json": { schema: z.object({}) } } },
        },
      });
    const { app } = bootTestApp(tempDataDir(), [
      (api) => {
        api.openapi(route([], "/open/{id}"), (c) => c.json({}, 200));
        api.openapi(route(undefined, "/closed/{id}"), (c) => c.json({}, 200));
      },
    ]);
    expect((await app.request("/api/v1/open/abc")).status).toBe(200);
    expect((await app.request("/api/v1/closed/abc")).status).toBe(401);
  });
});

describe("error scrubbing over HTTP", () => {
  it("shows project-relative paths in problem details and logs", async () => {
    const { vi } = await import("vitest");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ProblemError } = await import("../src/api/problem.js");
    const { app, token } = bootTestApp(tempDataDir(), [
      (api) => {
        api.get("/leak", () => {
          throw new ProblemError(
            "not-found",
            `no file at ${process.cwd()}/.data/x and /Users/me/secret/y`,
          );
        });
        api.get("/boom", () => {
          throw new Error("failed on /Users/me/secret/z");
        });
      },
    ]);
    const headers = { Authorization: `Bearer ${token}` };
    const leak = await (await app.request("/api/v1/leak", { headers })).json();
    expect(leak.detail).toBe("no file at .data/x and <outside project>/y");
    const boom = await app.request("/api/v1/boom", { headers });
    expect(boom.status).toBe(500);
    expect(JSON.stringify(log.mock.calls)).not.toContain("/Users/");
    log.mockRestore();
  });
});

describe("data folder permissions", () => {
  it("creates the data folder private to the owner", () => {
    const dir = join(tempDataDir(), "private");
    bootTestApp(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});
