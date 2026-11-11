import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "./api/client.js";
import { ask, type Result } from "./api/result.js";
import type { CrawlStatus, EventStream } from "./events.js";

export type CrawlStatusView =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; crawl: CrawlStatus };

export const CRAWL_RETRY_MS = 15_000;

export function useCrawlStatus(api: ApiClient, events: EventStream) {
  const [view, setView] = useState<CrawlStatusView>({ status: "loading" });
  // Counts statuses heard. A Pause or Resume answered after one is older than it, and the loop
  // only publishes again on a change, so that answer is dropped.
  const heard = useRef(0);

  const read = useCallback(
    () =>
      api
        .GET("/crawl")
        .then(({ data }) => {
          // An event that arrived first is newer than this answer.
          setView((current) =>
            current.status === "ready"
              ? current
              : data
                ? { status: "ready", crawl: data }
                : { status: "unavailable" },
          );
        })
        .catch(() => {
          setView((v) => (v.status === "ready" ? v : { status: "unavailable" }));
        }),
    [api],
  );

  useEffect(() => {
    let cancelled = false;
    void read();
    // The server follows every Bot check with a full status, so the status is all there is to
    // read: whether a break ends by itself, and what the seeker may do, are the server's to say.
    const stop = events.subscribe((event) => {
      if (!cancelled && event.type === "crawl-status-changed") {
        heard.current += 1;
        setView({ status: "ready", crawl: event.data });
      }
    });
    // Every connection starts with the current status, so a reconnect brings it; one that was
    // never read is asked for again as well.
    const stopReconnect = events.onReconnect(() => void read());
    return () => {
      cancelled = true;
      stop();
      stopReconnect();
    };
  }, [read, events]);

  // An unavailable status doesn't wait for an event that may not come: it is asked for again.
  const unavailable = view.status === "unavailable";
  useEffect(() => {
    if (!unavailable) return;
    const timer = setInterval(() => void read(), CRAWL_RETRY_MS);
    return () => clearInterval(timer);
  }, [unavailable, read]);

  const act = useCallback(
    async (path: "/crawl/pause" | "/crawl/resume"): Promise<Result<undefined>> => {
      const since = heard.current;
      const result = await ask(() => api.POST(path));
      if (!result.ok) return result;
      if (heard.current === since) setView({ status: "ready", crawl: result.data });
      return { ok: true, data: undefined };
    },
    [api],
  );

  return {
    view,
    pause: useCallback(() => act("/crawl/pause"), [act]),
    resume: useCallback(() => act("/crawl/resume"), [act]),
  };
}

const berlinTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const berlinWeekdayTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const berlinDay = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

/** In Europe/Berlin, the active hours' zone. */
export function formatBerlin(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const sameDay = berlinDay.format(at) === berlinDay.format(now);
  return (sameDay ? berlinTime : berlinWeekdayTime).format(at).replace(",", "");
}
