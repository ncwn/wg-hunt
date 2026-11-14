import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "./api/client.js";
import { ask, type Failed, wordsOf } from "./api/result.js";
import type { components } from "./api/schema.js";
import type { CrawlStatus, EventStream } from "./events.js";

export type CrawlRequest = components["schemas"]["CrawlRequest"];
export type JobKind = CrawlStatus["nextJobs"][number]["kind"];

// Typed as a record so that a kind added to the API fails to compile here.
const JOB_LABELS: Record<JobKind, string> = {
  poll: "Poll",
  "new-offer": "New Offer",
  "deeper-page": "Deeper page",
  "stale-confirmation": "Confirmation",
  recheck: "Recheck",
};

export const kindLabel = (kind: JobKind): string => JOB_LABELS[kind];

export type RequestOutcome = CrawlRequest["outcome"];

export type Flag = "bot-check" | "unexpected-page";

// Typed as records so that an outcome added to the API fails to compile here.
const OUTCOME_LABELS: Record<RequestOutcome, string> = {
  pending: "In flight",
  received: "Handling page",
  ok: "OK",
  redirect: "Redirect",
  "http-error": "HTTP error",
  "network-error": "Network error",
  "bot-check": "Bot check",
  "unexpected-page": "Unexpected page",
  "handler-error": "Handling failed",
  interrupted: "Interrupted",
  "handler-interrupted": "Interrupted while handling",
};

const OUTCOME_FLAGS: Record<RequestOutcome, Flag | undefined> = {
  pending: undefined,
  received: undefined,
  ok: undefined,
  redirect: undefined,
  "http-error": undefined,
  "network-error": undefined,
  "bot-check": "bot-check",
  "unexpected-page": "unexpected-page",
  "handler-error": "unexpected-page",
  interrupted: undefined,
  "handler-interrupted": undefined,
};

export const outcomeLabel = (outcome: RequestOutcome): string => OUTCOME_LABELS[outcome];

export function flagOf(request: Pick<CrawlRequest, "outcome" | "marker">): Flag | undefined {
  if (request.marker !== null) return "bot-check";
  return OUTCOME_FLAGS[request.outcome];
}

const logTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** In the active hours' zone, with the day, since the log spans 30 days. */
export function formatLogTime(iso: string): string {
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    logTime.formatToParts(new Date(iso)).find((p) => p.type === type)?.value ?? "";
  return `${part("day")} ${part("month")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

export type RequestLogState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | {
      status: "ready";
      items: CrawlRequest[];
      more: boolean;
      paging: boolean;
      pagingFailed: boolean;
    };

const UNAVAILABLE = "Couldn't load the request log.";

const unavailable = (failed: Failed): RequestLogState => ({
  status: "failed",
  message: wordsOf(failed) ?? UNAVAILABLE,
});

type Page = components["schemas"]["CrawlRequestPage"];

export function useRequestLog(api: ApiClient, events: EventStream) {
  const [state, setState] = useState<RequestLogState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const cursor = useRef<string | null>(null);
  // Counts up whenever the rows are replaced, so an older page asked for before is dropped.
  const generation = useRef(0);
  // Only the newest read of the first page settles: a reconnect starts two.
  const latestFirst = useRef(0);
  const restart = useRef(false);

  const first = useCallback(() => ask(() => api.GET("/crawl/requests")), [api]);

  const replaced = useCallback((page: Page): RequestLogState => {
    generation.current += 1;
    cursor.current = page.nextCursor;
    return {
      status: "ready",
      items: page.items,
      more: page.nextCursor !== null,
      paging: false,
      pagingFailed: false,
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` restarts the read on Try again
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    restart.current = false;
    const turn = ++latestFirst.current;
    first().then((page) => {
      if (cancelled || turn !== latestFirst.current) return;
      setState(page.ok ? replaced(page.data) : unavailable(page));
    });
    const again = () => {
      const turn = ++latestFirst.current;
      void first().then((read) => {
        if (cancelled || turn !== latestFirst.current) return;
        if (!read.ok) {
          setState((current) => (current.status === "loading" ? unavailable(read) : current));
          return;
        }
        const page = read.data;
        const startOver = restart.current;
        restart.current = false;
        setState((current) => {
          if (current.status !== "ready") return replaced(page);
          const fresh = new Set(page.items.map((r) => r.id));
          if (startOver || !current.items.some((r) => fresh.has(r.id))) return replaced(page);
          const items = [...page.items, ...current.items.filter((r) => !fresh.has(r.id))];
          return { ...current, items: items.sort((a, b) => b.id - a.id) };
        });
      });
    };
    const stop = events.subscribe((event) => {
      if (event.type === "crawl-status-changed") again();
    });
    const stopReconnect = events.onReconnect(() => {
      restart.current = true;
      again();
    });
    return () => {
      cancelled = true;
      stop();
      stopReconnect();
    };
  }, [first, events, attempt, replaced]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  const failed = state.status === "failed";
  useEffect(() => (failed ? events.onReconnect(reload) : undefined), [failed, events, reload]);

  const older = useCallback(async () => {
    const at = cursor.current;
    if (at === null) return;
    const asked = generation.current;
    setState((s) => (s.status === "ready" ? { ...s, paging: true, pagingFailed: false } : s));
    const read = await ask(() => api.GET("/crawl/requests", { params: { query: { cursor: at } } }));
    setState((s) => {
      // Judged when applied: a replace queued before this answer may not have run until now.
      if (s.status !== "ready" || asked !== generation.current) return s;
      if (!read.ok) return { ...s, paging: false, pagingFailed: true };
      const page = read.data;
      cursor.current = page.nextCursor;
      const have = new Set(s.items.map((r) => r.id));
      return {
        ...s,
        items: [...s.items, ...page.items.filter((r) => !have.has(r.id))],
        more: page.nextCursor !== null,
        paging: false,
      };
    });
  }, [api]);

  return { state, older, reload };
}
