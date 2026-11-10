import { describe, expect, it } from "vitest";
import {
  afterAttempt,
  nextAttemptAt,
  type PruneState,
  parsePruneState,
  pruneErrorKind,
  retryDelayMs,
} from "../src/retention/prune-state.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (iso: string) => Date.parse(iso);
const NOTHING = { offers: 0, snapshots: 0, unexpectedPages: 0, requests: 0 };
const NEVER: PruneState = { state: "never" };

describe("the nightly prune's state", () => {
  it("is ok after an attempt that finished, with what it deleted", () => {
    const deleted = { offers: 2, snapshots: 5, unexpectedPages: 1, requests: 40 };
    expect(afterAttempt(NEVER, { startedAt: 10, finishedAt: 12, deleted })).toEqual({
      state: "ok",
      lastSuccess: { startedAt: 10, finishedAt: 12, deleted },
    });
  });

  it("is failing after an attempt that threw, since that attempt", () => {
    expect(afterAttempt(NEVER, { startedAt: 10, finishedAt: 12, error: "disk-full" })).toEqual({
      state: "failing",
      lastFailure: { startedAt: 10, finishedAt: 12, error: "disk-full" },
      failures: 1,
      failingSince: 10,
      lastSuccess: null,
    });
  });

  it("counts failures in a row and keeps when they began and the last success", () => {
    const ok = afterAttempt(NEVER, { startedAt: 10, finishedAt: 12, deleted: NOTHING });
    const once = afterAttempt(ok, { startedAt: 20, finishedAt: 22, error: "disk-full" });
    const twice = afterAttempt(once, { startedAt: 30, finishedAt: 32, error: "database-busy" });
    expect(twice).toEqual({
      state: "failing",
      lastFailure: { startedAt: 30, finishedAt: 32, error: "database-busy" },
      failures: 2,
      failingSince: 20,
      lastSuccess: { startedAt: 10, finishedAt: 12, deleted: NOTHING },
    });
  });

  it("is ok again after a success, with nothing left of the failures", () => {
    const failing = afterAttempt(NEVER, { startedAt: 10, finishedAt: 12, error: "unknown" });
    expect(afterAttempt(failing, { startedAt: 20, finishedAt: 22, deleted: NOTHING })).toEqual({
      state: "ok",
      lastSuccess: { startedAt: 20, finishedAt: 22, deleted: NOTHING },
    });
  });
});

describe("when the next attempt starts", () => {
  it("is at the next check when it never ran", () => {
    expect(nextAttemptAt(NEVER)).toBeUndefined();
  });

  it("is the first 03:00 Berlin after the last success started", () => {
    const ok = (startedAt: number): PruneState => ({
      state: "ok",
      lastSuccess: { startedAt, finishedAt: startedAt, deleted: NOTHING },
    });
    // 03:00 in Berlin is 02:00 UTC in winter.
    expect(nextAttemptAt(ok(at("2026-11-04T09:00:00Z")))).toBe(at("2026-11-05T02:00:00Z"));
    expect(nextAttemptAt(ok(at("2026-11-05T01:59:00Z")))).toBe(at("2026-11-05T02:00:00Z"));
    expect(nextAttemptAt(ok(at("2026-11-05T02:00:00Z")))).toBe(at("2026-11-06T02:00:00Z"));
  });

  it("waits 15 minutes after a failure, twice as long after each further one, up to a day", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 30].map(retryDelayMs)).toEqual([
      15 * MINUTE,
      30 * MINUTE,
      HOUR,
      2 * HOUR,
      4 * HOUR,
      8 * HOUR,
      16 * HOUR,
      24 * HOUR,
      24 * HOUR,
      24 * HOUR,
    ]);
  });

  it("counts the wait from when the failed attempt ended", () => {
    const failing: PruneState = {
      state: "failing",
      lastFailure: { startedAt: 1000, finishedAt: 5000, error: "disk-full" },
      failures: 3,
      failingSince: 10,
      lastSuccess: null,
    };
    expect(nextAttemptAt(failing)).toBe(5000 + HOUR);
  });
});

describe("the stored value", () => {
  it("reads nothing, or something that is no record, as never", () => {
    for (const stored of [undefined, null, 7, "x", [], {}, { at: 1234 }]) {
      expect(parsePruneState(stored)).toEqual(NEVER);
    }
  });

  it("reads back each state as it was stored", () => {
    const ok = afterAttempt(NEVER, { startedAt: 10, finishedAt: 12, deleted: NOTHING });
    const failing = afterAttempt(ok, { startedAt: 20, finishedAt: 22, error: "disk-full" });
    const never = afterAttempt(NEVER, { startedAt: 20, finishedAt: 22, error: "unknown" });
    for (const state of [ok, failing, never]) {
      expect(parsePruneState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    }
  });

  it("reads a failure whose parts are damaged without losing that it failed", () => {
    const stored = {
      state: "failing",
      lastFailure: { startedAt: 20, finishedAt: 22, error: "a-kind-of-a-later-version" },
      failures: "many",
      lastSuccess: { startedAt: 10 },
    };
    expect(parsePruneState(stored)).toEqual({
      state: "failing",
      lastFailure: { startedAt: 20, finishedAt: 22, error: "unknown" },
      failures: 1,
      failingSince: 20,
      lastSuccess: null,
    });
  });

  it("reads counts that are not four numbers as unknown", () => {
    const stored = {
      state: "ok",
      lastSuccess: { startedAt: 10, finishedAt: 12, deleted: { offers: "3" } },
    };
    expect(parsePruneState(stored)).toEqual({
      state: "ok",
      lastSuccess: { startedAt: 10, finishedAt: 12, deleted: null },
    });
  });
});

describe("the kind of error that stopped a prune", () => {
  const coded = (code: string) => Object.assign(new Error("x"), { code });

  it.each([
    ["SQLITE_FULL", "disk-full"],
    ["ENOSPC", "disk-full"],
    ["SQLITE_BUSY", "database-busy"],
    ["SQLITE_BUSY_SNAPSHOT", "database-busy"],
    ["SQLITE_LOCKED", "database-busy"],
    ["SQLITE_IOERR_WRITE", "database-error"],
    ["SQLITE_CORRUPT", "database-error"],
    ["EACCES", "unknown"],
  ])("names %s as %s", (code, kind) => {
    expect(pruneErrorKind(coded(code))).toBe(kind);
  });

  it("names anything else unknown", () => {
    expect(pruneErrorKind(new Error("x"))).toBe("unknown");
    expect(pruneErrorKind("x")).toBe("unknown");
    expect(pruneErrorKind(undefined)).toBe("unknown");
  });
});
