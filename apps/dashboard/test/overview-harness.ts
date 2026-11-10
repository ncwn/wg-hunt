import type { OfferSummary } from "../src/offers.js";
import { fakeServer } from "./fake-server.js";

export function offer(change: Partial<OfferSummary> & { id: number }): OfferSummary {
  return {
    category: "flatshare-room",
    title: `Room ${change.id}`,
    url: `https://www.wg-gesucht.de/${change.id}.html`,
    firstSeenAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastBumpAt: null,
    pageStatus: "active",
    stale: false,
    tracked: true,
    analysisState: "analyzed",
    analysisStatus: { status: "analyzed", next: "none", reason: null, at: null, willRead: false },
    band: "match",
    bandChangedAt: new Date().toISOString(),
    reasons: [],
    chips: [],
    hiddenBecause: null,
    visibility: { hidden: [], actions: { recheck: true, undismiss: false } },
    marks: { dismissed: false, shortlisted: false, contacted: false, scam: null },
    distance: null,
    keyFacts: {
      warmRent: { amount: 600, converted: false },
      size: 15,
      district: "Kreuzberg",
      availableFrom: null,
    },
    ...change,
  } as OfferSummary;
}

const BAND_ORDER = ["match", "near-match", "warned", "hidden"];

function listed(offers: OfferSummary[], query: URLSearchParams): OfferSummary[] {
  const band = query.get("band");
  const shortlisted = query.get("shortlisted") === "true";
  const withHidden = shortlisted || query.get("includeHidden") === "true";
  const since = query.get("since");
  return offers
    .filter((o) => (band ? o.band === band : o.band !== "hidden" || withHidden))
    .filter((o) => !shortlisted || o.marks.shortlisted)
    .filter(
      (o) =>
        since === null ||
        Date.parse(o.createdAt) > Date.parse(since) ||
        Date.parse(o.bandChangedAt) > Date.parse(since),
    )
    .sort((a, b) => BAND_ORDER.indexOf(a.band) - BAND_ORDER.indexOf(b.band));
}

export function serverWithOffers(offers: OfferSummary[], { paged = false } = {}) {
  const base = fakeServer({ signedIn: true });
  const marksSent: { id: number; body: Record<string, unknown> }[] = [];
  const listQueries: URLSearchParams[] = [];
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/api/v1/offers" && request.method === "GET") {
      listQueries.push(url.searchParams);
      const items = listed(offers, url.searchParams);
      if (!paged) return json({ items, nextCursor: null });
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const end = start + Number(url.searchParams.get("limit") ?? 50);
      return json({
        items: items.slice(start, end),
        nextCursor: end < items.length ? String(end) : null,
      });
    }
    if (url.pathname === "/api/v1/offers/counts") {
      const bands = { match: 0, "near-match": 0, warned: 0, hidden: 0 };
      for (const o of offers) bands[o.band]++;
      return json({ bands, new: offers.filter((o) => o.band !== "hidden").length });
    }
    const marks = /\/offers\/(\d+)\/marks$/.exec(url.pathname);
    if (marks && request.method === "PATCH") {
      const id = Number(marks[1]);
      const body = (await request.json()) as Record<string, boolean>;
      marksSent.push({ id, body });
      const found = offers.find((o) => o.id === id);
      if (found) {
        found.marks = { ...found.marks, ...body } as OfferSummary["marks"];
      }
      return json(found);
    }
    return base.fetch(request);
  };
  return { fetch, marksSent, listQueries };
}
