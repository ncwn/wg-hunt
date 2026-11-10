import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import { Segmented } from "./controls.js";

const W = 300;
const H = 100;
const PAD = 8;
/** The smallest rent spread the plot shows top to bottom, so a few euros don't look like a cliff. */
const MIN_SPREAD = 20;

const euro = (value: number) => `€ ${Math.round(value).toLocaleString("en")}`;
const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

export function RentChart<R extends string>({
  points,
  labels,
  slots,
  change,
  title = "Rent of your matches",
  ranges,
  range,
  onRange,
  empty = "No rent to show yet",
  compact = false,
}: {
  points: number[];
  labels?: string[];
  slots?: number;
  change?: string | undefined;
  title?: string;
  ranges?: readonly R[];
  range?: R;
  onRange?: (range: R) => void;
  empty?: string;
  compact?: boolean;
}) {
  const plot = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const n = points.length;
  const total = Math.max(slots ?? n, n);
  const offset = total - n;
  const last = n - 1;
  const shown = active === null ? last : clamp(active, 0, last);

  const low = Math.min(...points);
  const high = Math.max(...points);
  const pad = Math.max(0, MIN_SPREAD - (high - low)) / 2;
  const min = low - pad;
  const max = high + pad;
  const x = (i: number) => (total <= 1 ? W : ((i + offset) / (total - 1)) * W);
  const y = (v: number) => PAD + (1 - (v - min) / (max - min)) * (H - PAD * 2);
  const line = points
    .map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`)
    .join(" ");

  const value = points[shown];
  const lastPoint = points[last];
  const at = (i: number) => labels?.[i];
  const xFrac = n ? x(shown) / W : 1;
  const left = `${xFrac * 100}%`;
  const top = value === undefined ? undefined : `${(y(value) / H) * 100}%`;
  // The tip hangs inwards, so it stays inside the card at either edge.
  const tipShift = 8 + xFrac * 84;

  function indexAt(clientX: number) {
    const rect = plot.current?.getBoundingClientRect();
    if (!rect?.width) return last;
    const frac = clamp((clientX - rect.left) / rect.width, 0, 1);
    return clamp(Math.round(frac * (total - 1)) - offset, 0, last);
  }

  // Touch and pen pointers stay with the plot while they drag (implicit capture), so a drag scrubs.
  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    setActive(indexAt(event.clientX));
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" || event.buttons) setActive(indexAt(event.clientX));
  }

  function onPointerEnd(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "mouse" || event.type === "pointerleave") setActive(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, number> = {
      ArrowLeft: shown - 1,
      ArrowDown: shown - 1,
      ArrowRight: shown + 1,
      ArrowUp: shown + 1,
      PageDown: shown - 7,
      PageUp: shown + 7,
      Home: 0,
      End: last,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setActive(clamp(next, 0, last));
  }

  const describe = (i: number) => {
    const rent = points[i];
    if (rent === undefined) return "";
    const day = at(i);
    return day ? `${euro(rent)}, ${day}` : euro(rent);
  };

  return (
    <section
      className={compact ? "wh-card wh-chart wh-chart-compact" : "wh-card wh-chart"}
      aria-label={title}
    >
      <div className="wh-chart-head">
        {compact ? (
          <p className="wh-chart-title">{title}</p>
        ) : (
          <div>
            <p className="wh-chart-figure">{lastPoint === undefined ? "—" : euro(lastPoint)}</p>
            {lastPoint === undefined && empty && <p className="wh-chart-label">{empty}</p>}
          </div>
        )}
        {change && <span className="wh-chart-change">{change}</span>}
      </div>
      <div className="wh-chart-plot">
        {value !== undefined && (
          <div
            ref={plot}
            className="wh-chart-scrub"
            role="slider"
            tabIndex={0}
            aria-label={`${title}, by day`}
            aria-valuemin={0}
            aria-valuemax={last}
            aria-valuenow={shown}
            aria-valuetext={describe(shown)}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            onPointerLeave={onPointerEnd}
            onKeyDown={onKeyDown}
            onBlur={() => setActive(null)}
          >
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
              {n > 1 && (
                <>
                  <path
                    d={`${line} L${x(last).toFixed(1)} ${H} L${x(0).toFixed(1)} ${H} Z`}
                    className="wh-chart-area"
                  />
                  <path d={line} className="wh-chart-line" vectorEffect="non-scaling-stroke" />
                </>
              )}
            </svg>
            <span
              className="wh-chart-guide"
              style={{ left, top: active === null ? top : 0 }}
              aria-hidden="true"
            />
            <span className="wh-chart-point" style={{ left, top }} aria-hidden="true" />
            <span
              className="wh-chart-tip"
              style={{ left, top, transform: `translate(-${tipShift}%, calc(-100% - 14px))` }}
              aria-hidden="true"
            >
              <span>{euro(value)}</span>
              {at(shown) && <span className="wh-chart-tip-day">{at(shown)}</span>}
            </span>
          </div>
        )}
      </div>
      {ranges && range !== undefined && onRange && (
        <Segmented
          quiet
          label="Time range"
          options={ranges.map((value) => ({ value, label: value }))}
          value={range}
          onChange={onRange}
        />
      )}
    </section>
  );
}
