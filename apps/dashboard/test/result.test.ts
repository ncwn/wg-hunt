import { describe, expect, it } from "vitest";
import { createApiClient } from "../src/api/client.js";
import { ask, UNREACHABLE, wordsOf } from "../src/api/result.js";

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/problem+json" },
  });

function answering(response: () => Response | Promise<Response>) {
  const api = createApiClient({
    fetch: async () => response(),
    baseUrl: "http://localhost/api/v1",
  });
  return () => api.GET("/auth/session");
}

describe("ask", () => {
  it("gives the data of a successful answer", async () => {
    const result = await ask(answering(() => json({ authenticated: true }, 200)));
    expect(result).toEqual({ ok: true, data: { authenticated: true } });
  });

  it("keeps the problem's detail, status, type, field errors and body", async () => {
    const problem = {
      type: "offer-merged",
      title: "Merged",
      detail: "That Offer was merged into another.",
      errors: [{ path: "name", message: "Give it a name." }],
      mergedInto: 7,
    };
    const result = await ask(answering(() => json(problem, 404)));
    expect(result).toEqual({
      ok: false,
      message: "That Offer was merged into another.",
      status: 404,
      type: "offer-merged",
      errors: [{ path: "name", message: "Give it a name." }],
      body: problem,
    });
  });

  it("reads the title when the problem has no detail", async () => {
    const result = await ask(answering(() => json({ title: "Not allowed" }, 403)));
    expect(result).toMatchObject({ ok: false, message: "Not allowed", status: 403 });
  });

  it("reads a proxy's HTML error page as the sentence for its status", async () => {
    const result = await ask(
      answering(() => new Response("<html>Bad Gateway</html>", { status: 502 })),
    );
    expect(result).toMatchObject({
      ok: false,
      message: "wg-hunt ran into a problem. Try again in a moment.",
      status: 502,
    });
  });

  it("reads an empty problem as the sentence for its status, else the generic line", async () => {
    expect(await ask(answering(() => json({}, 404)))).toMatchObject({
      message: "That isn't there any more.",
    });
    expect(await ask(answering(() => json({}, 418)))).toMatchObject({
      message: "wg-hunt couldn't do that just now. Try again in a moment.",
    });
  });

  it("says wg-hunt could not be reached when no answer arrived, with no status", async () => {
    const result = await ask(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(result).toEqual({ ok: false, message: UNREACHABLE });
  });

  it("takes an answer without a body as success only when asked to", async () => {
    const empty = () => new Response(null, { status: 204 });
    expect(await ask(answering(empty), { empty: true })).toEqual({ ok: true, data: undefined });
    expect(await ask(answering(empty))).toMatchObject({ ok: false, status: 204 });
  });
});

describe("wordsOf", () => {
  it("takes a title alone for no words", async () => {
    const titled = await ask(answering(() => json({ title: "Internal server error" }, 500)));
    if (titled.ok) throw new Error("expected a failure");
    expect(wordsOf(titled)).toBeUndefined();
  });

  it("gives the server's words, or nothing when the failure carried none", async () => {
    const worded = await ask(answering(() => json({ detail: "Paused for the night." }, 503)));
    const bare = await ask(
      answering(() => new Response("<html>Bad Gateway</html>", { status: 502 })),
    );
    if (worded.ok || bare.ok) throw new Error("expected failures");
    expect(wordsOf(worded)).toBe("Paused for the night.");
    expect(wordsOf(bare)).toBeUndefined();
  });
});
