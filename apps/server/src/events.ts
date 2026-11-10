import type { Band } from "@wg-hunt/core";
import type { RunStatus, RunStopReason } from "./analysis/run-status.js";
import type { SpendState } from "./analysis/spend.js";
import type { AnalysisStatus } from "./analysis/status.js";
import type { AnalysisOverview } from "./analysis/worker.js";
import type { BotCheckEvent, CrawlStatus } from "./crawl/status.js";
import type { AnalysisState, OfferSummary } from "./offers/offers.js";

/** Each payload is the JSON sent as `data`. */
type ServerEvents = {
  /** The payload is what `GET /crawl` returns; clients keep the last one as their copy. */
  "crawl-status-changed": CrawlStatus;
  "bot-check-cooldown": BotCheckEvent;
  "offer-added": OfferSummary;
  /** `GET /offers/{id}` answers with the same pointer. */
  "offer-merged": { offerId: number; mergedInto: number };
  "offer-band-changed": {
    offerId: number;
    band: Band;
    previousBand: Band;
    bandChangedAt: string;
  };
  "analysis-progress": AnalysisProgress;
  "analysis-run-progress": AnalysisRunProgress;
  /**
   * Also sent when the state moves between its two held states. The payload is `GET /analysis`'s
   * `spend`.
   */
  "spend-cap-reached": SpendState;
  "spend-cap-cleared": SpendState;
  /** The payload is what `GET /analysis` returns; clients keep the last one as their copy. */
  "analysis-status-changed": AnalysisOverview;
};

type AnalysisRunProgress = {
  runId: number;
  status: RunStatus;
  /** Why a `stopped` run stopped; null otherwise. */
  stopReason: RunStopReason | null;
  done: number;
  /** Of `done`, the Offers given a new result. */
  applied: number;
  total: number;
  /** The month's spend so far. */
  spentUsd: number;
};

type AnalysisProgress = {
  offerId: number;
  analysisState: AnalysisState;
  status: AnalysisStatus;
  /** Offers that will be read without anyone acting, as `awaiting` in `GET /analysis`. */
  awaiting: number;
  /** The month's spend so far, in US dollars. */
  spentUsd: number;
};

export type ServerEvent = {
  [K in keyof ServerEvents]: { type: K; data: ServerEvents[K] };
}[keyof ServerEvents];

export type EventBus = {
  publish<K extends keyof ServerEvents>(type: K, data: ServerEvents[K]): void;
  subscribe(listener: (event: ServerEvent) => void): () => void;
};

export function createEventBus(): EventBus {
  const listeners = new Set<(event: ServerEvent) => void>();
  return {
    publish(type, data) {
      const event = { type, data } as ServerEvent;
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          // A broken client must not break crawling.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
