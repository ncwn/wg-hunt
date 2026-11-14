import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { Icon } from "./Icon.js";
import { Popover, useDismiss } from "./Popover.js";

/** A calendar day, as the API writes it: "2026-12-01". */
export type IsoDate = string;

type Day = { y: number; m: number; d: number };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
// Weeks start on Monday, as they do in Germany.
const WEEKDAYS = [
  ["Mo", "Monday"],
  ["Tu", "Tuesday"],
  ["We", "Wednesday"],
  ["Th", "Thursday"],
  ["Fr", "Friday"],
  ["Sa", "Saturday"],
  ["Su", "Sunday"],
] as const;

const pad = (n: number) => String(n).padStart(2, "0");
const iso = ({ y, m, d }: Day): IsoDate => `${y}-${pad(m + 1)}-${pad(d)}`;

function parse(value: string | null | undefined): Day | undefined {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return undefined;
  const day = { y: Number(match[1]), m: Number(match[2]) - 1, d: Number(match[3]) };
  return iso(normal(day)) === value ? day : undefined;
}

function normal({ y, m, d }: Day): Day {
  const date = new Date(y, m, d);
  return { y: date.getFullYear(), m: date.getMonth(), d: date.getDate() };
}

const addDays = (day: Day, n: number) => normal({ ...day, d: day.d + n });
const daysIn = (y: number, m: number) => new Date(y, m + 1, 0).getDate();
function addMonths(day: Day, n: number): Day {
  const first = normal({ y: day.y, m: day.m + n, d: 1 });
  return { ...first, d: Math.min(day.d, daysIn(first.y, first.m)) };
}
/** 0 for Monday … 6 for Sunday. */
const weekday = ({ y, m, d }: Day) => (new Date(y, m, d).getDay() + 6) % 7;
const today = (): Day => {
  const now = new Date();
  return { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() };
};

export function formatDay(value: IsoDate, now = today()): string {
  const day = parse(value);
  if (!day) return value;
  return day.y === now.y ? `${day.d} ${MONTHS[day.m]}` : `${day.d} ${MONTHS[day.m]} ${day.y}`;
}

function weeks(y: number, m: number): Day[][] {
  const first = { y, m, d: 1 };
  const start = addDays(first, -weekday(first));
  const count = Math.ceil((weekday(first) + daysIn(y, m)) / 7);
  return Array.from({ length: count }, (_, w) =>
    Array.from({ length: 7 }, (_, i) => addDays(start, w * 7 + i)),
  );
}

export function DateField({
  label,
  value,
  onChange,
  min,
  disabled,
  className,
}: {
  label: string;
  value: IsoDate | null;
  onChange: (value: IsoDate | null) => void;
  min?: IsoDate;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const grid = useRef<HTMLTableElement>(null);
  const chosen = parse(value);
  const lowest = parse(min);
  const outside = (day: Day) => lowest !== undefined && iso(day) < iso(lowest);
  const [focus, setFocus] = useState<Day>(() => chosen ?? today());
  // The month buttons keep focus; the keys and opening move it onto the focused day.
  const follow = useRef(true);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  useDismiss(open, anchor, () => close(false));

  useEffect(() => {
    if (!open || !follow.current) return;
    grid.current?.querySelector<HTMLButtonElement>(`[data-day="${iso(focus)}"]`)?.focus();
  }, [open, focus]);

  function show() {
    let start = chosen ?? today();
    if (lowest && iso(start) < iso(lowest)) start = lowest;
    follow.current = true;
    setFocus(start);
    setOpen(true);
  }

  function pick(day: Day) {
    if (outside(day)) return;
    onChange(iso(day));
    close(true);
  }

  function moved(event: KeyboardEvent): Day | undefined {
    switch (event.key) {
      case "ArrowLeft":
        return addDays(focus, -1);
      case "ArrowRight":
        return addDays(focus, 1);
      case "ArrowUp":
        return addDays(focus, -7);
      case "ArrowDown":
        return addDays(focus, 7);
      case "Home":
        return addDays(focus, -weekday(focus));
      case "End":
        return addDays(focus, 6 - weekday(focus));
      case "PageUp":
        return addMonths(focus, event.shiftKey ? -12 : -1);
      case "PageDown":
        return addMonths(focus, event.shiftKey ? 12 : 1);
      default:
        return undefined;
    }
  }

  function onGridKey(event: KeyboardEvent) {
    const next = moved(event);
    if (!next) return;
    event.preventDefault();
    follow.current = true;
    setFocus(next);
  }

  const shown = chosen ? formatDay(iso(chosen)) : undefined;
  const now = today();
  return (
    <div className={className ? `wh-field ${className}` : "wh-field"}>
      <label htmlFor={`${id}-trigger`} className="wh-field-label">
        {label}
      </label>
      <span ref={anchor} className="wh-pop-anchor">
        <button
          ref={trigger}
          id={`${id}-trigger`}
          type="button"
          className="wh-field-box wh-field-trigger"
          aria-haspopup="dialog"
          aria-expanded={open}
          data-value={value ?? ""}
          aria-describedby={`${id}-value`}
          disabled={disabled}
          onClick={() => (open ? close(false) : show())}
        >
          <span id={`${id}-value`} className={shown ? "wh-field-value" : "wh-field-value is-empty"}>
            {shown ?? "Pick a day"}
          </span>
          <Icon name="calendar" size={18} className="wh-field-chev" />
        </button>
        <Popover
          open={open}
          anchor={anchor}
          onClose={() => close(true)}
          title={label}
          className="wh-cal-pop"
        >
          <div
            className="wh-cal"
            role="dialog"
            aria-label={label}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                close(true);
              }
            }}
          >
            <div className="wh-cal-head">
              <button
                type="button"
                className="wh-cal-nav"
                aria-label="Previous month"
                onClick={() => {
                  follow.current = false;
                  setFocus(addMonths(focus, -1));
                }}
              >
                <Icon name="chevronLeft" size={18} />
              </button>
              <p className="wh-cal-month" aria-live="polite">
                {MONTH_NAMES[focus.m]} {focus.y}
              </p>
              <button
                type="button"
                className="wh-cal-nav"
                aria-label="Next month"
                onClick={() => {
                  follow.current = false;
                  setFocus(addMonths(focus, 1));
                }}
              >
                <Icon name="chevronRight" size={18} />
              </button>
            </div>
            <table ref={grid} className="wh-cal-grid" onKeyDown={onGridKey}>
              <thead>
                <tr>
                  {WEEKDAYS.map(([short, long]) => (
                    <th key={short} scope="col" abbr={long}>
                      {short}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {weeks(focus.y, focus.m).map((week) => (
                  <tr key={iso(week[0] as Day)}>
                    {week.map((day) => {
                      const key = iso(day);
                      const isChosen = chosen !== undefined && key === iso(chosen);
                      const classes = [
                        "wh-cal-day",
                        day.m !== focus.m && "is-other",
                        key === iso(now) && "is-today",
                        isChosen && "is-chosen",
                      ]
                        .filter(Boolean)
                        .join(" ");
                      return (
                        <td key={key}>
                          <button
                            type="button"
                            className={classes}
                            data-day={key}
                            tabIndex={key === iso(focus) ? 0 : -1}
                            disabled={outside(day)}
                            aria-current={key === iso(now) ? "date" : undefined}
                            aria-pressed={isChosen}
                            aria-label={`${day.d} ${MONTH_NAMES[day.m]} ${day.y}`}
                            onClick={() => pick(day)}
                          >
                            {day.d}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="wh-cal-foot">
              {chosen && (
                <button
                  type="button"
                  className="wh-btn wh-btn-ghost wh-btn-sm"
                  onClick={() => {
                    onChange(null);
                    close(true);
                  }}
                >
                  Clear
                </button>
              )}
              <button
                type="button"
                className="wh-btn wh-btn-secondary wh-btn-sm"
                disabled={outside(now)}
                onClick={() => pick(now)}
              >
                Today
              </button>
            </div>
          </div>
        </Popover>
      </span>
    </div>
  );
}
