import {
  assessScam,
  type ClonedOriginal,
  type Fact,
  type FactOverride,
  type OfferFacts,
  type RentSample,
  rentBaselines,
  type ScamAssessment,
} from "@wg-hunt/core";
import { eq, getTableColumns } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { type OfferRow, offerAds, offerLinks, offers } from "../db/schema.js";
import { factsOf } from "./ranking.js";

export type ScamContext = {
  assess(row: OfferRow, facts: OfferFacts): ScamAssessment;
};

const stated = <T>(facts: OfferFacts, key: keyof OfferFacts): T | null => {
  const fact = facts[key] as Fact<T> | undefined;
  return fact === undefined || fact.value === "unknown" ? null : (fact.value as T);
};

/** Recomputed every ranking pass, so one new Offer moves every baseline in its district at once. */
export function createScamContext(
  db: Db,
  now: number,
  overrides: ReadonlyMap<number, readonly FactOverride[]>,
): ScamContext {
  const { id, category, facts, analysisState, modelFacts, analysis, firstSeenAt } =
    getTableColumns(offers);
  const everyone = db
    .select({ id, category, facts, analysisState, modelFacts, analysis, firstSeenAt })
    .from(offers)
    .all()
    .map((row) => ({ ...row, facts: factsOf(row, overrides.get(row.id) ?? []) }));
  const samples = everyone.flatMap((row): RentSample[] => {
    const district = stated<string>(row.facts, "district");
    const perSqm = stated<number>(row.facts, "rentPerSqm");
    // A per-night price times 30 is not a rent that compares with a monthly one.
    if (
      district === null ||
      perSqm === null ||
      stated<{ converted: boolean }>(row.facts, "warmRent")?.converted
    ) {
      return [];
    }
    return [
      {
        id: row.id,
        category: row.category,
        district,
        rentPerSqm: perSqm,
        seenAt: row.firstSeenAt.getTime(),
      },
    ];
  });
  const baselineFor = rentBaselines(samples, now);

  const links = db.select().from(offerLinks).where(eq(offerLinks.kind, "cloned")).all();
  const copies = new Map<number, Map<number, Omit<ClonedOriginal, "memberSince">>>();
  if (links.length > 0) {
    const offerOf = new Map(
      db
        .select({ source: offerAds.source, adId: offerAds.adId, offerId: offerAds.offerId })
        .from(offerAds)
        .all()
        .map((ad) => [`${ad.source}:${ad.adId}`, ad.offerId] as const),
    );
    for (const link of links) {
      const copy = offerOf.get(`${link.source}:${link.adId}`);
      const original = offerOf.get(`${link.source}:${link.otherAdId}`);
      if (copy === undefined || original === undefined || copy === original) continue;
      const mine = copies.get(copy) ?? new Map();
      const seen = mine.get(original);
      // Several links can join the same two Offers: the one with the most in common speaks.
      if (
        seen === undefined ||
        link.sharedImages > seen.sharedImages ||
        (link.sharedImages === seen.sharedImages &&
          (link.textSimilarity ?? 0) > (seen.textSimilarity ?? 0))
      ) {
        mine.set(original, {
          offerId: original,
          sharedImages: link.sharedImages,
          textSimilarity: link.textSimilarity,
        });
      }
      copies.set(copy, mine);
    }
  }

  const memberSince = new Map(
    everyone.map((row) => [row.id, stated<string>(row.facts, "memberSince")] as const),
  );
  const memberSinceOf = (offerId: number): string | null => memberSince.get(offerId) ?? null;

  return {
    assess(row, facts) {
      const originals = [...(copies.get(row.id)?.values() ?? [])].map(
        (original): ClonedOriginal => ({
          ...original,
          memberSince: memberSinceOf(original.offerId),
        }),
      );
      return assessScam({
        facts,
        now,
        mark: row.scamMark,
        baseline: baselineFor({
          id: row.id,
          category: row.category,
          district:
            facts.district?.value === undefined || facts.district.value === "unknown"
              ? null
              : facts.district.value,
        }),
        originals,
      });
    },
  };
}
