import { afterEach, describe, expect, it, vi } from "vitest";
import { bootOffers, MINUTE } from "./offers-harness.js";
import { breakPrune, DAY, type Harness } from "./retention-harness.js";

const iso = (ms: number) => new Date(ms).toISOString();
const NOTHING = { offers: 0, snapshots: 0, unexpectedPages: 0, requests: 0 };

function attempted(h: Harness): boolean {
  try {
    return h.runtime.retention.tick() !== undefined;
  } catch {
    return true;
  }
}

const pruneOf = async (h: Harness) => (await h.json("GET", "/storage")).body.prune;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a prune that throws", () => {
  it("is recorded as failed, with the kind of error and not its words", async () => {
    const h = bootOffers();
    breakPrune(h);
    const startedAt = h.clock.now;

    expect(() => h.runtime.retention.tick()).toThrow();

    expect(await pruneOf(h)).toEqual({
      state: "failing",
      lastAttempt: {
        startedAt: iso(startedAt),
        finishedAt: iso(startedAt),
        deleted: null,
        error: "database-error",
      },
      lastSuccess: null,
      failingSince: iso(startedAt),
      failures: 1,
      nextAttemptAt: iso(startedAt + 15 * MINUTE),
    });
  });

  it("is not tried again before the backoff, which grows with each failure", () => {
    const h = bootOffers();
    breakPrune(h);
    expect(attempted(h)).toBe(true);

    h.clock.now += MINUTE;
    expect(attempted(h)).toBe(false);
    h.clock.now += 14 * MINUTE - 1;
    expect(attempted(h)).toBe(false);
    h.clock.now += 1;
    expect(attempted(h)).toBe(true);

    h.clock.now += 30 * MINUTE - 1;
    expect(attempted(h)).toBe(false);
    h.clock.now += 1;
    expect(attempted(h)).toBe(true);
  });

  it("is tried once a day at most, however long it has failed", () => {
    const h = bootOffers();
    breakPrune(h);
    let attempts = 0;
    for (let minute = 0; minute < 10 * 24 * 60; minute++) {
      if (attempted(h)) attempts++;
      h.clock.now += MINUTE;
    }
    // 15 minutes doubling to 16 hours is seven waits in the first 32 hours; then one a day.
    expect(attempts).toBe(8 + 8);
  });

  it("keeps the backoff when the server restarts", () => {
    const h = bootOffers();
    breakPrune(h);
    expect(attempted(h)).toBe(true);
    h.runtime.close();

    const again = bootOffers({ dataDir: h.dataDir, start: h.clock.now + MINUTE });
    expect(attempted(again)).toBe(false);
    again.clock.now += 14 * MINUTE;
    expect(attempted(again)).toBe(true);
  });

  it("keeps the backoff when the database will not take the record either", async () => {
    const h = bootOffers();
    breakPrune(h);
    h.runtime.db.$client.exec(
      `CREATE TRIGGER full_insert BEFORE INSERT ON settings WHEN NEW.key = 'retention.lastPrune'
         BEGIN SELECT RAISE(ABORT, 'no'); END;
       CREATE TRIGGER full_update BEFORE UPDATE ON settings WHEN NEW.key = 'retention.lastPrune'
         BEGIN SELECT RAISE(ABORT, 'no'); END`,
    );

    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => h.runtime.retention.tick()).toThrow();
    h.clock.now += MINUTE;
    expect(attempted(h)).toBe(false);
    expect((await pruneOf(h)).state).toBe("failing");
    expect(logged.mock.calls).toEqual([
      ["Could not store how the nightly prune went, so it is kept in memory: SqliteError"],
    ]);
  });

  it("is logged once per attempt by the running check, with when it is tried again", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = bootOffers();
    breakPrune(h);
    const minutesPass = (minutes: number) => {
      for (let i = 0; i < minutes; i++) {
        h.clock.now += MINUTE;
        vi.advanceTimersByTime(MINUTE);
      }
    };

    h.runtime.retention.start();
    expect(logged.mock.calls).toEqual([
      [`Nightly prune failed: SqliteError; next attempt ${iso(h.clock.now + 15 * MINUTE)}`],
    ]);
    minutesPass(14);
    expect(logged).toHaveBeenCalledTimes(1);
    minutesPass(1);
    expect(logged).toHaveBeenCalledTimes(2);
  });
});

describe("GET /storage and the prune", () => {
  it("says never before the first attempt", async () => {
    const h = bootOffers();
    const { body } = await h.json("GET", "/storage");
    expect(body.lastPrune).toBeNull();
    expect(body.prune).toEqual({
      state: "never",
      lastAttempt: null,
      lastSuccess: null,
      failingSince: null,
      failures: 0,
      nextAttemptAt: null,
    });
  });

  it("says ok with what the prune deleted and when the next one starts", async () => {
    const h = bootOffers();
    h.runtime.db.$client
      .prepare("INSERT INTO crawl_requests (at, kind, path, outcome) VALUES (?, 'poll', '/', 'ok')")
      .run(h.clock.now - 40 * DAY);
    const startedAt = h.clock.now;
    h.runtime.retention.tick();

    const { body } = await h.json("GET", "/storage");
    const attempt = {
      startedAt: iso(startedAt),
      finishedAt: iso(startedAt),
      deleted: { ...NOTHING, requests: 1 },
      error: null,
    };
    expect(body.lastPrune).toBe(iso(startedAt));
    expect(body.prune).toEqual({
      state: "ok",
      lastAttempt: attempt,
      lastSuccess: attempt,
      failingSince: null,
      failures: 0,
      // 03:00 in Berlin the next morning.
      nextAttemptAt: "2026-11-05T02:00:00.000Z",
    });
  });

  it("says failing with the time it began, and keeps the last prune that worked", async () => {
    const h = bootOffers();
    const worked = h.clock.now;
    h.runtime.retention.tick();
    const { mend } = breakPrune(h);

    h.clock.now = Date.parse("2026-11-05T02:00:00Z");
    const began = h.clock.now;
    expect(attempted(h)).toBe(true);
    h.clock.now += 15 * MINUTE;
    expect(attempted(h)).toBe(true);

    const failing = (await h.json("GET", "/storage")).body;
    expect(failing.lastPrune).toBe(iso(worked));
    expect(failing.prune).toMatchObject({
      state: "failing",
      lastAttempt: { startedAt: iso(began + 15 * MINUTE), deleted: null, error: "database-error" },
      lastSuccess: { startedAt: iso(worked), deleted: NOTHING, error: null },
      failingSince: iso(began),
      failures: 2,
      nextAttemptAt: iso(began + 45 * MINUTE),
    });

    mend();
    h.clock.now += 30 * MINUTE;
    expect(h.runtime.retention.tick()).toEqual({ ...NOTHING, requests: 1 });
    const mended = (await h.json("GET", "/storage")).body;
    expect(mended.lastPrune).toBe(iso(h.clock.now));
    expect(mended.prune).toMatchObject({
      state: "ok",
      lastAttempt: { startedAt: iso(h.clock.now), error: null },
      failingSince: null,
      failures: 0,
      nextAttemptAt: "2026-11-06T02:00:00.000Z",
    });
  });
});
