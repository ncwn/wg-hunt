import { describe, expect, it } from "vitest";
import { searchMatches } from "../src/db/schema.js";
import { fetchedAd, ROOM_TEXT_EDITED } from "./dedupe-harness.js";
import { bootOffers, HOUR, offerPageWith } from "./offers-harness.js";

type Boot = ReturnType<typeof bootOffers>;
type Listed = { id: number; title: string; band: string; hiddenBecause: string | null };

async function crawled(...rents: number[]): Promise<{ h: Boot; ids: number[] }> {
  const h = bootOffers();
  const adIds = rents.map((_, i) => 9000001 + i);
  h.site.cards = h.freshCards(adIds);
  rents.forEach((warmRent, i) => {
    h.site.pages.set(9000001 + i, offerPageWith({ title: `Room ${i + 1}`, warmRent }));
  });
  await h.addSearch();
  await h.crawl();
  const items = (await h.json("GET", "/offers")).body.items as Listed[];
  const ids = adIds.map((_, i) => {
    const found = items.find((item) => item.title === `Room ${i + 1}`);
    if (!found) throw new Error("the crawl missed a room");
    return found.id;
  });
  return { h, ids };
}

const listed = async (h: Boot, query = "") =>
  ((await h.json("GET", `/offers${query}`)).body.items as Listed[]).map((o) => o.title);

describe("PATCH /offers/{id}/marks", () => {
  it("starts with no marks", async () => {
    const { h, ids } = await crawled(450);
    const { body } = await h.json("GET", `/offers/${ids[0]}`);
    expect(body.marks).toEqual({ dismissed: false, shortlisted: false, contacted: false });
  });

  it("sets and clears Shortlisted and Contacted, which only show", async () => {
    const { h, ids } = await crawled(450);
    const shortlisted = await h.json("PATCH", `/offers/${ids[0]}/marks`, { shortlisted: true });
    expect(shortlisted.status).toBe(200);
    expect(shortlisted.body.marks).toEqual({
      dismissed: false,
      shortlisted: true,
      contacted: false,
    });
    expect(shortlisted.body.band).toBe("match");

    const both = await h.json("PATCH", `/offers/${ids[0]}/marks`, { contacted: true });
    expect(both.body.marks).toEqual({ dismissed: false, shortlisted: true, contacted: true });

    const cleared = await h.json("PATCH", `/offers/${ids[0]}/marks`, {
      shortlisted: false,
      contacted: false,
    });
    expect(cleared.body.marks).toEqual({ dismissed: false, shortlisted: false, contacted: false });
  });

  it("shows the marks on the list too, and keeps them over a restart", async () => {
    const { h, ids } = await crawled(450);
    await h.json("PATCH", `/offers/${ids[0]}/marks`, { shortlisted: true });
    expect((await h.json("GET", "/offers")).body.items[0].marks.shortlisted).toBe(true);
    h.runtime.close();

    const again = bootOffers({ dataDir: h.dataDir });
    expect((await again.json("GET", `/offers/${ids[0]}`)).body.marks.shortlisted).toBe(true);
  });

  it("lists only the shortlist with ?shortlisted=true, Hidden ones too", async () => {
    const { h, ids } = await crawled(450, 520, 480);
    await h.json("PATCH", `/offers/${ids[0]}/marks`, { shortlisted: true });
    await h.json("PATCH", `/offers/${ids[2]}/marks`, { shortlisted: true, dismissed: true });

    expect(await listed(h, "?shortlisted=true")).toEqual(["Room 1", "Room 3"]);
    expect(await listed(h, "?shortlisted=true&band=match")).toEqual(["Room 1"]);
    expect(await listed(h, "?shortlisted=false")).toEqual(["Room 2", "Room 1"]);
  });

  it("hides a Dismissed Offer from the list and says why", async () => {
    const { h, ids } = await crawled(450, 520);
    const dismissed = await h.json("PATCH", `/offers/${ids[0]}/marks`, { dismissed: true });
    expect(dismissed.body).toMatchObject({ band: "hidden", hiddenBecause: "dismissed" });

    expect(await listed(h)).toEqual(["Room 2"]);
    expect(await listed(h, "?includeHidden=true")).toEqual(["Room 2", "Room 1"]);
  });

  it("brings a Dismissed Offer back when the mark is taken off", async () => {
    const { h, ids } = await crawled(450);
    await h.json("PATCH", `/offers/${ids[0]}/marks`, { dismissed: true });
    const back = await h.json("PATCH", `/offers/${ids[0]}/marks`, { dismissed: false });
    expect(back.body).toMatchObject({ band: "match", hiddenBecause: null });
    expect(await listed(h)).toEqual(["Room 1"]);
  });

  it("announces the band change a Dismiss makes", async () => {
    const { h, ids } = await crawled(450);
    h.events.length = 0;
    await h.json("PATCH", `/offers/${ids[0]}/marks`, { dismissed: true });
    expect(h.events.filter((e) => e.type === "offer-band-changed")).toEqual([
      {
        type: "offer-band-changed",
        data: {
          offerId: ids[0],
          band: "hidden",
          previousBand: "match",
          bandChangedAt: new Date(h.clock.now).toISOString(),
        },
      },
    ]);
  });

  it("changes only the marks it is sent, the scam mark among them, on the one route", async () => {
    const { h, ids } = await crawled(450);
    await h.json("PATCH", `/offers/${ids[0]}/marks`, { shortlisted: true });

    const scam = await h.json("PATCH", `/offers/${ids[0]}/marks`, { scam: "scam" });
    expect(scam.body.marks).toEqual({ dismissed: false, shortlisted: true, contacted: false });
    expect(scam.body.band).toBe("warned");

    const both = await h.json("PATCH", `/offers/${ids[0]}/marks`, {
      scam: "clear",
      contacted: true,
    });
    expect(both.body.marks).toEqual({ dismissed: false, shortlisted: true, contacted: true });
    expect(both.body.band).toBe("match");
  });

  it("refuses an empty change, a mark it does not know and an Offer that is not there", async () => {
    const { h, ids } = await crawled(450);
    const empty = await h.json("PATCH", `/offers/${ids[0]}/marks`, {});
    expect(empty.status).toBe(400);
    expect(empty.body.type).toBe("validation-error");
    expect((await h.json("PATCH", `/offers/${ids[0]}/marks`, { dismissed: "yes" })).status).toBe(
      400,
    );
    const missing = await h.json("PATCH", "/offers/999/marks", { dismissed: true });
    expect(missing.status).toBe(404);
    expect(missing.body.type).toBe("not-found");
  });
});

describe("a Dismissed Offer stays Dismissed", () => {
  it("when its Duplicate is posted later", async () => {
    const h = bootOffers();
    await h.addSearch();
    // The Search that found the first Ad ID still matches it, so the Offer is Tracked.
    h.runtime.db
      .insert(searchMatches)
      .values({
        searchId: 1,
        source: "wg-gesucht",
        adId: "9000001",
        lastSeenAt: new Date(h.clock.now),
      })
      .run();
    h.runtime.offers.ingest(fetchedAd(h, { adId: 9000001, title: "Room 1" }));
    const [offer] = (await h.json("GET", "/offers")).body.items as Listed[];
    if (!offer) throw new Error("expected an Offer");
    await h.json("PATCH", `/offers/${offer.id}/marks`, { dismissed: true });
    expect(await listed(h)).toEqual([]);

    const result = h.runtime.offers.ingest(
      fetchedAd(h, { adId: 9000099, title: "Room 1", text: ROOM_TEXT_EDITED }, HOUR),
    );
    expect(result).toMatchObject({ outcome: "merged", offerId: offer.id });

    expect(await listed(h)).toEqual([]);
    const after = (await h.json("GET", `/offers/${offer.id}`)).body;
    expect(after.ads).toHaveLength(2);
    expect(after).toMatchObject({ band: "hidden", hiddenBecause: "dismissed" });
  });

  it("when the seeker says another Offer is the same room", async () => {
    const { h, ids } = await crawled(450, 520);
    await h.json("PATCH", `/offers/${ids[1]}/marks`, { dismissed: true, contacted: true });

    const merged = await h.json("POST", `/offers/${ids[0]}/merge`, { offerId: ids[1] });
    expect(merged.status).toBe(200);
    expect(merged.body.marks).toEqual({ dismissed: true, shortlisted: false, contacted: true });
    expect(merged.body.hiddenBecause).toBe("dismissed");
  });
});
