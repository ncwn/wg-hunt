import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { ApiClient } from "../api/client.js";
import type { Result } from "../api/result.js";
import type { EventStream } from "../events.js";
import { emptyNext, useHunt } from "../hunt-status.js";
import { useMutation } from "../mutation.js";
import { useOfferCounts } from "../offer-counts.js";
import { toOfferRow } from "../offer-rows.js";
import { type OverviewOffers, useOverviewOffers } from "../overview-offers.js";
import { RANGES, type Range, rentSeries } from "../rent-series.js";
import { useLastSeen } from "../seen.js";
import { Button } from "../ui/Button.js";
import { type OfferRowData, OffersTable } from "../ui/offers.js";
import { RentChart } from "../ui/RentChart.js";
import { StatCard } from "../ui/StatCard.js";
import { StatusCard } from "../ui/StatusCard.js";
import { Notice } from "../ui/status.js";
import { TopBar } from "./TopBar.js";

const NEW_ROWS = 50;

const rooms = (n: number) => `${n} new ${n === 1 ? "room" : "rooms"}`;

export function OverviewPage({ api, events }: { api: ApiClient; events: EventStream }) {
  const navigate = useNavigate();
  const lastSeen = useLastSeen();
  const { status: counting, counts, refresh: refreshCounts } = useOfferCounts();
  const { state, mark, refresh } = useOverviewOffers(api, events, lastSeen);
  const [range, setRange] = useState<Range>("7D");
  const marking = useMutation();
  const ready = state.status === "ready" ? state : null;

  const series = useMemo(
    () => (ready ? rentSeries(ready.matches, range) : { points: [], slots: 0 }),
    [ready, range],
  );
  const fresh = useMemo(
    () =>
      ready
        ? [...ready.matches, ...ready.near]
            .map((offer) => toOfferRow(offer, { lastSeen }))
            .filter((row) => row.isNew)
        : [],
    [ready, lastSeen],
  );
  const newMatches = fresh.filter((row) => row.band === "match").length;
  const newNear = fresh.length - newMatches;
  const shortlisted = ready?.shortlist;
  const contacted = shortlisted?.filter((o) => o.marks.contacted).length;
  // Until the lists or the counts are read, a figure would be a guess: "–" rather than 0.
  const matches = counts?.bands.match ?? ready?.matches.length;
  // Only the new Near matches are read here, so their number waits for the counts rather than
  // showing one figure and then another.
  const near = counts?.bands["near-match"];
  const hasRooms = (matches ?? 0) + (near ?? newNear) > 0 || fresh.length > 0;

  async function act(change: () => Promise<Result<undefined>>) {
    await marking.run(change);
    refreshCounts();
  }

  const newCount = counts?.new;
  const subtitle =
    newCount === undefined
      ? undefined
      : newCount === 0
        ? "Nothing new since you last looked"
        : `${rooms(newCount)} since you last looked`;

  return (
    <>
      <TopBar title="Overview" subtitle={subtitle} />
      {(state.status === "failed" || counting === "failed") && (
        <div className="ov-problem">
          {state.status === "failed" && state.why ? (
            <Notice tone="warn" title="Couldn't read your offers" defaultOpen>
              {state.why}
            </Notice>
          ) : (
            <Notice tone="warn">
              {state.status === "failed"
                ? "Couldn't read your offers"
                : "Couldn't count your offers"}
            </Notice>
          )}
          <Button
            size="sm"
            onClick={() => {
              refresh();
              refreshCounts();
            }}
          >
            Try again
          </Button>
        </div>
      )}
      {/* In phone order: is it hunting, the rent, the counts, then what's new. */}
      <div className="ov">
        <div className="ov-status">
          <HuntCard />
        </div>
        <section className="ov-rent" aria-labelledby="ov-rent">
          <div className="ov-sec-row">
            <h2 className="ov-sec" id="ov-rent">
              Typical rent of your matches
            </h2>
          </div>
          <RentChart
            title="Typical rent of your matches"
            points={series.points.map((point) => point.rent)}
            labels={series.points.map((point) => point.label)}
            slots={series.slots}
            change={series.change}
            ranges={RANGES}
            range={range}
            onRange={setRange}
            empty={ready ? "No matches with a rent yet" : ""}
          />
        </section>
        <section className="ov-hunt" aria-labelledby="ov-hunt">
          <div className="ov-sec-row">
            <h2 className="ov-sec" id="ov-hunt">
              Your hunt
            </h2>
          </div>
          <div className="ov-stats">
            <StatCard
              tone="lavender"
              label="Matches"
              value={matches ?? "–"}
              {...(newMatches ? { note: `${newMatches} new` } : {})}
              onClick={() => navigate("/offers/match")}
            />
            <StatCard
              tone="mint"
              label="Near matches"
              value={near ?? "–"}
              {...(newNear ? { note: `${newNear} new` } : {})}
              onClick={() => navigate("/offers/near-match")}
            />
            <StatCard
              tone="butter"
              label="Shortlisted"
              value={shortlisted?.length ?? "–"}
              {...(shortlisted && { note: `${contacted} contacted` })}
              onClick={() => navigate("/offers/shortlisted")}
            />
          </div>
        </section>
        <section className="ov-new" aria-labelledby="ov-new">
          <div className="ov-sec-row">
            <h2 className="ov-sec" id="ov-new">
              New for you
            </h2>
            {hasRooms && (
              <Link to="/offers" className="ov-more">
                See all
              </Link>
            )}
          </div>
          {marking.state.status === "failed" && <p role="alert">{marking.state.message}</p>}
          <NewForYou
            state={state}
            rows={fresh.slice(0, NEW_ROWS)}
            hasRooms={hasRooms}
            onOpen={(row) => navigate(`/offers?offer=${row.id}`)}
            onShortlist={(row, on) => act(() => mark(Number(row.id), { shortlisted: on }))}
          />
        </section>
      </div>
    </>
  );
}

function NewForYou({
  state,
  rows,
  hasRooms,
  onOpen,
  onShortlist,
}: {
  state: OverviewOffers;
  rows: OfferRowData[];
  hasRooms: boolean;
  onOpen: (row: OfferRowData) => void;
  onShortlist: (row: OfferRowData, on: boolean) => void;
}) {
  const { hunt } = useHunt();
  if (state.status === "loading") return <p className="muted">Reading your offers…</p>;
  if (state.status === "failed") return null;
  if (!rows.length)
    return (
      <p className="ov-empty">
        {emptyNext(hasRooms ? "Nothing new since you last looked." : "No matches yet.", hunt)}
      </p>
    );
  return (
    <div className="ov-new-list">
      <OffersTable label="New for you" offers={rows} onOpen={onOpen} onShortlist={onShortlist} />
    </div>
  );
}

function HuntCard() {
  const { view, hunt, pause, resume } = useHunt();
  const acting = useMutation(hunt?.state);

  if (!hunt)
    return (
      <p role="status" className="muted">
        {view.status === "loading"
          ? "Checking whether wg-hunt is hunting…"
          : "Couldn't tell whether wg-hunt is hunting."}
      </p>
    );

  const canAct = hunt.canResume || hunt.canPause;
  return (
    <StatusCard
      state={hunt.state}
      action={canAct ? (hunt.canResume ? "Resume" : "Pause") : false}
      onAction={() => void acting.run(hunt.canResume ? resume : pause)}
      busy={acting.busy}
    >
      <p>{hunt.sentence}</p>
      {acting.state.status === "failed" && <p role="alert">{acting.state.message}</p>}
    </StatusCard>
  );
}
