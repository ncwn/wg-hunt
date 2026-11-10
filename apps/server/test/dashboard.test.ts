import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bootTestApp, tempDataDir } from "./helpers.js";

const ORIGIN = "http://localhost";

describe("session check", () => {
  it("answers 401 without credentials so the dashboard shows its login screen", async () => {
    const { app } = bootTestApp();
    const res = await app.request("/api/v1/auth/session");
    expect(res.status).toBe(401);
    expect((await res.json()).type).toBe("unauthorized");
  });

  it("answers 204 for a signed-in session cookie", async () => {
    const { app, token } = bootTestApp();
    const login = await app.request("/api/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ token }),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const res = await app.request("/api/v1/auth/session", { headers: { Cookie: cookie } });
    expect(res.status).toBe(204);
  });
});

/** A stand-in for `apps/dashboard/dist`, which `pnpm build` produces. */
function fakeDashboardBuild(): string {
  const dir = tempDataDir();
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>wg-hunt</title>");
  writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log('app')");
  writeFileSync(join(dir, "assets", "big-abc123.js"), "console.log('app');\n".repeat(200));
  writeFileSync(join(dir, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  return dir;
}

describe("compression", () => {
  const boot = () => bootTestApp(tempDataDir(), [], { dashboardDir: fakeDashboardBuild() });

  it("gzips a large API answer for a client that accepts it", async () => {
    const { app, token } = boot();
    const res = await app.request("/api/v1/openapi.json", {
      headers: { Authorization: `Bearer ${token}`, "Accept-Encoding": "gzip, deflate, br" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toContain("Accept-Encoding");
    const body = await new Response(res.body?.pipeThrough(new DecompressionStream("gzip"))).json();
    expect(body.openapi).toBeDefined();
  });

  it("sends it as is to a client that does not", async () => {
    const { app, token } = boot();
    const res = await app.request("/api/v1/openapi.json", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.headers.get("content-encoding")).toBeNull();
    expect((await res.json()).openapi).toBeDefined();
  });

  it("gzips the dashboard's script and keeps its caching", async () => {
    const { app } = boot();
    const res = await app.request("/assets/big-abc123.js", {
      headers: { "Accept-Encoding": "gzip" },
    });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("cache-control")).toContain("immutable");
  });
});

describe("serving the dashboard build", () => {
  const boot = () => bootTestApp(tempDataDir(), [], { dashboardDir: fakeDashboardBuild() });

  it("serves index.html at / without credentials, so the login screen can load", async () => {
    const { app } = boot();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>wg-hunt</title>");
  });

  it("never caches index.html, so a new build is picked up", async () => {
    const { app } = boot();
    const res = await app.request("/");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("serves hashed assets with the right type and long-lived caching", async () => {
    const { app } = boot();
    const res = await app.request("/assets/app-abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(await res.text()).toBe("console.log('app')");
  });

  it("serves other files in the build, such as the favicon", async () => {
    const { app } = boot();
    const res = await app.request("/favicon.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("svg");
  });

  it("falls back to index.html for client-side routes so a reload keeps the page", async () => {
    const { app } = boot();
    for (const path of ["/offers", "/offers/near-match", "/settings"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain("<title>wg-hunt</title>");
    }
  });

  it("answers HEAD like GET without a body", async () => {
    const { app } = boot();
    const res = await app.request("/", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("answers a missing file with a not-found problem rather than index.html", async () => {
    const { app } = boot();
    const res = await app.request("/assets/missing.js");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect((await res.json()).type).toBe("not-found");
  });

  it("keeps unknown API paths as problem+json instead of falling back to index.html", async () => {
    const { app, token } = boot();
    for (const path of ["/api/v1/nothing-here", "/api/other"]) {
      const res = await app.request(path, { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status, path).toBe(404);
      expect((await res.json()).type, path).toBe("not-found");
    }
  });

  it("does not serve files outside the build folder", async () => {
    const { app } = boot();
    for (const path of ["/../index.html", "/%2e%2e/etc/passwd", "/assets/..%2f..%2fsecret"]) {
      const res = await app.request(path);
      expect(res.headers.get("content-type"), path).not.toContain("javascript");
      expect(await res.text(), path).not.toContain("root:");
    }
  });

  it("only answers GET and HEAD", async () => {
    const { app } = boot();
    const res = await app.request("/", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("is not mounted when no build exists, leaving / as a not-found problem", async () => {
    const { app } = bootTestApp(tempDataDir(), [], { dashboardDir: join(tempDataDir(), "nope") });
    const res = await app.request("/");
    expect(res.status).toBe(404);
    expect((await res.json()).type).toBe("not-found");
  });
});
