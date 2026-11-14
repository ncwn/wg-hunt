import {
  type AdProfile,
  type Comparison,
  commonPhotos,
  compareAds,
  type PhotoIndex,
  type Source,
} from "@wg-hunt/core";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { type OfferAdRow, offerAds, offerLinks, offerPairOverrides } from "../db/schema.js";

export type Verdict = "same" | "different";

export type OverrideLookup = (source: Source, a: string, b: string) => Verdict | undefined;

/**
 * Raise it when `profileOf` in core reads a page differently, so the profiles already stored are
 * read again from their pages. A profile stored without a format is 1.
 */
const PROFILE_FORMAT = 2;

export const profileOutdated = () =>
  or(
    isNull(offerAds.profile),
    sql`coalesce(json_extract(${offerAds.profile}, '$.format'), 1) < ${PROFILE_FORMAT}`,
  );

export type ProfiledAd = { row: OfferAdRow; profile: AdProfile };

export type DuplicateMatch = { offerId: number; comparison: Comparison };

export function createDedupeStore(db: Db, clock: () => number) {
  const sorted = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

  function profileOf(row: OfferAdRow): AdProfile | undefined {
    if (row.profile === null) return undefined;
    const { format: _, ...profile } = JSON.parse(row.profile) as AdProfile & { format?: number };
    return profile;
  }

  const profileColumns = (profile: AdProfile) => ({
    profile: JSON.stringify({ ...profile, format: PROFILE_FORMAT }),
    category: profile.category,
    postalCode: profile.postalCode,
  });

  /** Whatever state its page is in: Stale Offers are compared too. */
  function candidates(source: Source, profile: AdProfile): ProfiledAd[] {
    if (profile.postalCode === null) return [];
    return db
      .select()
      .from(offerAds)
      .where(
        and(
          eq(offerAds.source, source),
          eq(offerAds.category, profile.category),
          eq(offerAds.postalCode, profile.postalCode),
        ),
      )
      .all()
      .flatMap((row) => {
        const found = profileOf(row);
        return found === undefined ? [] : [{ row, profile: found }];
      });
  }

  function photoIndex(source: Source): PhotoIndex {
    const rows = db.all<{ photoKey: string; offerId: number }>(
      sql`select distinct photo.value as photoKey, ${offerAds.offerId} as offerId
          from ${offerAds}, json_each(${offerAds.profile}, '$.images') as photo
          where ${offerAds.source} = ${source} and ${offerAds.profile} is not null`,
    );
    const index = new Map<string, Set<number>>();
    for (const { photoKey, offerId } of rows) {
      index.set(photoKey, (index.get(photoKey) ?? new Set()).add(offerId));
    }
    return index;
  }

  function photoIndexes(): (source: Source) => PhotoIndex {
    const read = new Map<Source, PhotoIndex>();
    return (source) => {
      const index = read.get(source) ?? photoIndex(source);
      read.set(source, index);
      return index;
    };
  }

  function overrideOf(source: Source, a: string, b: string): Verdict | undefined {
    const [first, second] = sorted(a, b);
    return db
      .select({ verdict: offerPairOverrides.verdict })
      .from(offerPairOverrides)
      .where(
        and(
          eq(offerPairOverrides.source, source),
          eq(offerPairOverrides.adIdA, first),
          eq(offerPairOverrides.adIdB, second),
        ),
      )
      .get()?.verdict;
  }

  function setOverrides(source: Source, pairs: [string, string][], verdict: Verdict): void {
    const createdAt = new Date(clock());
    for (const [a, b] of pairs) {
      if (a === b) continue;
      const [adIdA, adIdB] = sorted(a, b);
      db.insert(offerPairOverrides)
        .values({ source, adIdA, adIdB, verdict, createdAt })
        .onConflictDoUpdate({
          target: [offerPairOverrides.source, offerPairOverrides.adIdA, offerPairOverrides.adIdB],
          set: { verdict, createdAt },
        })
        .run();
    }
  }

  function overrideLookup(): OverrideLookup {
    const all = new Map(
      db
        .select()
        .from(offerPairOverrides)
        .all()
        .map((row) => [`${row.source}|${row.adIdA}|${row.adIdB}`, row.verdict] as const),
    );
    return (source, a, b) => {
      const [first, second] = sorted(a, b);
      return all.get(`${source}|${first}|${second}`);
    };
  }

  function relate(
    source: Source,
    a: ProfiledAd,
    b: ProfiledAd,
    lookup: OverrideLookup = overrideOf,
    photos: PhotoIndex = photoIndex(source),
  ): Comparison {
    const common = commonPhotos([...a.profile.images, ...b.profile.images], photos, [
      a.row.offerId,
      b.row.offerId,
    ]);
    const comparison = compareAds(a.profile, b.profile, common);
    const verdict = lookup(source, a.row.adId, b.row.adId);
    if (verdict === "same") return { ...comparison, relation: "duplicate" };
    // "Not the same room" only rules out the Duplicate: what the rules saw of a Sibling or a Cloned
    // offer still stands, and a re-post of the same Advertiser they keep apart is another room of
    // the flat.
    if (verdict === "different" && comparison.relation === "duplicate") {
      return { ...comparison, relation: "sibling" };
    }
    return comparison;
  }

  // 1. No two Ad IDs of one Offer carry a "different" verdict.
  // 2. No two Ad IDs of different Offers carry a "same" verdict.
  //
  // The seeker's merge and split write the verdict for every pair across the two sides
  // (`recordSame`, `recordDifferent`), so neither leaves a pair behind that breaks them; dedupe
  // joins two sides only when `mayJoin` says so.

  type AdKey = Pick<OfferAdRow, "source" | "adId">;
  const crossPairs = (left: AdKey[], right: AdKey[]) =>
    left.flatMap((a) =>
      right
        .filter((b) => b.source === a.source)
        .map((b): [Source, string, string] => [a.source, a.adId, b.adId]),
    );

  function mayJoin(left: AdKey[], right: AdKey[], lookup: OverrideLookup = overrideOf): boolean {
    return !crossPairs(left, right).some(([source, a, b]) => lookup(source, a, b) === "different");
  }

  function recordSame(left: AdKey[], right: AdKey[]): void {
    for (const [source, a, b] of crossPairs(left, right)) setOverrides(source, [[a, b]], "same");
  }

  function recordDifferent(leaving: AdKey[], staying: AdKey[]): void {
    for (const [source, a, b] of crossPairs(leaving, staying)) {
      setOverrides(source, [[a, b]], "different");
    }
  }

  function findDuplicate(
    source: Source,
    adId: string,
    profile: AdProfile,
  ): DuplicateMatch | undefined {
    const me: ProfiledAd = {
      row: { source, adId } as OfferAdRow,
      profile,
    };
    let best: DuplicateMatch | undefined;
    const photos = photoIndex(source);
    const joinable = new Map<number, boolean>();
    const mayJoinOffer = (offerId: number) => {
      const known = joinable.get(offerId);
      if (known !== undefined) return known;
      const ads = db.select().from(offerAds).where(eq(offerAds.offerId, offerId)).all();
      const answer = mayJoin([me.row], ads);
      joinable.set(offerId, answer);
      return answer;
    };
    for (const other of candidates(source, profile)) {
      if (other.row.adId === adId) continue;
      const comparison = relate(source, me, other, overrideOf, photos);
      if (comparison.relation !== "duplicate") continue;
      if (!mayJoinOffer(other.row.offerId)) continue;
      const better =
        best === undefined ||
        comparison.sharedImages > best.comparison.sharedImages ||
        (comparison.sharedImages === best.comparison.sharedImages &&
          (comparison.textSimilarity ?? 0) > (best.comparison.textSimilarity ?? 0)) ||
        (comparison.sharedImages === best.comparison.sharedImages &&
          (comparison.textSimilarity ?? 0) === (best.comparison.textSimilarity ?? 0) &&
          other.row.offerId < best.offerId);
      if (better) best = { offerId: other.row.offerId, comparison };
    }
    return best;
  }

  const involving = (source: Source, adIds: string[]) =>
    and(
      eq(offerLinks.source, source),
      or(inArray(offerLinks.adId, adIds), inArray(offerLinks.otherAdId, adIds)),
    );

  function insertLink(source: Source, a: OfferAdRow, b: OfferAdRow, comparison: Comparison): void {
    if (comparison.relation !== "sibling" && comparison.relation !== "cloned") return;
    const aLater =
      a.firstSeenAt.getTime() > b.firstSeenAt.getTime() ||
      (a.firstSeenAt.getTime() === b.firstSeenAt.getTime() && a.adId > b.adId);
    const [later, earlier] = aLater ? [a, b] : [b, a];
    db.insert(offerLinks)
      .values({
        source,
        adId: later.adId,
        otherAdId: earlier.adId,
        kind: comparison.relation,
        sharedImages: comparison.sharedImages,
        textSimilarity: comparison.textSimilarity,
      })
      .onConflictDoNothing()
      .run();
  }

  /** Links inside one Offer are not kept: its Ad IDs are one room. */
  function relink(source: Source, adIds: string[]): void {
    db.$client.transaction(() => {
      if (adIds.length === 0) return;
      db.delete(offerLinks).where(involving(source, adIds)).run();
      const rows = db
        .select()
        .from(offerAds)
        .where(and(eq(offerAds.source, source), inArray(offerAds.adId, adIds)))
        .all();
      const photos = photoIndex(source);
      for (const row of rows) {
        const profile = profileOf(row);
        if (profile === undefined) continue;
        const mine: ProfiledAd = { row, profile };
        for (const other of candidates(source, profile)) {
          if (other.row.offerId === row.offerId) continue;
          insertLink(source, row, other.row, relate(source, mine, other, overrideOf, photos));
        }
      }
    })();
  }

  function buckets(rows: OfferAdRow[]): ProfiledAd[][] {
    const grouped = new Map<string, ProfiledAd[]>();
    for (const row of rows) {
      const profile = profileOf(row);
      if (profile === undefined || profile.postalCode === null) continue;
      const key = `${row.source}|${profile.category}|${profile.postalCode}`;
      grouped.set(key, [...(grouped.get(key) ?? []), { row, profile }]);
    }
    return [...grouped.values()];
  }

  function rebuildLinks(): void {
    db.$client.transaction(() => {
      db.delete(offerLinks).run();
      const lookup = overrideLookup();
      const photos = photoIndexes();
      for (const bucket of buckets(db.select().from(offerAds).all())) {
        bucket.forEach((mine, index) => {
          for (const other of bucket.slice(index + 1)) {
            if (mine.row.offerId === other.row.offerId) continue;
            insertLink(
              mine.row.source,
              mine.row,
              other.row,
              relate(mine.row.source, mine, other, lookup, photos(mine.row.source)),
            );
          }
        });
      }
    })();
  }

  return {
    profileColumns,
    overrideLookup,
    photoIndexes,
    relate,
    mayJoin,
    recordSame,
    recordDifferent,
    findDuplicate,
    buckets,
    relink,
    rebuildLinks,
  };
}
