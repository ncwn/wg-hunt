import { type ReactNode, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import type { ApiClient } from "../api/client.js";
import type { EventStream } from "../events.js";
import { emptyNext, type Hunt, useHunt } from "../hunt-status.js";
import { useMutation } from "../mutation.js";
import { BANDS } from "../nav.js";
import { useOfferCounts } from "../offer-counts.js";
import { toOfferRow } from "../offer-rows.js";
import { type BandId, type Sort, setMarks, useOffers } from "../offers.js";
import { markAllSeen, serverNow, useLastSeen } from "../seen.js";
import { Button, IconButton } from "../ui/Button.js";
import { Segmented, SelectPill, Toggle } from "../ui/controls.js";
import { OffersTable } from "../ui/offers.js";
import { SidePanel, useLeaving } from "../ui/SidePanel.js";
import { Notice } from "../ui/status.js";
import { useSuspended } from "../ui/suspended.js";
import { OfferDetail } from "./OfferDetail.js";
import { TopBar } from "./TopBar.js";

/** The band always comes first. */
const SORTS: { value: Sort; label: string }[] = [
  { value: "recency", label: "Best fit" },
  { value: "warm-rent", label: "Cheapest first" },
  { value: "rent-per-sqm", label: "Best value per m²" },
  { value: "size", label: "Biggest first" },
  { value: "available-from", label: "Free soonest" },
  { value: "distance", label: "Closest to work" },
];

type View = "matches" | "near" | "shortlisted" | "all" | "other";

const VIEW_PATH: Record<Exclude<View, "other">, string> = {
  matches: "/offers/match",
  near: "/offers/near-match",
  shortlisted: "/offers/shortlisted",
  all: "/offers/all",
};

const viewOf = (band: BandId | undefined, shortlisted: boolean): View =>
  shortlisted
    ? "shortlisted"
    : band === undefined
      ? "all"
      : band === "match"
        ? "matches"
        : band === "near-match"
          ? "near"
          : "other";

function emptyText(
  band: BandId | undefined,
  hidden: number | undefined,
  shortlisted: boolean,
  hunt: Hunt | null,
): string {
  if (shortlisted) return "Nothing shortlisted yet. Star a room and it waits here.";
  if (band === "match") return emptyNext("No matches yet.", hunt);
  if (band === "near-match") return "No near matches right now.";
  if (band === "warned") return "Nothing is warned about right now.";
  if (band === "hidden") return "Nothing is hidden right now.";
  if (hidden) return `All ${hidden} offers here are hidden. Turn on Show hidden to see them.`;
  return emptyNext("No offers yet.", hunt);
}

/** Marks a card opened from the list, so closing it can step back instead of adding a page. */
type OpenedFrom = { offerFromList?: boolean } | null;

const OVERLAY_QUERY = "(max-width: 1024px)";

const overlaid = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(OVERLAY_QUERY).matches
    : false;

function OfferPanel({
  offerId,
  closing,
  onClose,
  children,
}: {
  offerId: number;
  closing: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  const suspended = useSuspended();
  const latest = useRef({ offerId, onClose, closing, suspended });
  latest.current = { offerId, onClose, closing, suspended };

  useEffect(() => {
    panel.current?.focus({ preventScroll: true });

    function onKey(event: KeyboardEvent) {
      if (latest.current.closing || latest.current.suspended) return;
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        latest.current.onClose();
        return;
      }
      if (event.key !== "Tab" || !panel.current || !overlaid()) return;
      const focusable = Array.from(
        panel.current.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.closest("[hidden]") && getComputedStyle(el).display !== "none");
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!closing) return;
    document
      .querySelector<HTMLElement>(`[data-offer-id="${latest.current.offerId}"] a`)
      ?.focus({ preventScroll: true });
  }, [closing]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new Offer is the reason to scroll
  useEffect(() => {
    panel.current?.querySelector(".offer-panel-body")?.scrollTo?.({ top: 0 });
  }, [offerId]);

  return (
    <>
      <div
        className={closing ? "offer-panel-scrim is-closing" : "offer-panel-scrim"}
        aria-hidden="true"
        onClick={onClose}
      />
      <SidePanel
        ref={panel}
        label="Offer details"
        className="offer-panel"
        closing={closing}
        tabIndex={-1}
      >
        <div className="offer-panel-bar">
          <IconButton
            icon="x"
            label="Close"
            tone="plain"
            className="offer-panel-close"
            onClick={onClose}
          />
        </div>
        <div className="offer-panel-body">{children}</div>
      </SidePanel>
    </>
  );
}

export function OffersPage({
  api,
  events,
  band,
  shortlisted = false,
}: {
  api: ApiClient;
  events: EventStream;
  band?: BandId;
  shortlisted?: boolean;
}) {
  const [sort, setSort] = useState<Sort>("recency");
  const [showHidden, setShowHidden] = useState(false);
  const { state, reload, refresh, loadMore } = useOffers(api, events, {
    band,
    sort,
    showHidden,
    shortlisted,
  });
  const { counts, refresh: refreshCounts } = useOfferCounts();
  const lastSeen = useLastSeen();
  const { hunt } = useHunt();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  // A mark made from the list leaves the card's copy stale; a new revision makes it read the Offer
  // again, in place, so whatever the seeker had open on the card stays open.
  const [revision, setRevision] = useState(0);
  const marking = useMutation(`${band}:${shortlisted}:${sort}:${showHidden}`);
  const asked = Number(params.get("offer"));
  const selected = Number.isInteger(asked) && asked > 0 ? asked : undefined;
  const { shown: panelId, closing } = useLeaving(selected);
  const cardNow = useRef(panelId);
  cardNow.current = panelId;

  /** A card already open for another Offer is swapped, so Back still closes the card. */
  function openCard(id: string | number) {
    if (selected !== undefined && String(id) === String(selected)) {
      closeCard();
      return;
    }
    const fromList = (location.state as OpenedFrom)?.offerFromList === true;
    navigate(
      { search: `?offer=${id}` },
      selected === undefined
        ? { state: { offerFromList: true } }
        : { replace: true, state: { offerFromList: fromList } },
    );
  }

  function closeCard() {
    if ((location.state as OpenedFrom)?.offerFromList) navigate(-1);
    else navigate({ search: "" }, { replace: true });
  }

  const changed = () => {
    void refresh();
    refreshCounts();
  };

  function mark(id: string | number, change: { shortlisted: boolean }) {
    void marking.run(async () => {
      const result = await setMarks(api, Number(id), change);
      if (!result.ok) return result;
      // The card open now, not when the star was clicked: it may have been opened meanwhile, and
      // read the Offer before the star was saved.
      if (Number(id) === cardNow.current) setRevision((n) => n + 1);
      changed();
      return { ok: true, data: undefined };
    });
  }

  const bandCount = (id: BandId) => (counts ? ` ${counts.bands[id]}` : "");
  const bandInfo = BANDS.find((b) => b.id === band);
  const view = viewOf(band, shortlisted);

  return (
    <>
      <TopBar title="Offers">
        <SelectPill
          label="Sort"
          aria-label="Sort"
          value={sort}
          options={SORTS}
          onChange={setSort}
        />
        <Button variant="secondary" onClick={() => void serverNow(api).then(markAllSeen)}>
          Mark all seen
        </Button>
      </TopBar>

      <div className="offers-tools">
        <Segmented<View>
          label="Show"
          value={view}
          onChange={(next) => {
            if (next !== "other") navigate(VIEW_PATH[next]);
          }}
          options={[
            { value: "matches", label: `Matches${bandCount("match")}` },
            { value: "near", label: `Near matches${bandCount("near-match")}` },
            { value: "shortlisted", label: "Shortlisted" },
            { value: "all", label: "All" },
          ]}
        />
        {view === "all" && (
          <span className="offers-hidden">
            <Toggle label="Show hidden" checked={showHidden} onChange={setShowHidden} />
            <span aria-hidden="true">Show hidden</span>
          </span>
        )}
        {view === "other" && bandInfo && (
          <span className="wh-offer-meta">
            {bandInfo.label}
            {bandCount(bandInfo.id)}
          </span>
        )}
      </div>

      <section className="offers-list sheet-scroll" aria-label="Offers">
        {state.status === "loading" && (
          <p role="status" className="offers-quiet">
            Loading offers…
          </p>
        )}
        {state.status === "failed" && (
          <>
            <Notice tone="alarm">Couldn't load the offers. {state.failure.message}</Notice>
            <Button size="sm" onClick={reload}>
              Try again
            </Button>
          </>
        )}
        {marking.state.status === "failed" && (
          <Notice tone="alarm">Couldn't save that. {marking.state.message}</Notice>
        )}
        {state.status === "ready" && (
          <>
            {state.items.length === 0 ? (
              <p className="offers-quiet">
                {emptyText(band, counts?.bands.hidden, shortlisted, hunt)}
              </p>
            ) : (
              <OffersTable
                label="Offers"
                offers={state.items.map((offer) => toOfferRow(offer, { lastSeen }))}
                openId={selected}
                hrefFor={(offer) => `${location.pathname}?offer=${offer.id}`}
                onOpen={(offer) => openCard(offer.id)}
                onShortlist={(offer, on) => mark(offer.id, { shortlisted: on })}
              />
            )}
            {state.more.status === "failed" && (
              <Notice tone="alarm">Couldn't load more offers. {state.more.failure.message}</Notice>
            )}
            {state.nextCursor !== null && (
              <Button onClick={loadMore} disabled={state.more.status === "loading"}>
                {state.more.status === "loading" ? "Loading…" : "Show more"}
              </Button>
            )}
          </>
        )}
      </section>

      {panelId !== undefined && (
        <OfferPanel offerId={panelId} closing={closing} onClose={closeCard}>
          <OfferDetail
            key={panelId}
            api={api}
            id={panelId}
            revision={revision}
            events={events}
            onChanged={changed}
          />
        </OfferPanel>
      )}
    </>
  );
}
