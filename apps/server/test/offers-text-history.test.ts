import { describe, expect, it } from "vitest";
import { offerTexts } from "../src/db/schema.js";
import {
  fetchedAd,
  ingestAds,
  OTHER_ROOM_TEXT,
  photo,
  ROOM_TEXT,
  ROOM_TEXT_EDITED,
} from "./dedupe-harness.js";
import { bootOffers, MINUTE } from "./offers-harness.js";
import { goStale, nights, oneOffer } from "./retention-harness.js";

type Harness = ReturnType<typeof bootOffers>;
type TextVersion = {
  source: string;
  adId: string;
  seenAt: string;
  hash: string;
  title: string;
  sections: { label: string; text: string }[];
};

const detailOf = async (h: Harness, adId: number) =>
  (await h.json("GET", `/offers/lookup?adId=${adId}`)).body;
const historyOf = async (h: Harness, adId: number): Promise<TextVersion[]> =>
  (await detailOf(h, adId)).textHistory;
const words = (version: TextVersion) => version.sections.map((s) => s.text).join("\n");

describe("Text versions of an Offer's Ad IDs", () => {
  it("keeps one Text version per Ad ID when a Duplicate's text differs", async () => {
    const h = bootOffers();
    const first = h.clock.now;
    ingestAds(
      h,
      { adId: 9000001, title: "Helles Zimmer" },
      { adId: 9000002, title: "Freundliches Zimmer", text: ROOM_TEXT_EDITED },
    );

    const offer = await detailOf(h, 9000002);
    expect(offer.ads).toHaveLength(2);
    const history: TextVersion[] = offer.textHistory;
    expect(history.map((v) => [v.adId, v.title])).toEqual([
      ["9000001", "Helles Zimmer"],
      ["9000002", "Freundliches Zimmer"],
    ]);
    expect(words(history[0] as TextVersion)).toContain(ROOM_TEXT);
    expect(words(history[1] as TextVersion)).toContain(ROOM_TEXT_EDITED);
    expect(history[0]?.source).toBe("wg-gesucht");
    expect(history.map((v) => v.seenAt)).toEqual([
      new Date(first).toISOString(),
      new Date(first + 10 * MINUTE).toISOString(),
    ]);
    expect(history.map((v) => v.hash)).toEqual(
      offer.ads.map((ad: { textHash: string }) => ad.textHash),
    );
  });

  it("adds a version when a Recheck finds the text edited, and none when it is unchanged", async () => {
    const h = bootOffers();
    ingestAds(h, { adId: 9000001 });

    h.runtime.offers.ingest(fetchedAd(h, { adId: 9000001 }, 60 * MINUTE));
    expect(await historyOf(h, 9000001)).toHaveLength(1);

    h.runtime.offers.ingest(fetchedAd(h, { adId: 9000001, text: ROOM_TEXT_EDITED }, 120 * MINUTE));
    const history = await historyOf(h, 9000001);
    expect(history.map((v) => v.adId)).toEqual(["9000001", "9000001"]);
    expect(words(history[0] as TextVersion)).toContain(ROOM_TEXT);
    expect(words(history[1] as TextVersion)).toContain(ROOM_TEXT_EDITED);
    expect(history[1]?.seenAt).toBe(new Date(h.clock.now + 120 * MINUTE).toISOString());
  });

  it("stores the same page twice only once", async () => {
    const h = bootOffers();
    const page = fetchedAd(h, { adId: 9000001 });
    h.runtime.offers.ingest(page);
    h.runtime.offers.ingest(page);
    expect(await historyOf(h, 9000001)).toHaveLength(1);
  });

  it("moves an Ad ID's versions with it when it is split out, and back when merged", async () => {
    const h = bootOffers();
    ingestAds(h, { adId: 9000001 }, { adId: 9000002, text: ROOM_TEXT_EDITED });
    const before = await detailOf(h, 9000001);
    expect(before.textHistory).toHaveLength(2);

    const split = await h.json("POST", `/offers/${before.id}/split`, { adId: "9000001" });
    expect(split.status).toBe(201);
    expect(split.body.textHistory.map((v: TextVersion) => v.adId)).toEqual(["9000001"]);
    expect((await historyOf(h, 9000002)).map((v) => v.adId)).toEqual(["9000002"]);

    const merged = await h.json("POST", `/offers/${before.id}/merge`, { offerId: split.body.id });
    expect(merged.status).toBe(200);
    expect(merged.body.textHistory.map((v: TextVersion) => v.adId)).toEqual(["9000001", "9000002"]);
  });

  it("keeps a Sibling's text with the Sibling", async () => {
    const h = bootOffers();
    ingestAds(
      h,
      { adId: 9000001, roomSize: 18 },
      { adId: 9000002, roomSize: 12, text: OTHER_ROOM_TEXT, images: [photo(40)] },
    );
    expect((await historyOf(h, 9000001)).map((v) => v.adId)).toEqual(["9000001"]);
    expect((await historyOf(h, 9000002)).map((v) => v.adId)).toEqual(["9000002"]);
  });

  it("is deleted with the Offer record", async () => {
    const { h, id } = await oneOffer();
    expect((await h.json("GET", `/offers/${id}`)).body.textHistory).toHaveLength(1);
    goStale(h);
    nights(h, 91);

    expect((await h.json("GET", `/offers/${id}`)).status).toBe(404);
    expect(h.runtime.db.select().from(offerTexts).all()).toEqual([]);
  });
});
