import { type ReactNode, useEffect } from "react";
import { Link, useLocation } from "react-router";
import { analysisNeedsYou, analysisNote } from "../analysis-status.js";
import type { ApiClient } from "../api/client.js";
import type { EventStream } from "../events.js";
import { toCardOffer } from "../offer-card.js";
import { type Offer, useOffer } from "../offers.js";
import { offerRentSeries } from "../rent-series.js";
import { Button } from "../ui/Button.js";
import { OfferCard } from "../ui/OfferCard.js";
import { RentChart } from "../ui/RentChart.js";
import { Disclosure, Notice } from "../ui/status.js";
import { FactsTable } from "./FactsTable.js";
import { dealbreakers, hiddenLines } from "./hidden-because.js";
import { DetailActions, MarkFailure, useMarker } from "./OfferActions.js";
import { OfferChips } from "./OfferChips.js";
import { RetentionPanel } from "./RetentionPanel.js";
import { ScamPanel } from "./ScamPanel.js";

function Fold({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="od-fold" aria-label={title}>
      <Disclosure title={title}>
        <div className="od-section">{children}</div>
      </Disclosure>
    </section>
  );
}

function Notes({ offer }: { offer: Offer }) {
  // Every cause the server gives, each with what ends it; a deactivated or deleted page is one.
  const lines = hiddenLines(offer);
  const failed = dealbreakers(offer);
  if (failed.length > 0) lines.push(`Hidden by a dealbreaker: ${failed.join(", ")}.`);
  const reading = analysisNote(offer.analysisStatus);
  if (reading !== null) lines.push(reading);
  if (lines.length === 0) return null;
  const gone = offer.pageStatus !== "active";
  const tone = analysisNeedsYou(offer.analysisStatus) || gone ? "warn" : "info";
  return <Notice tone={tone}>{lines.join(" ")}</Notice>;
}

function RentHistory({ offer }: { offer: Offer }) {
  const series = offerRentSeries(offer.priceHistory);
  if (!series) return null;
  return (
    <RentChart
      compact
      title="Rent history"
      points={series.points}
      labels={series.labels}
      change={series.change}
    />
  );
}

function Loaded({
  api,
  offer,
  onMarked,
  onRecheck,
}: {
  api: ApiClient;
  offer: Offer;
  onMarked: (offer: Offer) => void;
  onRecheck: () => void;
}) {
  const { busy, failure, mark } = useMarker(api, offer, onMarked);
  const likely = offer.scam.likelyScam;
  return (
    <div className="od-page">
      <OfferCard
        offer={toCardOffer(offer)}
        busy={busy}
        onShortlist={(on) => mark({ shortlisted: on })}
        onContacted={(on) => mark({ contacted: on })}
        onDismiss={(on) => mark({ dismissed: on })}
        notes={<Notes offer={offer} />}
        scam={likely ? <ScamPanel api={api} offer={offer} onMarked={onMarked} /> : undefined}
        history={<RentHistory offer={offer} />}
        fit={<OfferChips offer={offer} />}
      >
        <MarkFailure message={failure} />
        <DetailActions api={api} offer={offer} onRecheck={onRecheck} />
        <div className="od-folds">
          {!likely && (
            <Fold title="Scam check">
              <ScamPanel api={api} offer={offer} onMarked={onMarked} />
            </Fold>
          )}
          <Fold title="Facts">
            <FactsTable api={api} offer={offer} onChanged={onMarked} />
          </Fold>
          <Fold title="Retention">
            <RetentionPanel api={api} offer={offer} onChanged={onMarked} />
          </Fold>
        </div>
      </OfferCard>
    </div>
  );
}

/** The link opens it as a card click would, in place of this one, so Back and Close still go where they went. */
function Merged({ api, into }: { api: ApiClient; into: number }) {
  const { state } = useOffer(api, into);
  const location = useLocation();
  const name = state.status === "ready" ? state.offer.title : `Offer ${into}`;
  return (
    <div className="od-stack">
      <Notice tone="info">
        This offer was merged into another one for the same room:{" "}
        <Link to={{ search: `?offer=${into}` }} replace state={location.state}>
          {name}
        </Link>
        .
      </Notice>
    </div>
  );
}

/** A new `revision` says the Offer changed elsewhere (a star in the list). */
export function OfferDetail({
  api,
  id,
  events,
  onChanged,
  revision = 0,
}: {
  api: ApiClient;
  id: number;
  events?: EventStream;
  onChanged?: () => void;
  revision?: number;
}) {
  const { state, retry, refresh, replace } = useOffer(api, id, events);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new revision asks for a read
  useEffect(() => {
    if (revision > 0) void refresh();
  }, [revision]);

  if (state.status === "loading")
    return (
      <p role="status" className="od-muted">
        Loading…
      </p>
    );
  if (state.status === "merged") return <Merged api={api} into={state.into} />;
  if (state.status === "failed")
    return (
      <div className="od-stack">
        <Notice tone="alarm">
          {state.failure.status === 404
            ? "That offer isn't known. It may have been removed."
            : `Couldn't load this offer. ${state.failure.message}`}
        </Notice>
        {state.failure.status !== 404 && (
          <div className="od-actions">
            <Button size="sm" variant="secondary" onClick={retry}>
              Try again
            </Button>
          </div>
        )}
      </div>
    );
  const marked = (offer: Offer) => {
    replace(offer);
    onChanged?.();
  };
  return (
    <Loaded api={api} offer={state.offer} onMarked={marked} onRecheck={() => void refresh()} />
  );
}
