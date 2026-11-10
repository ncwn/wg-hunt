import { describe, expect, it } from "vitest";
import type { RunProgress } from "../src/analysis.js";
import { looked, NO_RUN, type RunState, seen, shown, unread } from "../src/analysis-run.js";

const progress = (runId: number, change: Partial<RunProgress> = {}): RunProgress => ({
  runId,
  status: "running",
  stopReason: null,
  done: 1,
  applied: 1,
  total: 3,
  ...change,
});

const ended = (runId: number): RunState => seen(progress(runId, { status: "stopped" }));

describe("the re-analysis run a page follows", () => {
  it("follows a running run and holds an ended one's outcome", () => {
    expect(seen(progress(1))).toEqual({ status: "following", runId: 1, progress: progress(1) });
    expect(ended(1)).toEqual({
      status: "ended",
      outcome: progress(1, { status: "stopped" }),
    });
  });

  it("shows a newer active run in place of an older outcome", () => {
    expect(shown(ended(1), 2)).toEqual({ status: "following", runId: 2 });
    expect(shown(NO_RUN, 2)).toEqual({ status: "following", runId: 2 });
  });

  it("keeps an ended run ended when the status read still names it", () => {
    expect(shown(ended(1), 1)).toEqual(ended(1));
    expect(shown(ended(1), null)).toEqual(ended(1));
  });

  it("keeps what it knew of a run whose lookup failed, and nothing of another run", () => {
    expect(unread(seen(progress(1)), 1, "Server down")).toEqual({
      status: "following",
      runId: 1,
      progress: progress(1),
      problem: "Server down",
    });
    expect(unread(ended(1), 2, "Server down")).toEqual({
      status: "following",
      runId: 2,
      problem: "Server down",
    });
  });

  it("never shows an ended run running again", () => {
    expect(looked(ended(1), 1, 1, { found: progress(1) })).toEqual(ended(1));
    expect(looked(ended(1), 1, 1, { problem: "Server down" })).toEqual(ended(1));
    expect(looked(ended(1), 1, null, { problem: "Server down" })).toEqual(ended(1));
    expect(looked(ended(1), 2, 2, { found: progress(2) })).toEqual(seen(progress(2)));
  });

  it("follows no run once the status says none is going and the run couldn't be read", () => {
    expect(looked(seen(progress(1)), 1, null, { problem: "Server down" })).toEqual(NO_RUN);
    expect(looked(seen(progress(1)), 1, 1, { problem: "Server down" })).toEqual(
      unread(seen(progress(1)), 1, "Server down"),
    );
    expect(
      looked(seen(progress(1)), 1, null, { found: progress(1, { status: "succeeded" }) }),
    ).toEqual(seen(progress(1, { status: "succeeded" })));
  });
});
