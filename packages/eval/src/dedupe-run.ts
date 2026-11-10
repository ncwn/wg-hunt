import { type AdProfile, compareAds, profileOf } from "@wg-hunt/core";
import { wgGesuchtSource } from "@wg-hunt/core/sources/wg-gesucht";
import type { PairCase, PairSide } from "./cases.js";
import { type DedupeMetrics, dedupeMetrics } from "./dedupe-metrics.js";

const FIRST_SEEN = new Date("2026-11-04T09:00:00Z");

/** One side of a pair, built the way the server builds it from a page and its card. */
function profileOfSide(pair: PairCase, side: PairSide, name: string): AdProfile {
  const parsed = wgGesuchtSource.parseOffer(side.html, {
    firstSeen: FIRST_SEEN,
    category: pair.category,
  });
  if (parsed.outcome !== "parsed" || parsed.status === "deleted") {
    throw new Error(`${pair.id}: page ${name} is not an Offer page the adapter can read`);
  }
  return profileOf({
    category: parsed.category,
    facts: parsed.facts,
    text: parsed.text,
    card: {
      adId: parsed.adId ?? name,
      path: `/${parsed.adId ?? name}.html`,
      title: parsed.text.title,
      advertiser: side.advertiser,
    },
  });
}

export function runDedupe(pairs: readonly PairCase[]): DedupeMetrics {
  return dedupeMetrics(
    pairs.map((pair) => ({
      id: pair.id,
      expected: pair.expected,
      actual: compareAds(profileOfSide(pair, pair.a, "a"), profileOfSide(pair, pair.b, "b"))
        .relation,
    })),
  );
}
