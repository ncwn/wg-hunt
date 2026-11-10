import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIN_TOKEN_LENGTH } from "../src/token.js";
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
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

const rotate = (app: App, headers: Record<string, string>) =>
  app.request("/api/v1/auth/token/rotate", { method: "POST", headers });

const check = async (app: App, headers: Record<string, string>) =>
  (await app.request("/api/v1/auth/session", { headers })).status;

describe("POST /auth/token/rotate", () => {
  it("returns a new token once and retires the old one", async () => {
    const { app, token } = bootTestApp();
    const res = await rotate(app, bearer(token));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { token: fresh } = await res.json();
    expect(fresh).not.toBe(token);
    expect(fresh.length).toBeGreaterThanOrEqual(MIN_TOKEN_LENGTH);

    expect(await check(app, bearer(token))).toBe(401);
    expect(await check(app, bearer(fresh))).toBe(204);
  });

  it("ends existing dashboard sessions", async () => {
    const { app, token } = bootTestApp();
    const cookie = await login(app, token);
    expect(await check(app, { Cookie: cookie })).toBe(204);

    await rotate(app, bearer(token));
    expect(await check(app, { Cookie: cookie })).toBe(401);
  });

  it("keeps the dashboard that rotated signed in, and lets other sessions lapse", async () => {
    const { app, token } = bootTestApp();
    const mine = await login(app, token);
    const other = await login(app, token);
    const res = await rotate(app, { Cookie: mine, Origin: ORIGIN });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    const renewed = setCookie.split(";")[0] ?? "";
    expect(await check(app, { Cookie: renewed })).toBe(204);
    expect(await check(app, { Cookie: mine })).toBe(401);
    expect(await check(app, { Cookie: other })).toBe(401);
  });

  it("does not set a session cookie when a Bearer token rotated it", async () => {
    const { app, token } = bootTestApp();
    const res = await rotate(app, bearer(token));
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("refuses unauthenticated requests and cookie writes from a foreign Origin", async () => {
    const { app, token } = bootTestApp();
    expect((await rotate(app, {})).status).toBe(401);
    const cookie = await login(app, token);
    const res = await rotate(app, { Cookie: cookie, Origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(await check(app, bearer(token))).toBe(204);
  });

  it("persists the new token, readable only by the owner, across a restart", async () => {
    const dir = tempDataDir();
    const first = bootTestApp(dir);
    const { token: fresh } = await (await rotate(first.app, bearer(first.token))).json();
    const file = join(dir, "access-token");
    expect(readFileSync(file, "utf8").trim()).toBe(fresh);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    first.close();
    expect(bootTestApp(dir).token).toBe(fresh);
  });
});
