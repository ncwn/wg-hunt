import type { FactOverride, Source } from "@wg-hunt/core";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { offerFactOverrides } from "../db/schema.js";

export type MadeOn = { source: Source; adId: string; contentHash: string | null };

export function createFactOverrides(db: Db, clock: () => number) {
  function forOffers(offerIds?: number[]): Map<number, FactOverride[]> {
    const rows =
      offerIds === undefined
        ? db.select().from(offerFactOverrides).all()
        : offerIds.length === 0
          ? []
          : db
              .select()
              .from(offerFactOverrides)
              .where(inArray(offerFactOverrides.offerId, offerIds))
              .all();
    const byOffer = new Map<number, FactOverride[]>();
    for (const row of rows) {
      byOffer.set(row.offerId, [
        ...(byOffer.get(row.offerId) ?? []),
        { key: row.fact, value: JSON.parse(row.value) as unknown },
      ]);
    }
    return byOffer;
  }

  function all(
    offerId?: number,
  ): { offerId: number; key: string; value: unknown; createdAt: Date; madeOn: MadeOn | null }[] {
    return db
      .select()
      .from(offerFactOverrides)
      .where(offerId === undefined ? undefined : eq(offerFactOverrides.offerId, offerId))
      .orderBy(offerFactOverrides.offerId, offerFactOverrides.fact)
      .all()
      .map((row) => ({
        offerId: row.offerId,
        key: row.fact,
        value: JSON.parse(row.value) as unknown,
        createdAt: row.createdAt,
        madeOn:
          row.source === null || row.adId === null
            ? null
            : { source: row.source, adId: row.adId, contentHash: row.contentHash },
      }));
  }

  function set(offerId: number, fact: string, value: unknown, madeOn: MadeOn | null): void {
    const stamp = {
      value: JSON.stringify(value),
      createdAt: new Date(clock()),
      source: madeOn?.source ?? null,
      adId: madeOn?.adId ?? null,
      contentHash: madeOn?.contentHash ?? null,
    };
    db.insert(offerFactOverrides)
      .values({ offerId, fact, ...stamp })
      .onConflictDoUpdate({
        target: [offerFactOverrides.offerId, offerFactOverrides.fact],
        set: stamp,
      })
      .run();
  }

  function clear(offerId: number, fact: string): void {
    db.delete(offerFactOverrides)
      .where(and(eq(offerFactOverrides.offerId, offerId), eq(offerFactOverrides.fact, fact)))
      .run();
  }

  /**
   * Where both corrected the same fact, the survivor's stays: it is the room the seeker is looking
   * at.
   */
  function moveTo(survivorId: number, absorbedId: number): void {
    const kept = (forOffers([survivorId]).get(survivorId) ?? []).map((o) => o.key);
    db.update(offerFactOverrides)
      .set({ offerId: survivorId })
      .where(
        and(eq(offerFactOverrides.offerId, absorbedId), notInArray(offerFactOverrides.fact, kept)),
      )
      .run();
    db.delete(offerFactOverrides).where(eq(offerFactOverrides.offerId, absorbedId)).run();
  }

  function rehash(ad: { source: Source; adId: string }, from: string, to: string): void {
    db.update(offerFactOverrides)
      .set({ contentHash: to })
      .where(
        and(
          eq(offerFactOverrides.source, ad.source),
          eq(offerFactOverrides.adId, ad.adId),
          eq(offerFactOverrides.contentHash, from),
        ),
      )
      .run();
  }

  return { forOffers, all, set, clear, moveTo, rehash };
}
