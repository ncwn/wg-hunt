import { type MouseEvent, useRef, useState } from "react";
import { Icon } from "./Icon.js";
import { type Band, BandTag } from "./status.js";

export type Reason = {
  outcome: "pass" | "warn" | "fail";
  text: string;
  quote?: string;
};

const REASON_WORD = { pass: "Fits", warn: "Check", fail: "Doesn't fit" } as const;
const RANK = { fail: 0, warn: 1, pass: 2 } as const;

export function ReasonList({
  reasons,
  label = "How it fits you",
}: {
  reasons: Reason[];
  label?: string;
}) {
  const sorted = [...reasons].sort((a, b) => RANK[a.outcome] - RANK[b.outcome]);
  const [picked, setPicked] = useState(-1);
  const quote = picked >= 0 ? sorted[picked]?.quote : undefined;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would put form semantics on a read-only list
    <div className="wh-reasons" role="group" aria-label={label}>
      <ul className="wh-chips">
        {sorted.map((reason, i) => {
          const on = picked === i;
          const classes = `wh-chip wh-chip-${reason.outcome}${on ? " is-on" : ""}`;
          const body = (
            <>
              <span className="wh-sr">{REASON_WORD[reason.outcome]}: </span>
              {reason.text}
            </>
          );
          return (
            <li key={`${reason.outcome}:${reason.text}`}>
              {reason.quote ? (
                <button
                  type="button"
                  className={classes}
                  aria-expanded={on}
                  onClick={(event) => {
                    event.stopPropagation();
                    setPicked(on ? -1 : i);
                  }}
                >
                  {body}
                  <Icon name="chevronDown" size={14} className="wh-chip-chev" />
                </button>
              ) : (
                <span className={classes}>{body}</span>
              )}
            </li>
          );
        })}
      </ul>
      {quote && (
        <p className="wh-reason-quote">
          <span className="wh-reason-quote-label">In the ad</span>“{quote}”
        </p>
      )}
    </div>
  );
}

const THUMB_TONES = ["lavender", "mint", "butter", "sky"] as const;

function Thumb({ seed = 0 }: { seed?: number }) {
  return (
    <span className={`wh-thumb wh-thumb-${THUMB_TONES[seed % THUMB_TONES.length]}`}>
      <Icon name="house" size={20} />
    </span>
  );
}

function ShortlistStar({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      className={on ? "wh-star is-on" : "wh-star"}
      aria-pressed={on}
      aria-label="Shortlist"
      title={on ? "Shortlisted" : "Shortlist"}
      onClick={(event) => {
        event.stopPropagation();
        onChange(!on);
      }}
    >
      <Icon name="star" size={20} />
    </button>
  );
}

export type OfferRowData = {
  id: string | number;
  title: string;
  district?: string;
  distance?: string;
  rent?: string;
  rentNote?: string;
  size?: string;
  moveIn?: string;
  band?: Band;
  isNew?: boolean;
  shortlisted?: boolean;
};

const COLUMNS = ["rent", "size", "moveIn", "fit"] as const;
type OfferColumn = (typeof COLUMNS)[number];

const HEADS: Record<OfferColumn, string> = {
  rent: "Warm rent",
  size: "Size",
  moveIn: "Move in",
  fit: "Fit",
};

function Cell({ column, offer }: { column: OfferColumn; offer: OfferRowData }) {
  switch (column) {
    case "rent":
      return (
        <td className="wh-col-rent wh-num wh-strong">
          {offer.rent ?? "—"}
          {offer.rentNote && <span className="wh-cell-note">{offer.rentNote}</span>}
        </td>
      );
    case "size":
      return <td className="wh-col-size wh-num">{offer.size ?? "—"}</td>;
    case "moveIn":
      return <td className="wh-col-moveIn">{offer.moveIn ?? "—"}</td>;
    case "fit":
      return <td className="wh-col-fit">{offer.band && <BandTag band={offer.band} />}</td>;
  }
}

type RowProps = {
  offer: OfferRowData;
  index: number;
  open: boolean;
  hrefFor: (offer: OfferRowData) => string;
  onOpen?: ((offer: OfferRowData) => void) | undefined;
  onShortlist?: ((offer: OfferRowData, on: boolean) => void) | undefined;
};

/** A click with a modifier key or a middle button is the browser's: a new tab, a new window. */
const ownClick = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/** Shift (a new window) and Alt (a download) have no reliable script equivalent. */
const newTabClick = (event: MouseEvent) =>
  event.button === 1 || (event.button === 0 && (event.metaKey || event.ctrlKey));

function OfferRow({ offer, index, open, hrefFor, onOpen, onShortlist }: RowProps) {
  const link = useRef<HTMLAnchorElement>(null);
  const meta = [offer.district, offer.distance ? `${offer.distance} to work` : undefined]
    .filter(Boolean)
    .join(" · ");
  const follow = (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest("a, button")) return;
    if (window.getSelection()?.toString()) return;
    if (ownClick(event)) link.current?.click();
    else if (newTabClick(event)) window.open(hrefFor(offer), "_blank", "noopener");
  };
  return (
    <tr
      className={open ? "is-link is-open" : "is-link"}
      data-offer-id={offer.id}
      onClick={follow}
      onAuxClick={follow}
    >
      <td className="wh-col-offer">
        <div className="wh-offer-cell">
          <Thumb seed={index} />
          <div className="wh-offer-text">
            <span className="wh-offer-title">
              <a
                ref={link}
                className="wh-offer-link"
                href={hrefFor(offer)}
                aria-current={open ? "true" : undefined}
                onClick={(event) => {
                  if (!onOpen || !ownClick(event)) return;
                  event.preventDefault();
                  onOpen(offer);
                }}
              >
                {offer.title}
              </a>
              {offer.isNew && <span className="wh-new">New</span>}
            </span>
            {meta && <span className="wh-offer-meta">{meta}</span>}
          </div>
        </div>
      </td>
      {COLUMNS.map((column) => (
        <Cell key={column} column={column} offer={offer} />
      ))}
      {onShortlist && (
        <td className="wh-col-save">
          <ShortlistStar
            on={Boolean(offer.shortlisted)}
            onChange={(on) => onShortlist(offer, on)}
          />
        </td>
      )}
    </tr>
  );
}

const offerHref = (offer: OfferRowData) => `/offers?offer=${offer.id}`;

export function OffersTable({
  offers,
  label,
  openId,
  hrefFor = offerHref,
  onOpen,
  onShortlist,
}: {
  offers: OfferRowData[];
  label?: string;
  openId?: string | number | undefined;
  hrefFor?: (offer: OfferRowData) => string;
  onOpen?: (offer: OfferRowData) => void;
  onShortlist?: (offer: OfferRowData, on: boolean) => void;
}) {
  return (
    <div className="wh-table-wrap">
      <table className="wh-table wh-offers" aria-label={label}>
        <thead>
          <tr>
            <th scope="col">Offer</th>
            {COLUMNS.map((column) => (
              <th key={column} scope="col" className={`wh-col-${column}`}>
                {HEADS[column]}
              </th>
            ))}
            {onShortlist && (
              <th scope="col" className="wh-col-save">
                Save
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {offers.map((offer, index) => (
            <OfferRow
              key={offer.id}
              offer={offer}
              index={index}
              open={openId !== undefined && String(openId) === String(offer.id)}
              hrefFor={hrefFor}
              onOpen={onOpen}
              onShortlist={onShortlist}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
