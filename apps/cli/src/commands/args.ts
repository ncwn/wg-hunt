import { InvalidArgumentError } from "commander";
import type { Reply } from "../api/client.js";
import type { components } from "../api/schema.js";
import type { Ctx } from "../context.js";
import { CliError, usageError } from "../problem.js";

export type Offer = components["schemas"]["Offer"];

export function integer(name: string, min = 0) {
  return (value: string): number => {
    if (!/^-?\d+$/.test(value) || Number(value) < min) {
      throw new InvalidArgumentError(`${name} must be a whole number of ${min} or more.`);
    }
    return Number(value);
  };
}

function list(value: string, previous: string[] = []): string[] {
  return [
    ...previous,
    ...value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  ];
}

export function choiceList(name: string, choices: readonly string[]) {
  return (value: string, previous: string[] = []): string[] => {
    const next = list(value, previous);
    const bad = next.find((item) => !choices.includes(item));
    if (bad !== undefined) {
      throw new InvalidArgumentError(
        `${name} takes ${choices.join(", ")}; "${bad}" is none of them.`,
      );
    }
    return next;
  };
}

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;

/** A date or time without an offset is Berlin time, as everywhere in the app. */
export function sinceInstant(value: string, now: number): string {
  const span = /^(\d+)([mhdw])$/.exec(value);
  if (span) {
    const [, amount, unit] = span;
    return new Date(now - Number(amount) * UNIT_MS[unit as keyof typeof UNIT_MS]).toISOString();
  }
  const hasOffset = /(Z|[+-]\d\d:?\d\d)$/i.test(value);
  const wall = /^\d{4}-\d\d-\d\d$/.test(value) ? `${value}T00:00:00Z` : `${value}Z`;
  const parsed = hasOffset ? Date.parse(value) : fromBerlinWall(Date.parse(wall));
  if (Number.isNaN(parsed) || !/^\d{4}-\d\d-\d\d/.test(value)) {
    // Not Commander's InvalidArgumentError: a command calls this from its action, where Commander
    // prints nothing for one.
    throw usageError(
      "--since takes a span such as 90m, 24h, 7d or 2w, or a date or time such as 2026-11-01.",
    );
  }
  return new Date(parsed).toISOString();
}

const berlin = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hourCycle: "h23",
});

function berlinOffsetMs(ms: number): number {
  const parts = berlin.formatToParts(ms);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant Berlin's wall clock shows the time `wall` holds as if it were UTC. Two rounds,
 * because the offset at the guess can differ from the offset at the answer across a DST change.
 */
function fromBerlinWall(wall: number): number {
  if (Number.isNaN(wall)) return wall;
  return wall - berlinOffsetMs(wall - berlinOffsetMs(wall));
}

/**
 * A number is tried as an Offer id, then as an Ad ID: Ad IDs are long numbers, so the two do not
 * clash in practice.
 */
export async function findOffer(ctx: Ctx, ref: string): Promise<Reply<Offer>> {
  const { client, send } = ctx.api();
  const byUrl = () => send(client.GET("/offers/lookup", { params: { query: { url: ref } } }));
  const byAdId = (adId: string) =>
    send(client.GET("/offers/lookup", { params: { query: { adId } } }));

  if (/^https?:\/\//i.test(ref)) return byUrl();
  const prefixed = /^ad:(\S+)$/i.exec(ref);
  if (prefixed?.[1]) return byAdId(prefixed[1]);
  if (!/^\d+$/.test(ref) || Number(ref) < 1) {
    throw usageError(`"${ref}" is not an Offer id, an Ad ID (ad:<id>) or an Offer page URL.`);
  }
  try {
    return await send(client.GET("/offers/{id}", { params: { path: { id: Number(ref) } } }));
  } catch (err) {
    if (!(err instanceof CliError) || err.problem.status !== 404) throw err;
    try {
      return await byAdId(ref);
    } catch (second) {
      // Neither exists: the plain "not found" for the id is the better message.
      if (second instanceof CliError && second.problem.status === 404) throw err;
      throw second;
    }
  }
}
