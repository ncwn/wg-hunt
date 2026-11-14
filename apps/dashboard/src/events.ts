import type { components } from "./api/schema.js";

type Schemas = components["schemas"];

export type CrawlStatus = Schemas["CrawlStatus"];
export type OfferSummary = Schemas["OfferSummary"];
type AnalysisProgress = {
  offerId: number;
  status: OfferSummary["analysisStatus"];
  awaiting: number;
  spentUsd: number;
};
type AnalysisRunProgress = {
  runId: number;
  status: Schemas["AnalysisRun"]["status"];
  stopReason: Schemas["AnalysisRun"]["stopReason"];
  done: number;
  applied: number;
  total: number;
  spentUsd: number;
};
type SpendState = Schemas["AnalysisSpend"];
type MergedEvent = { offerId: number; mergedInto: number };
type BandChangedEvent = {
  offerId: number;
  band: OfferSummary["band"];
  bandChangedAt: string;
};

export type ServerEvent =
  | { type: "crawl-status-changed"; data: CrawlStatus }
  | { type: "offer-added"; data: OfferSummary }
  | { type: "offer-band-changed"; data: BandChangedEvent }
  | { type: "offer-merged"; data: MergedEvent }
  | { type: "analysis-progress"; data: AnalysisProgress }
  | { type: "analysis-run-progress"; data: AnalysisRunProgress }
  | { type: "spend-cap-reached"; data: SpendState }
  | { type: "spend-cap-cleared"; data: SpendState }
  | { type: "analysis-status-changed"; data: Schemas["AnalysisStatus"] };

const EVENT_TYPES: ServerEvent["type"][] = [
  "crawl-status-changed",
  "offer-added",
  "offer-band-changed",
  "offer-merged",
  "analysis-progress",
  "analysis-run-progress",
  "spend-cap-reached",
  "spend-cap-cleared",
  "analysis-status-changed",
];

export type SessionEndReason = "signed-out" | "token-rotated" | "expired";
export type SessionLoss = SessionEndReason | "unauthorized";

/** `EventSource.CLOSED`, which a stand-in may not define. */
const CLOSED = 2;

const SESSION_END_REASONS: readonly string[] = ["signed-out", "token-rotated", "expired"];

/**
 * - `reconnecting`: the browser is reopening a dropped connection; live updates are paused.
 * - `failed`: the browser gave up after an HTTP error (a proxy's 502 during a restart, a 401).
 */
export type StreamState =
  | { status: "closed" }
  | { status: "connecting" }
  | { status: "live" }
  | { status: "reconnecting" }
  | { status: "failed"; retryAt: number }
  | { status: "ended"; reason: SessionLoss };

export type EventStream = {
  subscribe(listener: (event: ServerEvent) => void): () => void;
  /**
   * Also called when the server says this connection fell behind (`events-missed`): whatever was
   * announced in between is lost.
   */
  onReconnect(listener: () => void): () => void;
  state(): StreamState;
  onState(listener: (state: StreamState) => void): () => void;
  onSessionEnded(listener: (reason: SessionEndReason) => void): () => void;
  reopen(): void;
  /** So it doesn't reconnect into 401s. */
  end(reason: SessionLoss): void;
};

export type RetryDelays = { firstMs: number; maxMs: number };
const RETRY_DELAYS: RetryDelays = { firstMs: 5_000, maxMs: 60_000 };

export function createEventSourceStream(
  options: {
    url?: string;
    EventSource?: typeof EventSource | undefined;
    retry?: RetryDelays;
    now?: () => number;
  } = {},
): EventStream {
  const url = options.url ?? "/api/v1/events";
  const Source = "EventSource" in options ? options.EventSource : globalThis.EventSource;
  const retry = options.retry ?? RETRY_DELAYS;
  const now = options.now ?? Date.now;
  const listeners = new Set<(event: ServerEvent) => void>();
  const reconnectListeners = new Set<() => void>();
  const stateListeners = new Set<(state: StreamState) => void>();
  const endedListeners = new Set<(reason: SessionEndReason) => void>();
  let source: EventSource | undefined;
  let current: StreamState = { status: "closed" };
  // Once a connection opened, failed or was ended, events may have gone by since the stores'
  // first reads, so the next open counts as a reconnect.
  let missedSome = false;
  let failures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  function become(next: StreamState) {
    current = next;
    for (const listener of [...stateListeners]) listener(next);
  }

  function shut() {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    source?.close();
    source = undefined;
  }

  function open() {
    if (Source === undefined) return;
    shut();
    const retrying = current.status === "failed" || current.status === "reconnecting";
    const opened = new Source(url);
    source = opened;
    become({ status: retrying ? "reconnecting" : "connecting" });
    const mine = () => source === opened;
    const catchUp = () => {
      for (const listener of [...reconnectListeners]) listener();
    };
    opened.addEventListener("open", () => {
      if (!mine()) return;
      failures = 0;
      become({ status: "live" });
      if (missedSome) catchUp();
      missedSome = true;
    });
    opened.addEventListener("events-missed", () => {
      if (mine()) catchUp();
    });
    opened.addEventListener("error", () => {
      if (!mine()) return;
      missedSome = true;
      // CONNECTING: the browser is reopening it. CLOSED: it gave up after an HTTP error.
      if (opened.readyState !== CLOSED) {
        become({ status: "reconnecting" });
        return;
      }
      shut();
      const wait = Math.min(retry.firstMs * 2 ** failures, retry.maxMs);
      failures += 1;
      become({ status: "failed", retryAt: now() + wait });
      retryTimer = setTimeout(open, wait);
    });
    opened.addEventListener("session-ended", (message) => {
      if (!mine()) return;
      let reason: SessionEndReason = "expired";
      try {
        const data = JSON.parse((message as MessageEvent<string>).data) as { reason?: string };
        if (data.reason && SESSION_END_REASONS.includes(data.reason)) {
          reason = data.reason as SessionEndReason;
        }
      } catch {
        // An unreadable reason still ends the session.
      }
      shut();
      become({ status: "ended", reason });
      for (const listener of [...endedListeners]) listener(reason);
    });
    for (const type of EVENT_TYPES) {
      opened.addEventListener(type, (message) => {
        if (!mine()) return;
        let data: unknown;
        try {
          data = JSON.parse((message as MessageEvent<string>).data);
        } catch {
          return; // A garbled message is dropped; the next status replaces it.
        }
        for (const listener of [...listeners]) listener({ type, data } as ServerEvent);
      });
    }
  }

  return {
    onReconnect(listener) {
      reconnectListeners.add(listener);
      return () => {
        reconnectListeners.delete(listener);
      };
    },
    state: () => current,
    onState(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    onSessionEnded(listener) {
      endedListeners.add(listener);
      return () => {
        endedListeners.delete(listener);
      };
    },
    reopen() {
      if (listeners.size === 0) return;
      failures = 0;
      open();
    },
    end(reason) {
      if (listeners.size === 0 || current.status === "ended") return;
      missedSome = true;
      shut();
      become({ status: "ended", reason });
    },
    subscribe(listener) {
      listeners.add(listener);
      if (source === undefined && current.status === "closed") open();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          shut();
          missedSome = false;
          failures = 0;
          become({ status: "closed" });
        }
      };
    },
  };
}

const SETTLE_MS = 300;

export function settle(run: () => void, ms: number = SETTLE_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule() {
      timer ??= setTimeout(() => {
        timer = undefined;
        run();
      }, ms);
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
