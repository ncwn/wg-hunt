import type { OfferText } from "../source/source.js";

export type TripwireTopic =
  | "anmeldung"
  | "minimumStay"
  | "diet"
  | "money_before_viewing"
  | "keys_by_post";

type Tripwire = { topic: TripwireTopic; pattern: RegExp };

/**
 * Words that mean a fact is probably in the text. When one is there and the model said it found
 * nothing, the fact is Doubtful: "unknown" would only be a guess. A tripwire does not say what the
 * fact is (the text may say "keine Anmeldung"), only that it must be read again.
 */
const TRIPWIRES: Tripwire[] = [
  { topic: "anmeldung", pattern: /anmeld(?:ung|en)/i },
  { topic: "minimumStay", pattern: /mindestmietdauer|mindestlaufzeit|mindestdauer/i },
  { topic: "diet", pattern: /vegan/i },
  { topic: "money_before_viewing", pattern: /western\s*union|money\s*gram/i },
  {
    topic: "keys_by_post",
    pattern: /schlüssel\s+(?:per|via|mit\s+der)\s+(?:post|kurier|dhl|paket)/i,
  },
];

export type TripwireHit = { topic: TripwireTopic; quote: string };

/** Characters on each side of the word. */
const CONTEXT = 70;

/** Always an exact piece of `piece`. */
function snippet(piece: string, start: number, end: number): string {
  let from = start;
  while (from > 0 && start - from < CONTEXT && !/[.!?\n]/.test(piece[from - 1] ?? "")) from--;
  let to = end;
  while (to < piece.length && to - end < CONTEXT && !/[.!?\n]/.test(piece[to] ?? "")) to++;
  return piece.slice(from, to).trim();
}

export function findTripwires(pieces: readonly string[]): TripwireHit[] {
  const hits: TripwireHit[] = [];
  for (const { topic, pattern } of TRIPWIRES) {
    for (const piece of pieces) {
      const match = pattern.exec(piece);
      if (match === null) continue;
      hits.push({ topic, quote: snippet(piece, match.index, match.index + match[0].length) });
      break;
    }
  }
  return hits;
}

export function textPieces(text: OfferText): string[] {
  return [text.title, ...text.sections.map((section) => section.text)];
}
