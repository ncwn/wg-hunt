import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "./api/client.js";
import { ask, type Failed, type Result, wordsOf } from "./api/result.js";
import { type EventStream, settle } from "./events.js";
import { type MarksChange, type OfferSummary, setMarks } from "./offers.js";
import { isNewOffer } from "./seen.js";

const PAGE = 200;

/** Read straight from the server's filters rather than the whole list. */
export type OverviewOffers =
  | { status: "loading" }
  | { status: "failed"; why?: string }
  | {
      status: "ready";
      /** Every Match: the rent chart works from all of them. */
      matches: OfferSummary[];
      near: OfferSummary[];
      shortlist: OfferSummary[];
    };

type Query = { band?: "match" | "near-match"; since?: string; shortlisted?: "true" };

async function readAll(api: ApiClient, query: Query): Promise<Result<OfferSummary[]>> {
  const items: OfferSummary[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await ask(() =>
      api.GET("/offers", {
        params: { query: { ...query, limit: PAGE, ...(cursor ? { cursor } : {}) } },
      }),
    );
    if (!page.ok) return page;
    items.push(...page.data.items);
    cursor = page.data.nextCursor ?? undefined;
    // A cursor handed out twice would never end the list; stop rather than go round.
    if (cursor !== undefined && seen.has(cursor)) break;
    if (cursor !== undefined) seen.add(cursor);
  } while (cursor !== undefined);
  return { ok: true, data: items };
}

const first = (offer: OfferSummary, items: OfferSummary[]) => [
  offer,
  ...items.filter((item) => item.id !== offer.id),
];

export function useOverviewOffers(api: ApiClient, events: EventStream, lastSeen: number | null) {
  const [state, setState] = useState<OverviewOffers>({ status: "loading" });
  const running = useRef(false);
  const again = useRef(false);
  const stopped = useRef(false);
  // Each round reads with the latest time, so a read begun before "Mark all seen" is followed by one.
  const since = useRef(lastSeen);
  since.current = lastSeen;

  const read = useCallback(async () => {
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    try {
      do {
        again.current = false;
        const from = since.current;
        const [matches, near, shortlist] = await Promise.all([
          readAll(api, { band: "match" }),
          readAll(api, {
            band: "near-match",
            ...(from === null ? {} : { since: new Date(from).toISOString() }),
          }),
          readAll(api, { shortlisted: "true" }),
        ]);
        if (stopped.current) continue;
        if (matches.ok && near.ok && shortlist.ok) {
          setState({
            status: "ready",
            matches: matches.data,
            near: near.data,
            shortlist: shortlist.data,
          });
          continue;
        }
        const failed = [matches, near, shortlist].find((read): read is Failed => !read.ok);
        const why = failed && wordsOf(failed);
        // Keep what is on show; only a first read that fails is reported.
        setState((now) =>
          now.status === "ready" ? now : why ? { status: "failed", why } : { status: "failed" },
        );
      } while (again.current && !stopped.current);
    } finally {
      running.current = false;
    }
  }, [api]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new "Mark all seen" time is a reason to read
  useEffect(() => {
    void read();
  }, [read, lastSeen]);

  useEffect(() => {
    stopped.current = false;
    const later = settle(() => void read());
    const stop = events.subscribe((event) => {
      if (event.type === "offer-band-changed" || event.type === "offer-merged") later.schedule();
      if (event.type !== "offer-added") return;
      // A read under way may have listed before this Offer was stored, and would put back a list
      // without it: read once more after it instead.
      if (running.current) {
        again.current = true;
        return;
      }
      const offer = event.data;
      setState((now) => {
        if (now.status !== "ready") return now;
        // A split-off Offer comes with the marks of the one it left, the star among them, and the
        // band it had: no band change follows to read the shortlist again.
        const shortlist = offer.marks.shortlisted ? first(offer, now.shortlist) : now.shortlist;
        if (offer.band === "match")
          return { ...now, shortlist, matches: first(offer, now.matches) };
        if (offer.band === "near-match" && isNewOffer(offer, since.current))
          return { ...now, shortlist, near: first(offer, now.near) };
        return { ...now, shortlist };
      });
    });
    const stopReconnect = events.onReconnect(() => void read());
    return () => {
      stopped.current = true;
      later.cancel();
      stop();
      stopReconnect();
    };
  }, [events, read]);

  const mark = useCallback(
    async (id: number, change: MarksChange): Promise<Result<undefined>> => {
      const result = await setMarks(api, id, change);
      if (!result.ok) return result;
      void read();
      return { ok: true, data: undefined };
    },
    [api, read],
  );

  const refresh = useCallback(() => {
    setState((now) => (now.status === "failed" ? { status: "loading" } : now));
    void read();
  }, [read]);

  return { state, mark, refresh };
}
