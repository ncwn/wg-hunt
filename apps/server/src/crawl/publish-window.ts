import type { CardOnline } from "@wg-hunt/core";
import { berlinDayStart } from "./berlin-time.js";

const MINUTE = 60_000;

/**
 * The instants between which an Ad ID was last published or Bumped, as a card's "Online" age
 * allows, and the width of the unit that age was rounded to.
 */
export type PublishWindow = { earliest: number; latest: number; unit: number };

/**
 * "Online: 8 Std." means 8 up to (not including) 9 hours ago, and from about five days on a card
 * shows a date.
 */
export function publishWindow(online: CardOnline, observedAt: number): PublishWindow {
  if (online.age.kind === "date") {
    // Noon UTC is on the same calendar day in Berlin, winter or summer.
    const noon = Date.parse(`${online.age.date}T12:00:00Z`);
    const earliest = berlinDayStart(noon);
    const next = berlinDayStart(noon, 1);
    return { earliest, latest: next - 1, unit: next - earliest };
  }
  const unit = online.unitMinutes * MINUTE;
  const latest = observedAt - online.age.minutes * MINUTE;
  return { earliest: latest - unit, latest, unit };
}

/**
 * Clock differences of a few seconds, or an age that rounds the other way, never make an unchanged
 * Ad ID look Bumped.
 */
export function wasBumped(earlier: PublishWindow, now: PublishWindow): boolean {
  return now.earliest > earlier.latest + Math.max(earlier.unit, now.unit);
}

/** For certain: even its newest possible publish is further back. */
export function olderThan(window: PublishWindow, days: number, observedAt: number): boolean {
  return window.latest < observedAt - days * 24 * 60 * MINUTE;
}
