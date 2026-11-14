import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "./api/client.js";
import { ask, type Failed, type Result } from "./api/result.js";
import type { components, paths } from "./api/schema.js";
import { type EventStream, type OfferSummary, settle } from "./events.js";

export type { OfferSummary };
export type Offer = components["schemas"]["Offer"];
export type OfferFact = components["schemas"]["OfferFact"];
export type ScamSignal = components["schemas"]["ScamSignal"];
export type OfferRetention = components["schemas"]["OfferRetention"];

const PAGE_SIZE = 50;

/** The Offer that holds its room now; the server answers the last of a chain of merges. */
function mergedInto(failed: Failed): number | undefined {
  if (failed.type !== "offer-merged") return undefined;
  const into = (failed.body as { mergedInto?: unknown }).mergedInto;
  return typeof into === "number" ? into : undefined;
}

/** Writes to one Offer go out one after another, so the last answer to land is the newest. */
const writes = new Map<number, { tail: Promise<unknown>; count: number }>();

function inTurn<T>(id: number, write: () => Promise<T>): Promise<T> {
  const entry = writes.get(id) ?? { tail: Promise.resolve(), count: 0 };
  entry.count += 1;
  const next = entry.tail.then(write, write);
  entry.tail = next.catch(() => undefined);
  writes.set(id, entry);
  return next;
}

const writesTo = (id: number) => writes.get(id)?.count ?? 0;

async function readOffer(api: ApiClient, id: number) {
  for (;;) {
    const before = writesTo(id);
    const result = await ask(() => api.GET("/offers/{id}", { params: { path: { id } } }));
    if (writesTo(id) === before) return result;
    await writes.get(id)?.tail;
  }
}

export type OffersState =
  | { status: "loading" }
  | { status: "failed"; failure: Failed }
  | {
      status: "ready";
      items: OfferSummary[];
      nextCursor: string | null;
      more: { status: "idle" } | { status: "loading" } | { status: "failed"; failure: Failed };
    };

export type BandId = components["schemas"]["Band"];
export type Sort = NonNullable<NonNullable<paths["/offers"]["get"]["parameters"]["query"]>["sort"]>;

export type OffersView = {
  band?: BandId | undefined;
  sort: Sort;
  showHidden: boolean;
  shortlisted?: boolean | undefined;
};

const MAX_PAGE_SIZE = 200;
const BAND_ORDER: BandId[] = ["match", "near-match", "warned", "hidden"];
const bandIndex = (band: BandId) => BAND_ORDER.indexOf(band);

const queryOf = (view: OffersView, limit: number, cursor?: string) => ({
  limit,
  sort: view.sort,
  ...(view.shortlisted
    ? { shortlisted: "true" as const }
    : view.band === undefined
      ? { includeHidden: view.showHidden ? ("true" as const) : ("false" as const) }
      : { band: view.band }),
  ...(cursor !== undefined && { cursor }),
});

const inView = (view: OffersView, offer: Pick<OfferSummary, "band" | "marks">) =>
  view.shortlisted
    ? offer.marks.shortlisted
    : view.band === undefined
      ? offer.band !== "hidden" || view.showHidden
      : view.band === offer.band;

const readPage = (api: ApiClient, view: OffersView, limit: number, cursor?: string) =>
  ask(() => api.GET("/offers", { params: { query: queryOf(view, limit, cursor) } }));

async function readRows(
  api: ApiClient,
  view: OffersView,
  rows: number,
): Promise<Result<{ items: OfferSummary[]; nextCursor: string | null }>> {
  const items: OfferSummary[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await readPage(api, view, Math.min(rows - items.length, MAX_PAGE_SIZE), cursor);
    if (!page.ok) return page;
    items.push(...page.data.items);
    if (page.data.nextCursor === null || items.length >= rows) {
      return { ok: true, data: { items, nextCursor: page.data.nextCursor } };
    }
    cursor = page.data.nextCursor;
  }
}

const recencyOf = (offer: OfferSummary) => Date.parse(offer.lastBumpAt ?? offer.firstSeenAt);

/** A split-off Offer keeps its Ad ID's Bumps, so it can land below the Offers bumped since. */
function insertInBand(offer: OfferSummary, items: OfferSummary[]): OfferSummary[] {
  const rest = items.filter((item) => item.id !== offer.id);
  const band = bandIndex(offer.band);
  const at = rest.findIndex(
    (item) =>
      bandIndex(item.band) > band ||
      (bandIndex(item.band) === band && recencyOf(item) <= recencyOf(offer)),
  );
  return at === -1 ? [...rest, offer] : [...rest.slice(0, at), offer, ...rest.slice(at)];
}

export function useOffers(api: ApiClient, events: EventStream, view: OffersView) {
  const [state, setState] = useState<OffersState>({ status: "loading" });
  const latest = useRef(state);
  latest.current = state;
  const shown = useRef(view);
  shown.current = view;
  // Announcements that arrive before the first page does would otherwise be lost.
  const early = useRef<OfferSummary[]>([]);
  // A response for a view the seeker has since left is dropped.
  const generation = useRef(0);

  const { band, sort, showHidden, shortlisted } = view;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the view's parts are the dependencies
  const load = useCallback(async () => {
    const mine = ++generation.current;
    setState({ status: "loading" });
    const page = await readPage(api, shown.current, PAGE_SIZE);
    if (mine !== generation.current) return;
    if (!page.ok) {
      setState({ status: "failed", failure: page });
      return;
    }
    const announced = early.current.filter((offer) => inView(shown.current, offer));
    early.current = [];
    setState({
      status: "ready",
      items: announced.reduce((merged, offer) => insertInBand(offer, merged), page.data.items),
      nextCursor: page.data.nextCursor,
      more: { status: "idle" },
    });
  }, [api, band, sort, showHidden, shortlisted]);

  useEffect(() => {
    void load();
  }, [load]);

  const running = useRef(false);
  const again = useRef(false);
  // Bumped each time "Show more" adds a page or an Offer is announced, so a read begun before
  // either doesn't drop it.
  const appended = useRef(0);
  /** Doesn't blank or shrink the list, so the row the seeker was on stays. */
  const refresh = useCallback(async () => {
    if (latest.current.status !== "ready") return load();
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    try {
      do {
        again.current = false;
        const mine = generation.current;
        const pages = appended.current;
        const shownRows = latest.current.status === "ready" ? latest.current.items.length : 0;
        const read = await readRows(api, shown.current, Math.max(PAGE_SIZE, shownRows));
        // Keep what is shown on a failure or after a change of view; the next try or load settles.
        if (!read.ok || mine !== generation.current) continue;
        if (pages !== appended.current) {
          again.current = true;
          continue;
        }
        setState((now) =>
          now.status === "ready"
            ? {
                status: "ready",
                items: read.data.items,
                nextCursor: read.data.nextCursor,
                more: now.more,
              }
            : now,
        );
      } while (again.current);
    } finally {
      running.current = false;
    }
  }, [api, load]);

  useEffect(() => {
    // Band changes come in bursts; the server's word on the order is read once they settle.
    const later = settle(() => void refresh());
    const stop = events.subscribe((event) => {
      // Every row's analysis status depends on the key, the cap and the settings it carries.
      if (event.type === "analysis-status-changed") {
        later.schedule();
        return;
      }
      if (event.type === "offer-added") {
        const offer = event.data;
        if (!inView(shown.current, offer)) return;
        appended.current += 1;
        setState((now) =>
          now.status === "ready" ? { ...now, items: insertInBand(offer, now.items) } : now,
        );
        if (latest.current.status !== "ready") {
          early.current = [offer, ...early.current.filter((seen) => seen.id !== offer.id)];
        }
        // The default order is the one placed above; any other sort needs the server. A shortlisted
        // Offer is announced only when split off another, whose title the split may have changed,
        // and no event says so.
        if (shown.current.sort !== "recency" || shown.current.shortlisted) later.schedule();
        return;
      }
      if (event.type === "offer-merged") {
        // The one it went into may have changed band or place.
        const { offerId } = event.data;
        setState((now) =>
          now.status === "ready"
            ? { ...now, items: now.items.filter((item) => item.id !== offerId) }
            : now,
        );
        later.schedule();
        return;
      }
      if (event.type === "offer-band-changed") {
        const { offerId, band: moved, bandChangedAt } = event.data;
        setState((now) => {
          if (now.status !== "ready") return now;
          const offer = now.items.find((item) => item.id === offerId);
          if (offer === undefined) return now;
          if (!shown.current.shortlisted && !inView(shown.current, { ...offer, band: moved })) {
            return { ...now, items: now.items.filter((item) => item.id !== offerId) };
          }
          return {
            ...now,
            items: insertInBand({ ...offer, band: moved, bandChangedAt }, now.items),
          };
        });
        // Its place inside the new band, or an Offer that was not loaded, is the server's to say.
        later.schedule();
      }
    });
    return () => {
      later.cancel();
      stop();
    };
  }, [events, refresh]);

  useEffect(() => events.onReconnect(() => void refresh()), [events, refresh]);

  const loadMore = useCallback(async () => {
    const now = latest.current;
    if (now.status !== "ready" || now.nextCursor === null || now.more.status === "loading") return;
    const cursor = now.nextCursor;
    const mine = generation.current;
    // From the state as it is, not this snapshot: an announcement may have changed it meanwhile.
    setState((then) => (then.status === "ready" ? { ...then, more: { status: "loading" } } : then));
    const page = await readPage(api, shown.current, PAGE_SIZE, cursor);
    if (mine !== generation.current) return;
    if (page.ok) appended.current += 1;
    setState((then) => {
      if (then.status !== "ready") return then;
      if (!page.ok) return { ...then, more: { status: "failed", failure: page } };
      const known = new Set(then.items.map((item) => item.id));
      return {
        status: "ready",
        items: [...then.items, ...page.data.items.filter((item) => !known.has(item.id))],
        nextCursor: page.data.nextCursor,
        more: { status: "idle" },
      };
    });
  }, [api]);

  return { state, reload: load, refresh, loadMore };
}

export type OfferState =
  | { status: "loading" }
  | { status: "failed"; failure: Failed }
  | { status: "merged"; into: number }
  | { status: "ready"; offer: Offer };

type Read = Awaited<ReturnType<typeof readOffer>>;

function stateOf(result: Read): OfferState {
  if (result.ok) return { status: "ready", offer: result.data };
  const into = mergedInto(result);
  return into === undefined ? { status: "failed", failure: result } : { status: "merged", into };
}

const shownAfter = (result: Read): OfferState | undefined => {
  const next = stateOf(result);
  return next.status === "failed" ? undefined : next;
};

export const RECHECK_POLL_MS = 3000;

export const recheckPending = (recheck: Offer["recheck"]) =>
  recheck.manual && (recheck.state === "queued" || recheck.state === "in-flight");

export function useOffer(api: ApiClient, id: number | undefined, events?: EventStream) {
  const [state, setState] = useState<OfferState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // A merge is final for an id: a read that left before it was announced doesn't bring the Offer
  // back. The server's merge isn't a write `readOffer` knows to wait for.
  const show = useCallback(
    (next: OfferState) => setState((now) => (now.status === "merged" ? now : next)),
    [],
  );
  // A read of an Offer the pane has since left is dropped, so it can't show the old one.
  const shown = useRef(id);
  shown.current = id;
  // Reads can answer out of order, and a change made elsewhere isn't a write `readOffer` knows to
  // wait for: one begun before the read already shown is dropped.
  const begun = useRef(0);
  const landed = useRef(0);
  const showInOrder = useCallback(
    (ticket: number, next: OfferState) => {
      if (ticket <= landed.current) return;
      landed.current = ticket;
      show(next);
    },
    [show],
  );
  const reread = useCallback(
    async (of: number) => {
      const ticket = ++begun.current;
      const result = await readOffer(api, of);
      const next = shownAfter(result);
      if (next && shown.current === of) showInOrder(ticket, next);
      return result;
    },
    [api, showInOrder],
  );

  useEffect(() => {
    if (id === undefined || events === undefined) return;
    return events.subscribe((event) => {
      if (event.type === "offer-merged" && event.data.offerId === id) {
        setState({ status: "merged", into: event.data.mergedInto });
        return;
      }
      // The event carries the band alone; the chips, marks and Hidden line come only from a read.
      if (event.type === "offer-band-changed" && event.data.offerId === id) {
        void reread(id);
        return;
      }
      if (event.type === "analysis-status-changed") {
        void reread(id);
        return;
      }
      if (event.type !== "analysis-progress" || event.data.offerId !== id) return;
      const analysisStatus = event.data.status;
      // A call that has just started changes only the status, which the event carries.
      if (analysisStatus.status === "reading") {
        setState((now) =>
          now.status === "ready"
            ? { status: "ready", offer: { ...now.offer, analysisStatus } }
            : now,
        );
        return;
      }
      void reread(id);
    });
  }, [id, events, reread]);

  // Whatever changed while the connection was down went unannounced: read it again, without
  // blanking it. A read that failed meanwhile (a lost session, say) gets its answer this way too.
  useEffect(() => {
    if (id === undefined || events === undefined) return;
    return events.onReconnect(() => {
      void reread(id);
    });
  }, [id, events, reread]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` restarts the read on Try again
  useEffect(() => {
    if (id === undefined) return;
    let cancelled = false;
    setState({ status: "loading" });
    const ticket = ++begun.current;
    readOffer(api, id).then((result) => {
      if (cancelled) return;
      showInOrder(ticket, stateOf(result));
    });
    return () => {
      cancelled = true;
    };
  }, [api, id, attempt]);

  /** Without blanking the pane, so a notice shown in it stays. */
  const refresh = useCallback(async () => {
    if (id === undefined) return;
    await reread(id);
  }, [id, reread]);

  // No event says a Recheck finished, so while one the seeker asked for is pending the Offer is
  // read again until its state moves on. Through `readOffer`, so it can't undo a write in flight.
  const pending = state.status === "ready" && recheckPending(state.offer.recheck);
  useEffect(() => {
    if (id === undefined || !pending) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () => {
      timer = setTimeout(async () => {
        const result = await reread(id);
        if (stopped) return;
        if (result.ok ? recheckPending(result.data.recheck) : mergedInto(result) === undefined)
          poll();
      }, RECHECK_POLL_MS);
    };
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id, pending, reread]);

  const replace = useCallback((offer: Offer) => show({ status: "ready", offer }), [show]);

  return { state, retry: useCallback(() => setAttempt((n) => n + 1), []), refresh, replace };
}

/** `scam: "not"` means not a scam. */
export type MarksChange = Partial<Offer["marks"]> & { scam?: "scam" | "not" | "clear" };

export const setMarks = (api: ApiClient, id: number, marks: MarksChange) =>
  inTurn(id, () =>
    ask(() => api.PATCH("/offers/{id}/marks", { params: { path: { id } }, body: marks })),
  );

export const overrideFact = (api: ApiClient, id: number, fact: string, value: unknown) =>
  inTurn(id, () =>
    ask(() =>
      api.PUT("/offers/{id}/facts/{fact}", { params: { path: { id, fact } }, body: { value } }),
    ),
  );

export const revertFact = (api: ApiClient, id: number, fact: string) =>
  inTurn(id, () =>
    ask(() => api.DELETE("/offers/{id}/facts/{fact}", { params: { path: { id, fact } } })),
  );

export const releasePairPins = (api: ApiClient, id: number) =>
  inTurn(id, () =>
    ask(() => api.POST("/offers/{id}/retention/release", { params: { path: { id } } })),
  );

export const reanalyze = (api: ApiClient, id: number) =>
  ask(() => api.POST("/offers/{id}/reanalyze", { params: { path: { id } } }));

type Money = { amount: number; converted: boolean };

function formatRent(rent: Money | null): string {
  if (rent === null) return "unknown";
  return `€${rent.amount.toLocaleString("en", { maximumFractionDigits: 2 })}`;
}

const FACT_LABELS: Record<string, string> = {
  postalCode: "Postal code",
  rentPerSqm: "Rent per m²",
  schufaRequested: "SCHUFA requested",
  petsPresent: "Pets in the flat",
  petsAllowed: "Pets allowed",
  tv: "TV",
  baseRent: "Rent",
  offeredAsWg: "Offered as a WG",
  costsComplete: "Costs complete",
  flatshareSize: "Flatshare size",
  roomSize: "Room size",
  flatSize: "Flat size",
};

export function factLabel(key: string): string {
  const known = FACT_LABELS[key];
  if (known) return known;
  const words = key.replace(/([a-z\d])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const SQUARE_METRE_FACTS = new Set(["roomSize", "flatSize"]);

function formatValue(key: string, value: unknown): string {
  if (value === "unknown") return "unknown";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return SQUARE_METRE_FACTS.has(key) ? `${value} m²` : String(value);
  if (typeof value === "string") return value.replaceAll("_", " ");
  if (Array.isArray(value)) return value.map((item) => formatValue(key, item)).join(", ");
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.amount === "number" && typeof record.converted === "boolean") {
      return `${formatRent(record as Money)} per month${record.converted ? " (converted from a nightly price)" : ""}`;
    }
    return Object.entries(record)
      .map(([name, item]) => `${factLabel(name).toLowerCase()} ${formatValue(name, item)}`)
      .join(", ");
  }
  return String(value);
}

export const formatFactValue = (key: string, fact: OfferFact) => formatValue(key, fact.value);

export function originLabel(origin: OfferFact["origin"]): string {
  return origin === "field" ? "Rules" : origin === "text" ? "Model" : "You";
}
