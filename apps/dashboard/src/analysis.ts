import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { looked, NO_RUN, type RunState, seen } from "./analysis-run.js";
import type { ApiClient } from "./api/client.js";
import { ask, type Result } from "./api/result.js";
import type { components } from "./api/schema.js";
import type { EventStream } from "./events.js";

export type AnalysisStatus = components["schemas"]["AnalysisStatus"];
type AnalysisRun = components["schemas"]["AnalysisRun"];

type AnalysisStatusView =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; analysis: AnalysisStatus };

export const ANALYSIS_RETRY_MS = 15_000;

export type RunProgress = {
  runId: number;
  status: AnalysisRun["status"];
  stopReason: AnalysisRun["stopReason"];
  done: number;
  /** Of `done`, the Offers given a new result; the others failed, were capped or were dropped. */
  applied: number;
  total: number;
};

export type Analysis = {
  view: AnalysisStatusView;
  run: RunState;
  retryRun: () => void;
  dismissRun: () => void;
  refresh: () => void;
  startRun: () => Promise<Result<undefined>>;
};

export function useAnalysis(api: ApiClient, events: EventStream): Analysis {
  const [view, setView] = useState<AnalysisStatusView>({ status: "loading" });
  const [run, setRun] = useState<RunState>(NO_RUN);
  const reload = useRef<() => void>(() => {});
  // Counts snapshots heard. A read begun before the latest one is older than it, so it is not
  // shown, though its run is still looked up.
  const snapshots = useRef(0);

  const read = useCallback(async () => {
    const since = snapshots.current;
    const result = await ask(() => api.GET("/analysis"));
    if (result.ok) {
      if (snapshots.current === since) setView({ status: "ready", analysis: result.data });
      return result.data;
    }
    // A status already read stays on screen; the next event or read brings it up to date.
    setView((now) =>
      now.status === "ready" ? now : { status: "failed", message: result.message },
    );
    return undefined;
  }, [api]);

  // A failed status doesn't wait for an event that may not come: it is asked for again, with the
  // run it names, since a run already going is only picked up by the full load.
  const failed = view.status === "failed";
  useEffect(() => {
    if (!failed) return;
    const timer = setInterval(() => reload.current(), ANALYSIS_RETRY_MS);
    return () => clearInterval(timer);
  }, [failed]);

  const refresh = useCallback(() => {
    setView((now) => (now.status === "failed" ? { status: "loading" } : now));
    reload.current();
  }, []);

  // Counts run announcements. A run's lookup or start answered after one was announced is older
  // than that announcement, and is dropped.
  const heard = useRef(0);

  // The run this page follows, for a reconnect to look up after the connection was down.
  const latestRun = useRef(run);
  latestRun.current = run;
  const latestView = useRef(view);
  latestView.current = view;

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      const since = heard.current;
      void read().then(async (data) => {
        if (cancelled || data === undefined) return;
        // A run going before this page opened is picked up where it is; one this page followed
        // that ended while the connection was down is read for its outcome, since its last
        // announcement was missed.
        const followed = latestRun.current;
        const id =
          data.activeRunId ?? (followed.status === "following" ? followed.runId : undefined);
        if (id === undefined) return;
        const found = await ask(() => api.GET("/analysis/runs/{id}", { params: { path: { id } } }));
        if (cancelled || heard.current !== since) return;
        const lookup = found.ok ? { found: progressOf(found.data) } : { problem: found.message };
        setRun((now) => looked(now, id, data.activeRunId, lookup));
      });
    };
    reload.current = load;
    load();
    const stop = events.subscribe((event) => {
      if (event.type === "analysis-progress") {
        const { awaiting, spentUsd } = event.data;
        setView((now) =>
          now.status === "ready"
            ? {
                status: "ready",
                analysis: {
                  ...now.analysis,
                  awaiting,
                  spend: { ...now.analysis.spend, spentUsd },
                },
              }
            : now,
        );
      } else if (event.type === "analysis-status-changed") {
        const analysis = event.data;
        snapshots.current += 1;
        const followed = latestRun.current;
        const unknownRun =
          analysis.activeRunId !== null &&
          !(followed.status === "following" && followed.runId === analysis.activeRunId);
        // No read has brought its run yet, and the first may still fail after this has made the
        // view ready.
        if (latestView.current.status !== "ready" && unknownRun) reload.current();
        setView({ status: "ready", analysis });
      } else if (event.type === "spend-cap-reached" || event.type === "spend-cap-cleared") {
        // Both carry the whole cap state, so the warning comes and goes with the server's.
        const spend = event.data;
        setView((now) =>
          now.status === "ready" ? { status: "ready", analysis: { ...now.analysis, spend } } : now,
        );
      } else if (event.type === "analysis-run-progress") {
        const { runId, status, stopReason, done, applied, total } = event.data;
        heard.current += 1;
        setRun(seen({ runId, status, stopReason, done, applied, total }));
        setView((now) =>
          now.status === "ready"
            ? {
                status: "ready",
                analysis: {
                  ...now.analysis,
                  activeRunId: status === "running" ? runId : null,
                  spend: { ...now.analysis.spend, spentUsd: event.data.spentUsd },
                },
              }
            : now,
        );
      }
    });
    const stopReconnect = events.onReconnect(load);
    return () => {
      cancelled = true;
      stop();
      stopReconnect();
    };
  }, [api, events, read]);

  const startRun = useCallback(async (): Promise<Result<undefined>> => {
    const since = heard.current;
    const started = await ask(() => api.POST("/analysis/runs"));
    if (!started.ok) return started;
    if (heard.current === since) setRun(seen(progressOf(started.data)));
    return { ok: true, data: undefined };
  }, [api]);

  return {
    view,
    run,
    retryRun: () => reload.current(),
    dismissRun: () => setRun((now) => (now.status === "ended" ? NO_RUN : now)),
    refresh,
    startRun,
  };
}

function progressOf(run: AnalysisRun): RunProgress {
  return {
    runId: run.id,
    status: run.status,
    stopReason: run.stopReason,
    done: run.counts.total - run.counts.pending,
    applied: run.counts.applied,
    total: run.counts.total,
  };
}

export const AnalysisContext = createContext<Analysis>({
  view: { status: "loading" },
  run: NO_RUN,
  retryRun: () => {},
  dismissRun: () => {},
  refresh: () => {},
  startRun: async () => ({ ok: false, message: "Not signed in." }),
});

export const useAnalysisState = () => useContext(AnalysisContext);

export function usd(amount: number): string {
  return `$${amount.toFixed(amount !== 0 && amount < 0.01 ? 4 : 2)}`;
}

/**
 * Core's `DOUBTFUL_REASONS`, in its order, since the dashboard doesn't import core; a test checks
 * they match. The API types a reason as a string, so one this list lacks still reads.
 */
export const DOUBTFUL_REASON_LABELS = {
  quote_not_found: "its quote isn't in the Offer",
  contradicts_field: "it contradicts a structured field",
  keyword_tripwire: "the text has a keyword the model missed",
  model_ambiguous: "the model found the wording ambiguous",
  tiers_disagree: "the two passes disagree",
} as const;

export function doubtfulReasonLabel(reason: string): string {
  return (
    DOUBTFUL_REASON_LABELS[reason as keyof typeof DOUBTFUL_REASON_LABELS] ??
    reason.replaceAll("_", " ")
  );
}
