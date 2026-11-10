import type { Category } from "../searches.js";
import { type Fact, UNKNOWN } from "./fact.js";
import type { Money } from "./values.js";

/** Defined once, for a Source's parse and the seeker's corrections alike, so the two cannot drift. */

const round2 = (value: number): number => Math.round(value * 100) / 100;

const formatMoney = (money: Money) => `${money.amount} €`;
const formatSize = (size: number) => `${size} m²`;

function evidenceOf<V>(fact: Fact<V>, format: (value: V) => string): string {
  if (fact.origin !== "manual") return fact.quote;
  return `your correction: ${fact.value === UNKNOWN ? UNKNOWN : format(fact.value)}`;
}

const unknownFact = (quote = ""): Fact<never> => ({ value: UNKNOWN, origin: "field", quote });

export const roomSizeIsFlatSize = (category: Category): boolean => category !== "flatshare-room";

export function roomSizeOf(flatSize: Fact<number>): Fact<number> {
  const quote = evidenceOf(flatSize, formatSize);
  return flatSize.value === UNKNOWN
    ? unknownFact(quote)
    : { value: flatSize.value, origin: "field", quote };
}

export function rentPerSqmOf(warmRent: Fact<Money>, roomSize: Fact<number>): Fact<number> {
  if (warmRent.value === UNKNOWN || roomSize.value === UNKNOWN || !(roomSize.value > 0)) {
    return unknownFact();
  }
  return {
    value: round2(warmRent.value.amount / roomSize.value),
    origin: "field",
    quote: `${evidenceOf(warmRent, formatMoney)} / ${evidenceOf(roomSize, formatSize)}`,
  };
}

/**
 * The warm rent is the full monthly cost only when the utilities are stated. A Source with no
 * place to state them leaves this unknown.
 */
export function costsCompleteOf(utilities: Fact<Money>): Fact<boolean> {
  return {
    value: utilities.value !== UNKNOWN,
    origin: "field",
    quote: evidenceOf(utilities, formatMoney),
  };
}

type DerivableFacts = {
  category: Category;
  warmRent?: Fact<Money> | undefined;
  utilities?: Fact<Money> | undefined;
  roomSize?: Fact<number> | undefined;
  flatSize?: Fact<number> | undefined;
  rentPerSqm?: Fact<number> | undefined;
  costsComplete?: Fact<boolean> | undefined;
};

const orUnknown = <V>(fact: Fact<V> | undefined): Fact<V> => fact ?? unknownFact();

function replacing<V>(previous: Fact<V> | undefined, next: Fact<V>): Fact<V> {
  if (previous === undefined || previous.value === UNKNOWN || previous.value === next.value) {
    return next;
  }
  return {
    ...next,
    alternatives: [{ value: previous.value, origin: previous.origin, quote: previous.quote }],
  };
}

export function deriveFacts<F extends DerivableFacts>(facts: F, corrected: ReadonlySet<string>): F {
  const result: DerivableFacts = { ...facts };
  const isCorrected = (key: keyof DerivableFacts) => corrected.has(key);

  let roomSizeChanged = isCorrected("roomSize");
  if (roomSizeIsFlatSize(facts.category) && isCorrected("flatSize") && !isCorrected("roomSize")) {
    result.roomSize = replacing(facts.roomSize, roomSizeOf(orUnknown(facts.flatSize)));
    roomSizeChanged = true;
  }

  if ((isCorrected("warmRent") || roomSizeChanged) && !isCorrected("rentPerSqm")) {
    result.rentPerSqm = replacing(
      facts.rentPerSqm,
      rentPerSqmOf(orUnknown(result.warmRent), orUnknown(result.roomSize)),
    );
  }

  if (isCorrected("utilities") && !isCorrected("costsComplete")) {
    result.costsComplete = replacing(
      facts.costsComplete,
      costsCompleteOf(orUnknown(result.utilities)),
    );
  }

  return result as F;
}
