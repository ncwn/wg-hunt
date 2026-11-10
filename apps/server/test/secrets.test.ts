import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSecret } from "../src/secrets.js";
import { bootTestApp, tempDataDir } from "./helpers.js";

const ORIGIN = "http://localhost";
// Made up. The middle is distinctive so a leak of any large part of it is caught.
const KEY = "sk-ant-api03-ZXCVBNMASDFGHJKLQWERTYUIOP0123456789-a1b2";
const MIDDLE = "ZXCVBNMASDFGHJKLQWERTYUIOP";

type App = ReturnType<typeof bootTestApp>["app"];

function client(app: App, token: string) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return {
    get: (path: string) => app.request(`/api/v1${path}`, { headers }),
    put: (path: string, body: unknown) =>
      app.request(`/api/v1${path}`, { method: "PUT", headers, body: JSON.stringify(body) }),
    putRaw: (path: string, body: string) =>
      app.request(`/api/v1${path}`, { method: "PUT", headers, body }),
    del: (path: string) => app.request(`/api/v1${path}`, { method: "DELETE", headers }),
  };
}

describe("secrets", () => {
  it("lists every known secret as unset on a fresh install", async () => {
    const { app, token } = bootTestApp();
    const res = await client(app, token).get("/secrets");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { name: "anthropic", set: false, masked: null, updatedAt: null },
    ]);
  });

  it("sets a secret and then shows only a masked hint and when it was set", async () => {
    const { app, token } = bootTestApp();
    const api = client(app, token);
    const put = await api.put("/secrets/anthropic", { value: KEY });
    expect(put.status).toBe(200);
    const entry = await put.json();
    expect(entry).toEqual({
      name: "anthropic",
      set: true,
      masked: "sk-ant-…a1b2",
      updatedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    });

    expect(await (await api.get("/secrets")).json()).toEqual([entry]);
  });

  it("masks a short value completely", async () => {
    const { app, token } = bootTestApp();
    const api = client(app, token);
    const entry = await (await api.put("/secrets/anthropic", { value: "tiny-secret" })).json();
    expect(entry.masked).toBe("••••");
  });

  it("clears a secret, and clearing an unset one is not an error", async () => {
    const { app, token } = bootTestApp();
    const api = client(app, token);
    await api.put("/secrets/anthropic", { value: KEY });
    expect((await api.del("/secrets/anthropic")).status).toBe(204);
    expect(await (await api.get("/secrets")).json()).toEqual([
      { name: "anthropic", set: false, masked: null, updatedAt: null },
    ]);
    expect((await api.del("/secrets/anthropic")).status).toBe(204);
  });

  it("replaces a secret, trimming surrounding whitespace", async () => {
    const { app, db, token } = bootTestApp();
    const api = client(app, token);
    await api.put("/secrets/anthropic", { value: "sk-ant-first-value-0000" });
    await api.put("/secrets/anthropic", { value: `  ${KEY}\n` });
    expect(readSecret(db, "anthropic")).toBe(KEY);
  });

  it("does not accept names it does not know, or empty and multi-word values", async () => {
    const { app, token } = bootTestApp();
    const api = client(app, token);
    expect((await api.put("/secrets/nope", { value: KEY })).status).toBe(404);
    expect((await api.del("/secrets/nope")).status).toBe(404);
    for (const value of ["", "   ", "two words", "line\nbreak"]) {
      const res = await api.put("/secrets/anthropic", { value });
      expect(res.status, JSON.stringify(value)).toBe(400);
    }
  });

  it("keeps the value in the data folder for the server's own use, across a restart", async () => {
    const dir = tempDataDir();
    const first = bootTestApp(dir);
    await client(first.app, first.token).put("/secrets/anthropic", { value: KEY });
    first.close();

    const second = bootTestApp(dir);
    expect(readSecret(second.db, "anthropic")).toBe(KEY);
    expect(readSecret(bootTestApp().db, "anthropic")).toBeUndefined();
  });

  it("requires authentication", async () => {
    const { app } = bootTestApp();
    for (const [method, path] of [
      ["GET", "/secrets"],
      ["PUT", "/secrets/anthropic"],
      ["DELETE", "/secrets/anthropic"],
    ] as const) {
      const res = await app.request(`/api/v1${path}`, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("refuses a write from a foreign Origin when authenticated by cookie", async () => {
    const { app, token } = bootTestApp();
    const login = await app.request("/api/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ token }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const res = await app.request("/api/v1/secrets/anthropic", {
      method: "PUT",
      headers: {
        Cookie: cookie,
        Origin: "https://evil.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ value: KEY }),
    });
    expect(res.status).toBe(403);
  });
});

describe("a secret value never leaves the server", () => {
  const logged: string[] = [];
  beforeEach(() => {
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => {
        logged.push(args.map(String).join(" "));
      });
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    logged.length = 0;
  });

  it("is absent from every response and log line, errors included", async () => {
    const { app, token } = bootTestApp();
    const api = client(app, token);
    const bodies: string[] = [];
    const keep = async (res: Response) => {
      bodies.push(`${res.status} ${[...res.headers].join(" ")} ${await res.text()}`);
    };

    await keep(await api.put("/secrets/anthropic", { value: KEY }));
    await keep(await api.get("/secrets"));
    await keep(await api.get("/secrets/anthropic")); // no such route
    await keep(await api.get("/settings/analysis"));
    await keep(await api.get("/openapi.json"));
    await keep(await app.request("/api/v1/health"));
    await keep(await api.put("/secrets/unknown-name", { value: KEY }));
    await keep(await api.put("/secrets/anthropic", { value: `${KEY} with spaces` }));
    await keep(await api.put("/secrets/anthropic", { value: KEY, extra: KEY }));
    await keep(await api.putRaw("/secrets/anthropic", `{"value": "${KEY}`)); // malformed JSON
    await keep(await api.put("/secrets/anthropic", { value: [KEY] }));
    await keep(await api.put("/secrets/anthropic", { value: KEY.repeat(40) }));
    await keep(await api.del("/secrets/anthropic"));

    expect(bodies.length).toBeGreaterThan(10);
    for (const text of [...bodies, ...logged]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(MIDDLE);
    }
  });
});
