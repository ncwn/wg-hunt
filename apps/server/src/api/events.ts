import { createRoute, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import type { ServerEvent } from "../events.js";
import type { EndReason } from "../sessions.js";
import type { ApiModule } from "./context.js";
import { problemResponses } from "./problem.js";

/** A comment line now and then keeps proxies and browsers from closing an idle stream. */
export const KEEP_ALIVE_MS = 20_000;

export const MAX_QUEUED_EVENTS = 100;

/** Never published: only a client's queue makes one, so it stays out of `ServerEvents`. */
type EventsMissed = { type: "events-missed"; data: { missed: number } };

export type QueuedEvent = ServerEvent | EventsMissed;

function replaces(newer: ServerEvent, waiting: QueuedEvent): boolean {
  if (newer.type === "crawl-status-changed") return waiting.type === "crawl-status-changed";
  if (newer.type === "analysis-status-changed") return waiting.type === "analysis-status-changed";
  if (newer.type === "analysis-progress") {
    if (waiting.type !== "analysis-progress" || waiting.data.offerId !== newer.data.offerId) {
      return false;
    }
    return newer.data.status?.status !== "reading" || waiting.data.status?.status === "reading";
  }
  return false;
}

export function queueEvent(queue: QueuedEvent[], event: ServerEvent): void {
  for (let i = queue.length - 1; i >= 0; i--) {
    const waiting = queue[i];
    if (waiting !== undefined && replaces(event, waiting)) queue.splice(i, 1);
  }
  queue.push(event);
  if (queue.length <= MAX_QUEUED_EVENTS) return;
  let marker = queue[0]?.type === "events-missed" ? (queue[0] as EventsMissed) : undefined;
  if (marker === undefined) {
    marker = { type: "events-missed", data: { missed: 0 } };
    queue.unshift(marker);
  }
  let i = 1;
  while (queue.length > MAX_QUEUED_EVENTS && i < queue.length) {
    if (queue[i]?.type === "crawl-status-changed") {
      i++;
      continue;
    }
    queue.splice(i, 1);
    marker.data.missed++;
  }
}

const eventsRoute = createRoute({
  method: "get",
  path: "/events",
  tags: ["System"],
  summary: "Live updates as server-sent events",
  description: [
    "Each message has an `event` type and JSON `data`. The stream starts with one `crawl-status-changed` message holding the current status, so a client that (re)connects needs no extra request.",
    "- `crawl-status-changed`: the status changed; the data is the `CrawlStatus` that `GET /crawl` returns. Sent at once after each request and Bot check, when the crawl pauses or resumes, around a wipe, and when the crawl settings are saved; when jobs are queued, once for all queued together and only if they change what the status shows. Whatever else changes it, time alone included (the Berlin day starting again, requests leaving the rolling hour, a job falling due or leaving the queue, a Cooldown, the active hours or the half-budget period ending), is sent when the crawl loop next compares the whole status with the last one sent, which it does at least every 30 s. Keep the latest as the current status; it may equal the one before.",
    "- `bot-check-cooldown`: a Bot check was detected and a Cooldown started; the data is a `BotCheckRecord` plus `cooldownUntil`, `level` and `needsResume`.",
    '- `offer-added`: a new Offer was stored, or split off another ("not the same room"); the data is the `OfferSummary` that `GET /offers` lists. A split-off Offer keeps the marks, band and `createdAt` of the Offer it left, so it is not new to the seeker.',
    '- `offer-merged`: an Offer was merged into another ("same room", or dedupe found a Duplicate); the data is `{offerId, mergedInto}`. Drop `offerId` and read `mergedInto` again; `GET /offers/{offerId}` answers `offer-merged` with the same pointer.',
    "- `offer-band-changed`: an Offer moved to another band; the data is `{offerId, band, previousBand, bandChangedAt}`. Read the Offer again for its reasons.",
    "- `analysis-progress`: an Offer's analysis status changed (`offerId`, `analysisState`, `status` as `analysisStatus` on the Offer) with `awaiting`, the number of Offers that will be read without anyone acting, and `spentUsd`, the month's spend. Sent when a call starts or ends, when a batch takes or settles the Offer's request, when a failure is recorded, when changed words reset the Offer's analysis, and when a page failure ends because the stored page of the Offer's current Ad ID reads again.",
    "- `analysis-run-progress`: a re-analysis run moved on (`runId`, `status`, `stopReason`, `done`, `applied`, `total`) with `spentUsd`, the month's spend.",
    "- `spend-cap-reached`: the spend cap's `state` left `ok` (or moved between `waiting-for-in-flight` and `reached`); the data is the `AnalysisSpend` that `GET /analysis` shows as `spend`. Model calls stop and new Offers stay `pending` until what is in flight settles, the next month (`resetsAt`) or a higher cap; crawling goes on.",
    "- `spend-cap-cleared`: the spend cap's `state` is back to `ok` and model calls go out again; the data is the `AnalysisSpend`.",
    "- `analysis-status-changed`: something every Offer's analysis status depends on changed: the Anthropic key was saved, cleared, refused or accepted again, the spend cap's `state` changed, the analysis settings were saved, or a re-analysis run started or finished. The data is the `AnalysisStatus` that `GET /analysis` returns, sent only when it differs from the last one sent. Keep the latest as the current analysis status, and read the listed Offers and any open Offer again, since their `analysisStatus` may have changed with it.",
    "- `events-missed`: the client fell behind and some events were dropped; the data is `{missed}`, how many. Each client has at most 100 messages waiting, this one included. A newer `crawl-status-changed` or `analysis-status-changed` replaces a waiting one of its type, and a newer `analysis-progress` replaces a waiting one for the same Offer (a `reading` one never replaces a settled one, so the new result is still announced); those are not counted as missed. Past the limit the oldest events go, never the waiting `crawl-status-changed`, and one `events-missed` message waits in their place, ahead of the events that survived. Treat it like a reconnect: read `GET /offers`, `GET /analysis` and any open Offer again.",
    "- `session-ended`: the credential that opened the stream stopped working; the data is `{reason}`, one of `signed-out` (this dashboard session logged out), `token-rotated` (the access token was replaced, which ends every session) or `expired` (the session went unused too long or reached its maximum age, or the token was replaced while the server was down). It is always the last message: the server closes the stream right after it. Reconnecting with the same credential gets 401; a dashboard that rotated the token itself reconnects with its renewed cookie.",
    "The credential is checked again before each message and keep-alive, and a logout or rotation closes the stream at once, so no event reaches a client after its credential ends. These checks do not renew a session: an open stream alone does not keep its session from expiring; other requests do.",
    "Later features add their own event types.",
  ].join("\n"),
  responses: {
    200: {
      description: "An event stream",
      content: { "text/event-stream": { schema: z.string() } },
    },
    ...problemResponses("unauthorized"),
  },
});

export const registerEvents: ApiModule = (api, { crawl, events, sessions }) => {
  // The handler streams, which the typed `openapi()` helper cannot express; it is documented
  // through the registry and routed like any other path (so authentication applies as usual).
  api.openAPIRegistry.registerPath(eventsRoute);
  api.get(eventsRoute.path, (c) =>
    streamSSE(c, async (stream) => {
      const credential = c.get("credential");
      const queue: QueuedEvent[] = [];
      let wake: (() => void) | undefined;
      let open = true;
      let ended: EndReason | undefined;
      const unwatch = sessions.watch(credential, (reason) => {
        ended ??= reason;
        wake?.();
      });
      const unsubscribe = events.subscribe((event) => {
        queueEvent(queue, event);
        wake?.();
      });
      stream.onAbort(() => {
        open = false;
        wake?.();
      });
      const stillValid = () => {
        ended ??= sessions.check(credential);
        return ended === undefined;
      };
      try {
        // Subscribed first, so nothing published from here on is missed.
        await stream.writeSSE({
          event: "crawl-status-changed",
          data: JSON.stringify(crawl.status()),
        });
        while (open) {
          if (ended !== undefined) break;
          const event = queue.shift();
          if (event !== undefined) {
            if (!stillValid()) break;
            await stream.writeSSE({ event: event.type, data: JSON.stringify(event.data) });
            continue;
          }
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, KEEP_ALIVE_MS);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          wake = undefined;
          if (open && queue.length === 0 && ended === undefined && stillValid()) {
            await stream.write(": keep-alive\n\n");
          }
        }
        if (open && ended !== undefined) {
          await stream.writeSSE({
            event: "session-ended",
            data: JSON.stringify({ reason: ended }),
          });
        }
      } finally {
        unwatch();
        unsubscribe();
      }
    }),
  );
};
