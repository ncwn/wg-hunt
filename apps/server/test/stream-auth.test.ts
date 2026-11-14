import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeProviders } from "@wg-hunt/core/analysis/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KEEP_ALIVE_MS } from "../src/api/events.js";
import { type Runtime, startRuntime } from "../src/runtime.js";
import { createSessions, SESSION_IDLE_MS, SESSION_MAX_AGE_MS } from "../src/sessions.js";
import { openAccessToken } from "../src/token.js";
import { tempDataDir } from "./helpers.js";

const ORIGIN = "http://localhost";
const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 10, 9, 8);

const runtimes: Runtime[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const r of runtimes.splice(0)) r.close();
});

function boot(dataDir = tempDataDir(), clock = { now: START }) {
  const runtime = startRuntime(
    { dataDir, port: 0, host: "127.0.0.1" },
    process.cwd(),
    [],
    { fetch: async () => ({ status: 200, body: "" }) },
    () => clock.now,
    undefined,
    fakeProviders(),
  );
  runtimes.push(runtime);
  const request = (path: string, headers: Record<string, string> = {}, method = "GET") =>
    runtime.app.request(`/api/v1${path}`, { method, headers });
  return { runtime, clock, request, dataDir };
}

type Booted = ReturnType<typeof boot>;

async function login({ runtime }: Booted) {
  const res = await runtime.app.request("/api/v1/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ token: runtime.token }),
  });
  expect(res.status).toBe(204);
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Kept before any test fakes the timers, so a read still times out in real time. */
const realSetTimeout = globalThis.setTimeout;

function eventReader(res: Response) {
  expect(res.status).toBe(200);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;
  const reader_ = {
    keepAlives: 0,
    async next(): Promise<{ event: string; data: unknown } | undefined> {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event !== undefined && data !== undefined) return { event, data: JSON.parse(data) };
          if (block.startsWith(":")) reader_.keepAlives++;
          continue;
        }
        if (ended) return undefined;
        const read = await Promise.race([
          reader.read(),
          new Promise<"timeout">((resolve) => realSetTimeout(() => resolve("timeout"), 1_000)),
        ]);
        if (read === "timeout") throw new Error("the stream is still open");
        if (read.done) ended = true;
        else buffer += decoder.decode(read.value, { stream: true });
      }
    },
    async rest() {
      const events: { event: string; data: unknown }[] = [];
      for (let e = await reader_.next(); e !== undefined; e = await reader_.next()) events.push(e);
      return events;
    },
    close: () => reader.cancel(),
  };
  return reader_;
}

const offer = { id: 1, title: "Room", url: "/x" } as never;

describe("an open event stream", () => {
  it("ends when its session signs out, before any later event", async () => {
    const booted = boot();
    const cookie = await login(booted);
    const stream = eventReader(await booted.request("/events", { Cookie: cookie }));
    expect((await stream.next())?.event).toBe("crawl-status-changed");

    const out = await booted.request("/auth/session", { Cookie: cookie, Origin: ORIGIN }, "DELETE");
    expect(out.status).toBe(204);
    booted.runtime.events.publish("offer-added", offer);

    expect(await stream.rest()).toEqual([
      { event: "session-ended", data: { reason: "signed-out" } },
    ]);
    expect((await booted.request("/events", { Cookie: cookie })).status).toBe(401);
  });

  it("keeps running when another session signs out", async () => {
    const booted = boot();
    const mine = await login(booted);
    const other = await login(booted);
    const stream = eventReader(await booted.request("/events", { Cookie: mine }));
    await stream.next();
    await booted.request("/auth/session", { Cookie: other, Origin: ORIGIN }, "DELETE");
    booted.runtime.events.publish("offer-added", offer);
    expect((await stream.next())?.event).toBe("offer-added");
    await stream.close();
  });

  it("opened with token A ends when the token rotates", async () => {
    const booted = boot();
    const tokenA = booted.runtime.token;
    const stream = eventReader(await booted.request("/events", bearer(tokenA)));
    await stream.next();

    const res = await booted.request("/auth/token/rotate", bearer(tokenA), "POST");
    expect(res.status).toBe(200);
    booted.runtime.events.publish("offer-added", offer);

    expect(await stream.rest()).toEqual([
      { event: "session-ended", data: { reason: "token-rotated" } },
    ]);
    expect((await booted.request("/events", bearer(tokenA))).status).toBe(401);
  });

  it("opened with a session cookie ends when the token rotates, even the rotating one's", async () => {
    const booted = boot();
    const mine = await login(booted);
    const other = await login(booted);
    const mineStream = eventReader(await booted.request("/events", { Cookie: mine }));
    const otherStream = eventReader(await booted.request("/events", { Cookie: other }));
    await mineStream.next();
    await otherStream.next();

    const res = await booted.request(
      "/auth/token/rotate",
      { Cookie: mine, Origin: ORIGIN },
      "POST",
    );
    expect(res.status).toBe(200);
    booted.runtime.events.publish("offer-added", offer);

    const ended = [{ event: "session-ended", data: { reason: "token-rotated" } }];
    expect(await mineStream.rest()).toEqual(ended);
    expect(await otherStream.rest()).toEqual(ended);
    const renewed = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const again = eventReader(await booted.request("/events", { Cookie: renewed }));
    expect((await again.next())?.event).toBe("crawl-status-changed");
    await again.close();
  });

  it("ends instead of delivering an event once its session has expired", async () => {
    const booted = boot();
    const cookie = await login(booted);
    const stream = eventReader(await booted.request("/events", { Cookie: cookie }));
    await stream.next();
    booted.clock.now += SESSION_IDLE_MS + 1;
    booted.runtime.events.publish("offer-added", offer);
    expect(await stream.rest()).toEqual([{ event: "session-ended", data: { reason: "expired" } }]);
  });

  it("ends once its session reaches the maximum age, however much it is used", async () => {
    const booted = boot();
    const cookie = await login(booted);
    const stream = eventReader(await booted.request("/events", { Cookie: cookie }));
    await stream.next();
    while (booted.clock.now + DAY < START + SESSION_MAX_AGE_MS) {
      booted.clock.now += DAY;
      expect((await booted.request("/auth/session", { Cookie: cookie })).status).toBe(204);
    }
    booted.clock.now = START + SESSION_MAX_AGE_MS + 1;
    booted.runtime.events.publish("offer-added", offer);
    expect(await stream.rest()).toEqual([{ event: "session-ended", data: { reason: "expired" } }]);
  });

  it("does not keep its own session alive: keep-alives check it without renewing it", async () => {
    const booted = boot();
    const cookie = await login(booted);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stream = eventReader(await booted.request("/events", { Cookie: cookie }));
    expect((await stream.next())?.event).toBe("crawl-status-changed");
    // Read as it comes, so the server's writes don't wait on us.
    const rest = stream.rest();
    for (let day = 0; day <= SESSION_IDLE_MS / DAY; day++) {
      booted.clock.now += DAY;
      await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS);
    }
    vi.useRealTimers();
    expect(await rest).toEqual([{ event: "session-ended", data: { reason: "expired" } }]);
    expect(stream.keepAlives).toBeGreaterThanOrEqual(SESSION_IDLE_MS / DAY - 1);
    expect((await booted.request("/auth/session", { Cookie: cookie })).status).toBe(401);
  });

  it("stays open while its session is used by other requests", async () => {
    const booted = boot();
    const cookie = await login(booted);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stream = eventReader(await booted.request("/events", { Cookie: cookie }));
    await stream.next();
    const next = stream.next();
    for (let day = 0; day <= 2 * (SESSION_IDLE_MS / DAY); day++) {
      booted.clock.now += DAY;
      expect((await booted.request("/auth/session", { Cookie: cookie })).status).toBe(204);
      await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS);
    }
    vi.useRealTimers();
    booted.runtime.events.publish("offer-added", offer);
    expect((await next)?.event).toBe("offer-added");
    expect(stream.keepAlives).toBeGreaterThan(2 * (SESSION_IDLE_MS / DAY) - 1);
    await stream.close();
  });
});

describe("session expiry", () => {
  const check = async (booted: Booted, cookie: string) =>
    (await booted.request("/auth/session", { Cookie: cookie })).status;

  async function useDaily(booted: Booted, cookies: string[], until: number) {
    while (booted.clock.now + DAY < until) {
      booted.clock.now += DAY;
      for (const cookie of cookies) expect(await check(booted, cookie)).toBe(204);
    }
  }

  it("ends a session left unused for the idle period", async () => {
    const booted = boot();
    const cookie = await login(booted);
    booted.clock.now += SESSION_IDLE_MS - 1;
    const fresh = await login(booted);
    booted.clock.now += 2;
    expect(await check(booted, cookie)).toBe(401);
    expect(await check(booted, fresh)).toBe(204);
  });

  it("renews a session each time it is used", async () => {
    const booted = boot();
    const cookie = await login(booted);
    // Three renewals stay inside the maximum age.
    for (let i = 0; i < 3; i++) {
      booted.clock.now += SESSION_IDLE_MS - DAY;
      expect(await check(booted, cookie)).toBe(204);
    }
  });

  it("ends a session used every day at the maximum age after login", async () => {
    const booted = boot();
    const cookie = await login(booted);
    await useDaily(booted, [cookie], START + SESSION_MAX_AGE_MS);
    booted.clock.now = START + SESSION_MAX_AGE_MS - 1;
    expect(await check(booted, cookie)).toBe(204);
    booted.clock.now += 2;
    expect(await check(booted, cookie)).toBe(401);
    const loggedInAgain = booted.clock.now;
    const fresh = await login(booted);
    await useDaily(booted, [fresh], loggedInAgain + SESSION_MAX_AGE_MS);
    booted.clock.now = loggedInAgain + SESSION_MAX_AGE_MS - 1;
    expect(await check(booted, fresh)).toBe(204);
    booted.clock.now += 1;
    expect(await check(booted, fresh)).toBe(401);
  });

  it("keeps Bearer requests working whatever the age of any session", async () => {
    const booted = boot();
    const cookie = await login(booted);
    booted.clock.now += SESSION_MAX_AGE_MS + DAY;
    expect(await check(booted, cookie)).toBe(401);
    const res = await booted.request("/auth/session", bearer(booted.runtime.token));
    expect(res.status).toBe(204);
  });

  it("reports a session past the maximum age as expired without renewing it", async () => {
    const booted = boot();
    const sessions = createSessions({
      db: booted.runtime.db,
      token: openAccessToken(join(booted.dataDir, "access-token")),
      clock: () => booted.clock.now,
    });
    const id = sessions.start();
    const lastUsedAt = () =>
      (
        booted.runtime.db.$client.prepare("SELECT lastUsedAt AS t FROM dashboard_sessions").get() as
          | { t: number }
          | undefined
      )?.t;
    while (booted.clock.now + DAY < START + SESSION_MAX_AGE_MS) {
      booted.clock.now += DAY;
      expect(sessions.isOpen(id)).toBe(true);
    }
    booted.clock.now += DAY / 2;
    const used = lastUsedAt();
    expect(sessions.check({ via: "cookie", id })).toBeUndefined();
    expect(lastUsedAt()).toBe(used);
    booted.clock.now = START + SESSION_MAX_AGE_MS;
    expect(sessions.check({ via: "cookie", id })).toBe("expired");
    expect(sessions.isOpen(id)).toBe(false);
  });

  it("drops rows past the maximum age at the next start", async () => {
    const dir = tempDataDir();
    const clock = { now: START };
    const first = boot(dir, clock);
    const old = await login(first);
    await useDaily(first, [old], START + 60 * DAY);
    const younger = await login(first);
    await useDaily(first, [old, younger], START + SESSION_MAX_AGE_MS);
    first.runtime.close();
    runtimes.splice(runtimes.indexOf(first.runtime), 1);
    clock.now = START + SESSION_MAX_AGE_MS + 1;
    const second = boot(dir, clock);
    const rows = second.runtime.db.$client
      .prepare("SELECT COUNT(*) AS n FROM dashboard_sessions")
      .get() as { n: number };
    expect(rows.n).toBe(1);
    expect(await check(second, younger)).toBe(204);
  });

  it("drops expired rows", async () => {
    const booted = boot();
    await login(booted);
    booted.clock.now += SESSION_IDLE_MS + 1;
    await login(booted);
    const rows = booted.runtime.db.$client
      .prepare("SELECT COUNT(*) AS n FROM dashboard_sessions")
      .get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it("drops the rows of a replaced token at the next start", async () => {
    const dir = tempDataDir();
    const first = boot(dir);
    await login(first);
    await login(first);
    first.runtime.close();
    runtimes.splice(runtimes.indexOf(first.runtime), 1);
    writeFileSync(join(dir, "access-token"), `${"B".repeat(43)}\n`, { mode: 0o600 });
    const second = boot(dir);
    const rows = second.runtime.db.$client
      .prepare("SELECT COUNT(*) AS n FROM dashboard_sessions")
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("keeps the rows of the same token across a restart", async () => {
    const dir = tempDataDir();
    const first = boot(dir);
    const cookie = await login(first);
    first.runtime.close();
    runtimes.splice(runtimes.indexOf(first.runtime), 1);
    const second = boot(dir);
    expect(await check(second, cookie)).toBe(204);
  });
});
