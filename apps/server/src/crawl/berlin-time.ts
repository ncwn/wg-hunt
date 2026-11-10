import { ACTIVE_HOURS_ZONE } from "./constants.js";

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: ACTIVE_HOURS_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hourCycle: "h23",
});

type Wall = { year: number; month: number; day: number; hour: number; minute: number };

function wallClock(ms: number): Wall & { second: number } {
  // Formatting is the costly part, and the crawl engine converts several times per step.
  const parts = formatter.formatToParts(ms);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function offsetMs(ms: number): number {
  const w = wallClock(ms);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** `day` may overflow the month. */
function berlinToUtc({ year, month, day, hour, minute }: Wall): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetMs(guess);
  return guess - offsetMs(first);
}

export function berlinDayStart(ms: number, daysAhead = 0): number {
  const w = wallClock(ms);
  return berlinToUtc({ ...w, day: w.day + daysAhead, hour: 0, minute: 0 });
}

export function berlinInstant(ms: number, daysAhead: number, hour: number, minute: number): number {
  const w = wallClock(ms);
  return berlinToUtc({ ...w, day: w.day + daysAhead, hour, minute });
}

export function berlinMinuteOfDay(ms: number): number {
  const w = wallClock(ms);
  return w.hour * 60 + w.minute + w.second / 60;
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** The daily window is `[start, end)`, given as "HH:MM" Berlin times with `start` before `end`. */
export function nextActiveInstant(ms: number, start: string, end: string): number {
  const w = wallClock(ms);
  const minuteOfDay = w.hour * 60 + w.minute;
  if (minuteOfDay >= toMinutes(start) && minuteOfDay < toMinutes(end)) return ms;
  const startAt = (daysAhead: number) =>
    berlinToUtc({
      ...w,
      day: w.day + daysAhead,
      hour: Math.floor(toMinutes(start) / 60),
      minute: toMinutes(start) % 60,
    });
  return minuteOfDay < toMinutes(start) ? startAt(0) : startAt(1);
}
