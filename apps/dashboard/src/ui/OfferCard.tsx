import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, IconButton, LinkButton } from "./Button.js";
import { Icon } from "./Icon.js";
import { type Reason, ReasonList } from "./offers.js";
import { type Band, BandTag, Notice } from "./status.js";
import { useSuspended } from "./suspended.js";

export type OfferCardData = {
  title: string;
  district?: string;
  band: Band;
  rent?: string;
  size?: string;
  moveIn?: string;
  distance?: string;
  photos?: string[];
  reasons?: Reason[];
  details?: { label: string; value: string }[];
  shortlisted?: boolean;
  contacted?: boolean;
  dismissed?: boolean;
  url?: string;
};

/** It sits over everything, so it goes straight into the body. */
function Lightbox({
  urls,
  title,
  start,
  onClose,
}: {
  urls: string[];
  title: string;
  start: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(start);
  const box = useRef<HTMLDivElement>(null);
  const latest = useRef(onClose);
  latest.current = onClose;
  const count = urls.length;
  const step = (by: number) => setIndex((i) => (i + by + count) % count);

  const suspended = useSuspended();

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => opener?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!suspended) box.current?.focus();
  }, [suspended]);

  useEffect(() => {
    if (suspended) return;
    // Captured on window, so Esc closes the photos and not the panel behind them.
    function onKey(event: KeyboardEvent) {
      const by = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      if (event.key === "Escape") latest.current();
      else if (by) setIndex((i) => (i + by + count) % count);
      else return;
      event.preventDefault();
      event.stopPropagation();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [count, suspended]);

  return createPortal(
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes it from the keyboard
    <div
      ref={box}
      className="wh-lightbox"
      hidden={suspended}
      inert={suspended}
      role="dialog"
      aria-modal="true"
      aria-label={`Photos of ${title}`}
      tabIndex={-1}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <img
        className="wh-lightbox-img"
        src={urls[index]}
        alt={`${title}, ${index + 1} of ${count}`}
        referrerPolicy="no-referrer"
      />
      <IconButton icon="x" label="Close photos" className="wh-lightbox-close" onClick={onClose} />
      {count > 1 && (
        <>
          <IconButton
            icon="chevronLeft"
            label="Previous photo"
            className="wh-lightbox-prev"
            onClick={() => step(-1)}
          />
          <IconButton
            icon="chevronRight"
            label="Next photo"
            className="wh-lightbox-next"
            onClick={() => step(1)}
          />
        </>
      )}
      <p className="wh-lightbox-count" aria-live="polite">
        {index + 1} / {count}
      </p>
    </div>,
    document.body,
  );
}

/** Photos are the Source's own addresses: the browser loads them, wg-hunt never does. */
function Gallery({ urls, title }: { urls: string[]; title: string }) {
  const [current, setCurrent] = useState(0);
  const [viewing, setViewing] = useState<number | null>(null);
  if (urls.length === 0)
    return (
      <div className="wh-offer-photos is-empty">
        <span className="wh-thumb-lavender">
          <Icon name="house" size={28} />
        </span>
      </div>
    );
  const shown = Math.min(current, urls.length - 1);
  return (
    <div className="wh-offer-photos">
      <button
        type="button"
        className="wh-gallery-main"
        aria-label={`Show photo ${shown + 1} of ${urls.length} full size`}
        onClick={() => setViewing(shown)}
      >
        <img src={urls[shown]} alt="" referrerPolicy="no-referrer" />
        <span className="wh-gallery-count" aria-hidden="true">
          <Icon name="expand" size={14} />
          {shown + 1} / {urls.length}
        </span>
      </button>
      {urls.length > 1 && (
        <ul className="wh-gallery-strip" aria-label="Photos">
          {urls.map((url, index) => (
            <li key={url}>
              <button
                type="button"
                className={index === shown ? "wh-gallery-thumb is-on" : "wh-gallery-thumb"}
                aria-label={`Photo ${index + 1} of ${urls.length}`}
                aria-pressed={index === shown}
                onClick={() => setCurrent(index)}
              >
                <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {viewing !== null && (
        <Lightbox urls={urls} title={title} start={viewing} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}

export function OfferCard({
  offer,
  onShortlist,
  onContacted,
  onDismiss,
  busy = false,
  scam,
  notes,
  history,
  fit,
  children,
}: {
  offer: OfferCardData;
  onShortlist?: (on: boolean) => void;
  onContacted?: (on: boolean) => void;
  onDismiss?: (dismissed: boolean) => void;
  busy?: boolean;
  scam?: ReactNode;
  notes?: ReactNode;
  history?: ReactNode;
  fit?: ReactNode;
  children?: ReactNode;
}) {
  const facts = [
    { label: "Warm rent", value: offer.rent },
    { label: "Size", value: offer.size },
    { label: "Move in", value: offer.moveIn },
    { label: "To work", value: offer.distance },
  ];
  const hasReasons = Boolean(offer.reasons?.length);
  return (
    <article className="wh-card wh-offer">
      <Gallery urls={offer.photos ?? []} title={offer.title} />
      <div className="wh-offer-head">
        <div>
          <h2 className="wh-offer-name">{offer.title}</h2>
          {offer.district && <p className="wh-offer-meta">{offer.district}</p>}
        </div>
        <BandTag band={offer.band} />
      </div>
      {notes}
      {scam && (
        <Notice tone="alarm" title="Might be a scam">
          {scam}
        </Notice>
      )}
      {history}
      <div className="wh-offer-facts">
        <dl className="wh-facts" aria-label="Key facts">
          {facts.map((fact) => (
            <div key={fact.label} className="wh-fact">
              <dt>{fact.label}</dt>
              <dd className={fact.value ? undefined : "is-unknown"}>
                {fact.value || "Not stated"}
              </dd>
            </div>
          ))}
        </dl>
        {offer.details && offer.details.length > 0 && (
          <dl className="wh-details" aria-label="More about this room">
            {offer.details.map((detail) => (
              <div key={detail.label}>
                <dt>{detail.label}</dt>
                <dd>{detail.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      {(hasReasons || fit) && (
        <div className="wh-offer-fit">
          {hasReasons && <ReasonList reasons={offer.reasons ?? []} />}
          {fit}
        </div>
      )}
      <div className="wh-offer-actions">
        {offer.url && (
          <LinkButton variant="primary" href={offer.url} external>
            Open on wg-gesucht
          </LinkButton>
        )}
        {onShortlist && (
          <Button
            variant="secondary"
            icon="star"
            aria-pressed={Boolean(offer.shortlisted)}
            disabled={busy}
            onClick={() => onShortlist(!offer.shortlisted)}
          >
            {offer.shortlisted ? "Shortlisted" : "Shortlist"}
          </Button>
        )}
        {onContacted && (
          <Button
            variant="secondary"
            icon={offer.contacted ? "check" : "message"}
            aria-pressed={Boolean(offer.contacted)}
            disabled={busy}
            onClick={() => onContacted(!offer.contacted)}
          >
            {offer.contacted ? "Contacted" : "Mark contacted"}
          </Button>
        )}
        {onDismiss && (
          <Button
            variant="secondary"
            icon={offer.dismissed ? "refresh" : "x"}
            aria-pressed={Boolean(offer.dismissed)}
            disabled={busy}
            onClick={() => onDismiss(!offer.dismissed)}
          >
            {offer.dismissed ? "Undo: not for me" : "Not for me"}
          </Button>
        )}
      </div>
      {children}
    </article>
  );
}
