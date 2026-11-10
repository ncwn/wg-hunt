import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderApiSchema, SCHEMA_PATH } from "../scripts/api-schema.js";
import { createApiClient, watchSession } from "../src/api/client.js";
import { fakeServer } from "./fake-server.js";

describe("typed API client", () => {
  it("matches the server's openapi.json: run `pnpm --filter @wg-hunt/dashboard generate:api` after changing the API", async () => {
    const committed = readFileSync(SCHEMA_PATH, "utf8");
    expect(await renderApiSchema()).toBe(committed);
  });

  it("reports a 401 on a request that needed a session, so the dashboard can sign out", async () => {
    const onLost = vi.fn();
    const api = createApiClient({ fetch: fakeServer().fetch, baseUrl: "http://localhost/api/v1" });
    watchSession(api, onLost);
    const { response } = await api.GET("/auth/session");
    expect(response.status).toBe(401);
    expect(onLost).toHaveBeenCalledOnce();
  });

  it("does not treat a wrong token at login as a lost session", async () => {
    const onLost = vi.fn();
    const api = createApiClient({ fetch: fakeServer().fetch, baseUrl: "http://localhost/api/v1" });
    watchSession(api, onLost);
    const { error } = await api.POST("/auth/session", { body: { token: "wrong" } });
    expect(error).toMatchObject({ type: "invalid-token", status: 401 });
    expect(onLost).not.toHaveBeenCalled();
  });

  it("stops reporting once the listener is removed", async () => {
    const onLost = vi.fn();
    const api = createApiClient({ fetch: fakeServer().fetch, baseUrl: "http://localhost/api/v1" });
    watchSession(api, onLost).stop();
    await api.GET("/auth/session");
    expect(onLost).not.toHaveBeenCalled();
  });

  it("ignores a 401 to a request sent before the latest sign-in answered", async () => {
    const server = fakeServer({ signedIn: false });
    const held: { release?: () => void } = {};
    const letThrough = () => held.release?.();
    const api = createApiClient({
      baseUrl: "http://localhost/api/v1",
      fetch: async (request) => {
        const answer = await server.fetch(request);
        if (request.method === "GET") {
          await new Promise<void>((resolve) => {
            held.release = resolve;
          });
        }
        return answer;
      },
    });
    const onLost = vi.fn();
    watchSession(api, onLost);
    const late = api.GET("/auth/session");
    await vi.waitFor(() => expect(held.release).toBeDefined());
    await api.POST("/auth/session", { body: { token: server.token } });
    letThrough();
    expect((await late).response.status).toBe(401);
    expect(onLost).not.toHaveBeenCalled();

    server.state.signedIn = false;
    held.release = undefined;
    const fresh = api.GET("/auth/session");
    await vi.waitFor(() => expect(held.release).toBeDefined());
    letThrough();
    await fresh;
    expect(onLost).toHaveBeenCalledOnce();
  });

  it("says when every token rotation it sent has its answer", async () => {
    let answer: ((response: Response) => void) | undefined;
    const api = createApiClient({
      baseUrl: "http://localhost/api/v1",
      fetch: (request) =>
        new URL(request.url).pathname.endsWith("/auth/token/rotate")
          ? new Promise((resolve) => (answer = resolve))
          : Promise.resolve(new Response(null, { status: 204 })),
    });
    const watch = watchSession(api, () => {});
    await watch.rotationsSettled();

    const rotation = api.POST("/auth/token/rotate");
    await vi.waitFor(() => expect(answer).toBeDefined());
    let settled = false;
    void watch.rotationsSettled().then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    answer?.(
      new Response(JSON.stringify({ token: "fresh" }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    await rotation;
    await vi.waitFor(() => expect(settled).toBe(true));
  });

  it("sends requests under /api/v1 by default", async () => {
    const seen: string[] = [];
    const api = createApiClient({
      baseUrl: "http://localhost/api/v1",
      fetch: async (request) => {
        seen.push(new URL(request.url).pathname);
        return new Response(null, { status: 204 });
      },
    });
    await api.GET("/auth/session");
    expect(seen).toEqual(["/api/v1/auth/session"]);
  });
});
