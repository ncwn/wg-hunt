import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "./api/client.js";
import { type Answer, ask, wordsOf } from "./api/result.js";
import type { components } from "./api/schema.js";
import { formatBerlin } from "./crawl-status.js";
import type { EventStream } from "./events.js";
import type { Search } from "./searches.js";

export type Forecast = components["schemas"]["Forecast"];
export type DraftSearch = components["schemas"]["DraftSearch"];

export function dailyLimitLabel(forecast: Forecast): string {
  const { dailyCap, halfBudget } = forecast;
  return halfBudget === null
    ? `Daily limit ${dailyCap}`
    : `Daily limit ${dailyCap}, half of ${halfBudget.fullDailyCap} until ${formatBerlin(halfBudget.until)}`;
}

const REST_MS = 250;

const forecastFieldsOf = (search: Search): DraftSearch => ({
  id: search.id,
  categories: search.categories,
  recencyDays: search.recencyDays,
  enabled: search.enabled,
  pollInterval: search.pollInterval,
});

/** The server forecasts exactly this list and saves nothing. */
export function draftList(all: Search[], draft: DraftSearch, editing?: number): DraftSearch[] {
  const others = all.map(forecastFieldsOf);
  return editing === undefined
    ? [...others, draft]
    : others.map((each) => (each.id === editing ? draft : each));
}

export type ForecastState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; forecast: Forecast };

const UNAVAILABLE = "Couldn't work out the forecast.";

async function forecastOf(call: () => Promise<Answer<Forecast>>): Promise<ForecastState> {
  const result = await ask(call);
  return result.ok
    ? { status: "ready", forecast: result.data }
    : { status: "failed", message: wordsOf(result) ?? UNAVAILABLE };
}

export type ForecastBody = components["schemas"]["ForecastDraft"];

export function useCurrentForecast(api: ApiClient, refresh: unknown = 0, events?: EventStream) {
  const [state, setState] = useState<ForecastState>({ status: "loading" });
  const [round, setRound] = useState(0);
  useEffect(() => events?.onReconnect(() => setRound((n) => n + 1)), [events]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `refresh` and `round` restart the read
  useEffect(() => {
    let cancelled = false;
    forecastOf(() => api.GET("/crawl/forecast")).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [api, refresh, round]);
  const retry = useCallback(() => {
    setState({ status: "loading" });
    setRound((n) => n + 1);
  }, []);
  return { state, retry };
}

/** `refresh` reads an unchanged draft's forecast again too: the caps in force can change without the draft doing so. */
export function useDraftForecast(
  api: ApiClient,
  draft: ForecastBody | undefined,
  refresh: unknown = 0,
) {
  const { state: now } = useCurrentForecast(api, refresh);
  const [drafted, setDrafted] = useState<ForecastState>({ status: "loading" });
  const latest = useRef(0);

  const key = JSON.stringify(draft ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `draft`; `refresh` restarts the read
  useEffect(() => {
    if (draft === undefined) return;
    const turn = ++latest.current;
    const timer = setTimeout(() => {
      forecastOf(() => api.POST("/crawl/forecast", { body: draft })).then((state) => {
        if (latest.current === turn) setDrafted(state);
      });
    }, REST_MS);
    return () => clearTimeout(timer);
  }, [api, key, refresh]);

  return { now, draft: draft === undefined ? undefined : drafted };
}
