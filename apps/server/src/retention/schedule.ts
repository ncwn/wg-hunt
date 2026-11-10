import { berlinInstant } from "../crawl/berlin-time.js";
import { PRUNE_AT } from "./constants.js";

export function nextScheduledPrune(now: number): number {
  const today = berlinInstant(now, 0, PRUNE_AT.hour, PRUNE_AT.minute);
  return today >= now ? today : berlinInstant(now, 1, PRUNE_AT.hour, PRUNE_AT.minute);
}
