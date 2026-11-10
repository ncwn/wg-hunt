import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApp, tempDataDir } from "./helpers.js";

const ORIGIN = "http://localhost";
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

type App = ReturnType<typeof bootTestApp>["app"];

async function login(app: App, token: string) {
  const res = await app.request("/api/v1/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ token }),
  });
  expect(res.status).toBe(204);
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

const logout = (app: App, headers: Record<string, string>) =>
  app.request("/api/v1/auth/session", { method: "DELETE", headers });

const check = async (app: App, headers: Record<string, string>) =>
  (await app.request("/api/v1/auth/session", { headers })).status;

const cookieValue = (cookie: string) => cookie.slice(cookie.indexOf("=") + 1);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dashboard sessions", () => {
  it("gives each login its own cookie, and both authenticate", async () => {
    const { app, token } = bootTestApp();
    const a = await login(app, token);
    const b = await login(app, token);
    expect(a).not.toBe(b);
    expect(await check(app, { Cookie: a })).toBe(204);
    expect(await check(app, { Cookie: b })).toBe(204);
  });

  it("ends only the logged-out session on the server", async () => {
    const { app, token } = bootTestApp();
    const a = await login(app, token);
    const b = await login(app, token);
    const out = await logout(app, { Cookie: a, Origin: ORIGIN });
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
    expect(await check(app, { Cookie: a })).toBe(401);
    expect(await check(app, { Cookie: b })).toBe(204);
  });

  it("revokes nothing when the logout is authenticated by Bearer", async () => {
    const { app, token } = bootTestApp();
    const a = await login(app, token);
    expect((await logout(app, bearer(token))).status).toBe(204);
    expect(await check(app, { Cookie: a })).toBe(204);
  });

  it("refuses a cookie value that was never issued", async () => {
    const { app, token } = bootTestApp();
    await login(app, token);
    expect(await check(app, { Cookie: "wg_hunt_session=never-issued" })).toBe(401);
    expect(await check(app, { Cookie: `wg_hunt_session=${"A".repeat(43)}` })).toBe(401);
  });

  it("ends every session on token rotation and renews only the caller's", async () => {
    const { app, token } = bootTestApp();
    const mine = await login(app, token);
    const other = await login(app, token);
    const res = await app.request("/api/v1/auth/token/rotate", {
      method: "POST",
      headers: { Cookie: mine, Origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    const renewed = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(renewed).not.toBe(mine);
    expect(await check(app, { Cookie: renewed })).toBe(204);
    expect(await check(app, { Cookie: mine })).toBe(401);
    expect(await check(app, { Cookie: other })).toBe(401);
  });

  it("keeps sessions working when the token write fails during rotation", async () => {
    const dir = tempDataDir();
    const { app, token } = bootTestApp(dir);
    const cookie = await login(app, token);
    vi.spyOn(console, "error").mockImplementation(() => {});
    chmodSync(dir, 0o500);
    try {
      const res = await app.request("/api/v1/auth/token/rotate", {
        method: "POST",
        headers: bearer(token),
      });
      expect(res.status).toBe(500);
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(await check(app, { Cookie: cookie })).toBe(204);
    expect(await check(app, bearer(token))).toBe(204);
  });

  it("survives a restart on the same data folder and token", async () => {
    const dir = tempDataDir();
    const first = bootTestApp(dir);
    const cookie = await login(first.app, first.token);
    first.close();
    const second = bootTestApp(dir);
    expect(await check(second.app, { Cookie: cookie })).toBe(204);
  });

  it("ends sessions when the token file is replaced and the server restarts", async () => {
    const dir = tempDataDir();
    const first = bootTestApp(dir);
    const cookie = await login(first.app, first.token);
    first.close();
    writeFileSync(join(dir, "access-token"), `${"B".repeat(43)}\n`, { mode: 0o600 });
    const second = bootTestApp(dir);
    expect(second.token).toBe("B".repeat(43));
    expect(await check(second.app, { Cookie: cookie })).toBe(401);
  });

  it("stores no raw session id", async () => {
    const { app, token, db } = bootTestApp();
    const cookies = [await login(app, token), await login(app, token)].map(cookieValue);
    const rows = db.$client.prepare("SELECT * FROM dashboard_sessions").all() as Record<
      string,
      unknown
    >[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      for (const value of Object.values(row)) {
        for (const cookie of cookies) {
          expect(String(value)).not.toContain(cookie);
        }
      }
    }
  });

  it("logs no session id", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    }
    const { app, token } = bootTestApp();
    const cookie = await login(app, token);
    await check(app, { Cookie: cookie });
    await logout(app, { Cookie: cookie, Origin: ORIGIN });
    await check(app, { Cookie: cookie });
    for (const line of lines) expect(line).not.toContain(cookieValue(cookie));
  });
});
