import { existsSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { offerAds, offers, seenAds } from "../src/db/schema.js";
import { bootOffers, HOUR } from "./offers-harness.js";

export const DAY = 24 * HOUR;

export type Harness = ReturnType<typeof bootOffers>;

export async function oneOffer(adId = 9000001) {
  const h = bootOffers();
  h.site.cards = h.freshCards([adId]);
  await h.addSearch();
  await h.crawl();
  const { items } = (await h.json("GET", "/offers")).body;
  if (items.length !== 1) throw new Error("expected one Offer");
  return { h, id: items[0].id as number, adId: String(adId) };
}

export const recordExists = (h: Harness, id: number) =>
  h.runtime.db.select().from(offers).where(eq(offers.id, id)).get() !== undefined;

export const snapshotExists = (h: Harness, adId: string) =>
  existsSync(join(h.dataDir, "offer-pages", "wg-gesucht", `${adId}.html.gz`));

export const adIdsOf = (h: Harness, id: number) =>
  h.runtime.db
    .select()
    .from(offerAds)
    .where(eq(offerAds.offerId, id))
    .all()
    .map((ad) => ad.adId);

export const seenAdIds = (h: Harness) =>
  h.runtime.db
    .select()
    .from(seenAds)
    .all()
    .map((row) => row.adId);

export function nights(h: Harness, days: number) {
  for (let i = 0; i < days; i++) {
    h.clock.now += DAY;
    h.runtime.retention.prune();
  }
}

export function goStale(h: Harness) {
  h.clock.now += 8 * DAY;
  h.runtime.retention.prune();
}

export function breakPrune(h: Harness) {
  const client = h.runtime.db.$client;
  client
    .prepare("INSERT INTO crawl_requests (at, kind, path, outcome) VALUES (?, 'poll', '/', 'ok')")
    .run(h.clock.now - 40 * DAY);
  client.exec(
    "CREATE TRIGGER break_prune BEFORE DELETE ON crawl_requests BEGIN SELECT RAISE(ABORT, 'no'); END",
  );
  return { mend: () => client.exec("DROP TRIGGER break_prune") };
}
