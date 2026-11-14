import { describe, expect, it } from "vitest";
import { bootTestApp } from "./helpers.js";

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("POST /auth/token/rotate when the session table refuses the write", () => {
  it("either rotates and returns the new token, or leaves the old one working", async () => {
    const runtime = bootTestApp();
    const { app, token, db } = runtime;
    // A dashboard is signed in, so the rotation has a session row to delete.
    await app.request("/api/v1/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({ token }),
    });
    db.$client.exec(
      "CREATE TRIGGER break_sessions BEFORE DELETE ON dashboard_sessions BEGIN SELECT RAISE(ABORT, 'busy'); END",
    );
    const res = await app.request("/api/v1/auth/token/rotate", {
      method: "POST",
      headers: bearer(token),
    });
    const oldStillWorks =
      (await app.request("/api/v1/auth/session", { headers: bearer(token) })).status === 204;
    expect({ status: res.status, oldStillWorks }).toEqual(
      res.status === 200
        ? { status: 200, oldStillWorks: false }
        : { status: res.status, oldStillWorks: true },
    );
  });
});
