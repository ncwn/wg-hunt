import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "./api/client.js";
import { ask, type Failed, type Result } from "./api/result.js";
import type { components } from "./api/schema.js";
import { type EventStream, settle } from "./events.js";

export type Search = components["schemas"]["Search"];
export type NewSearch = components["schemas"]["NewSearch"];
export type SearchChanges = components["schemas"]["SearchChanges"];
type Category = Search["categories"][number];
type RentType = Search["rentTypes"][number];
type Source = Search["source"];

// Typed as records so that a category, rent type or Source added to the API fails to compile here.
const CATEGORY_LABELS: Record<Category, string> = {
  "flatshare-room": "Flatshare room",
  "one-room-flat": "1-room flat",
  flat: "Flat",
  house: "House",
};
const RENT_TYPE_LABELS: Record<RentType, string> = {
  unlimited: "Unlimited",
  limited: "Limited",
  overnight: "Overnight",
};
const SOURCE_LABELS: Record<Source, string> = { "wg-gesucht": "wg-gesucht.de" };

export const CATEGORIES = Object.keys(CATEGORY_LABELS) as Category[];
export const RENT_TYPES = Object.keys(RENT_TYPE_LABELS) as RentType[];
export const categoryLabel = (category: Category) => CATEGORY_LABELS[category];
export const rentTypeLabel = (rentType: RentType) => RENT_TYPE_LABELS[rentType];
export const sourceLabel = (source: Source) => SOURCE_LABELS[source];

const CATEGORY_NOUNS: Record<Category, string> = {
  "flatshare-room": "rooms",
  "one-room-flat": "1-room flats",
  flat: "flats",
  house: "houses",
};

const list = (items: string[]) =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

export function describeSearch(search: Search): string {
  const what = list(search.categories.map((category) => CATEGORY_NOUNS[category]));
  const price = search.priceCeiling === null ? "" : ` up to €\u00a0${search.priceCeiling}`;
  const days = search.recencyDays === 1 ? "day" : `${search.recencyDays} days`;
  const rent =
    search.rentTypes.length === RENT_TYPES.length
      ? ""
      : `, ${list(search.rentTypes.map((type) => rentTypeLabel(type).toLowerCase()))} rent only`;
  const sentence = `${what} in ${search.city}${price}, posted in the last ${days}${rent}`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** 24-hour in every locale. */
export function formatWhen(iso: string, now = new Date()): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  const time = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  if (when.toDateString() === now.toDateString()) return time;
  const day = `${when.getDate()} ${MONTHS[when.getMonth()]}`;
  return when.getFullYear() === now.getFullYear()
    ? `${day} ${time}`
    : `${day} ${when.getFullYear()}`;
}

export function describeSweep(sweep: Search["sweep"], now = new Date()): string | undefined {
  switch (sweep.status) {
    case "idle":
      return undefined;
    case "running":
      return sweep.mode === "backfill" ? "Backfill in progress" : "Sweep in progress";
    case "scheduled": {
      const at = sweep.startAt === null ? "" : ` ${formatWhen(sweep.startAt, now)}`;
      return sweep.mode === "backfill" ? `Backfill queued${at}` : `Next Sweep${at}`;
    }
  }
}

export type Problem = {
  message: string;
  errors: { path: string; message: string }[];
};

export const problemOf = (failed: Failed): Problem => ({
  message: failed.message,
  errors: failed.errors ?? [],
});

export type CrawlNowAnswer = { message: string; nextAt: Search["poll"]["nextAt"] | undefined };

async function loadAll(api: ApiClient): Promise<Result<Search[]>> {
  const items: Search[] = [];
  let cursor: string | undefined;
  do {
    const page = await ask(() =>
      api.GET("/searches", { params: { query: { limit: 200, ...(cursor && { cursor }) } } }),
    );
    if (!page.ok) return page;
    items.push(...page.data.items);
    cursor = page.data.nextCursor ?? undefined;
  } while (cursor);
  return { ok: true, data: items };
}

export type SearchesState =
  | { status: "loading" }
  | { status: "failed"; problem: Problem }
  | { status: "ready"; items: Search[] };

export function useSearches(api: ApiClient, events: EventStream) {
  const [state, setState] = useState<SearchesState>({ status: "loading" });
  const reads = useRef(0);
  // Bumped by every write applied here: a read that began before one may list the Search as it
  // was, so it reads again rather than undo the write.
  const writes = useRef(0);

  const read = useCallback(
    async (quiet: boolean) => {
      const mine = ++reads.current;
      if (!quiet) setState({ status: "loading" });
      let loaded: Result<Search[]>;
      let before: number;
      do {
        before = writes.current;
        loaded = await loadAll(api);
        if (mine !== reads.current) return;
      } while (loaded.ok && before !== writes.current);
      if (loaded.ok) {
        setState({ status: "ready", items: loaded.data });
        return;
      }
      const failed: SearchesState = { status: "failed", problem: problemOf(loaded) };
      setState((current) => (quiet && current.status === "ready" ? current : failed));
    },
    [api],
  );

  const load = useCallback(() => read(false), [read]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const later = settle(() => void read(true));
    const stop = events.subscribe((event) => {
      if (event.type === "crawl-status-changed") later.schedule();
    });
    const stopReconnect = events.onReconnect(() => void read(true));
    return () => {
      later.cancel();
      stop();
      stopReconnect();
    };
  }, [events, read]);

  const change = useCallback((update: (items: Search[]) => Search[]) => {
    writes.current += 1;
    setState((current) =>
      current.status === "ready" ? { status: "ready", items: update(current.items) } : current,
    );
  }, []);

  const create = useCallback(
    async (body: NewSearch) => {
      const result = await ask(() => api.POST("/searches", { body }));
      if (result.ok) change((items) => [...items, result.data]);
      return result;
    },
    [api, change],
  );

  const update = useCallback(
    async (id: number, body: SearchChanges) => {
      const result = await ask(() =>
        api.PATCH("/searches/{id}", { params: { path: { id } }, body }),
      );
      if (result.ok) change((items) => items.map((s) => (s.id === id ? result.data : s)));
      return result;
    },
    [api, change],
  );

  const remove = useCallback(
    async (id: number) => {
      const result = await ask(() => api.DELETE("/searches/{id}", { params: { path: { id } } }), {
        empty: true,
      });
      if (result.ok) change((items) => items.filter((s) => s.id !== id));
      return result;
    },
    [api, change],
  );

  const crawlNow = useCallback(
    async (id: number): Promise<Result<CrawlNowAnswer>> => {
      const result = await ask(() =>
        api.POST("/searches/{id}/crawl-now", { params: { path: { id } } }),
      );
      if (!result.ok) return result;
      const fresh = await ask(() => api.GET("/searches/{id}", { params: { path: { id } } }));
      if (fresh.ok) change((items) => items.map((s) => (s.id === id ? fresh.data : s)));
      return {
        ok: true,
        data: {
          message: result.data.message,
          nextAt: fresh.ok ? fresh.data.poll.nextAt : undefined,
        },
      };
    },
    [api, change],
  );

  return { state, reload: load, create, update, remove, crawlNow };
}
