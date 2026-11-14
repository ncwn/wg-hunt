import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { offerAds, offers, searchMatches, seenAds } from "../src/db/schema.js";
import { adPage } from "./dedupe-harness.js";
import { adapterFixture } from "./fixtures/search-pages.js";
import { bootOffers, HOUR } from "./offers-harness.js";
import { DAY, goStale, nights, oneOffer, recordExists } from "./retention-harness.js";
import { berlin, bootSweep } from "./sweep-harness.js";

describe("an Offer that comes back and goes quiet again between two prunes", () => {
  it("keeps the record 90 days from when it was last shown, not from the old quiet spell", async () => {
    const { h, id, adId } = await oneOffer();
    goStale(h);
    nights(h, 85);

    h.site.cards = h.freshCards([Number(adId)]);
    await h.crawl();
    const back = (await h.json("GET", `/offers/${id}`)).body;
    expect(back.stale).toBe(false);
    expect(back.retention.state).toBe("not-quiet");
    const shownAt = h.clock.now;

    h.clock.now += 6 * HOUR;
    const [search] = (await h.json("GET", "/searches")).body.items;
    await h.json("PATCH", `/searches/${search.id}`, { enabled: false });
    const quiet = (await h.json("GET", `/offers/${id}`)).body.retention;
    expect.soft(new Date(quiet.recordExpiresAt).getTime()).toBeGreaterThan(shownAt + 89 * DAY);

    nights(h, 10);
    expect(recordExists(h, id)).toBe(true);
  });

  it("keeps the record when the room is taken the day it was bumped back", async () => {
    const { h, id, adId } = await oneOffer();
    goStale(h);
    nights(h, 85);

    h.site.cards = h.freshCards([Number(adId)]);
    await h.crawl();
    expect((await h.json("GET", `/offers/${id}`)).body.stale).toBe(false);
    const shownAt = h.clock.now;

    h.clock.now += 4 * HOUR;
    h.site.pages.set(Number(adId), adapterFixture("deactivated"));
    expect((await h.call("POST", `/offers/${id}/recheck`)).status).toBe(202);
    await h.crawl();
    const after = (await h.json("GET", `/offers/${id}`)).body;
    expect(after.stale).toBe(true);
    expect
      .soft(new Date(after.retention.recordExpiresAt).getTime())
      .toBeGreaterThan(shownAt + 89 * DAY);

    nights(h, 10);
    expect(recordExists(h, id)).toBe(true);
  });

  it("counts an Untracked Offer's days from when its Search was turned off the second time", async () => {
    const { h, id, adId } = await oneOffer();
    const [search] = (await h.json("GET", "/searches")).body.items;
    await h.json("PATCH", `/searches/${search.id}`, { enabled: false });
    nights(h, 3);
    expect((await h.json("GET", `/offers/${id}`)).body.retention.state).toBe("expiring");

    h.site.cards = [{ id: Number(adId), age: "3 Tage", title: `Zimmer ${adId}` }];
    await h.json("PATCH", `/searches/${search.id}`, { enabled: true });
    await h.crawl();
    expect((await h.json("GET", `/offers/${id}`)).body.retention.state).toBe("not-quiet");

    h.clock.now += 6 * HOUR;
    await h.json("PATCH", `/searches/${search.id}`, { enabled: false });

    nights(h, 89);
    expect(recordExists(h, id)).toBe(true);
    nights(h, 2);
    expect(recordExists(h, id)).toBe(false);
  });
});

describe("a room a merge shows again", () => {
  it("keeps the record 90 days from the Recheck that finds it taken the same day", async () => {
    const h = bootOffers();
    const [fresh, stale] = ["9000001", "9000002"];
    h.site.cards = h.freshCards([Number(fresh), Number(stale)]);
    for (const adId of [fresh, stale]) h.site.pages.set(Number(adId), adPage({ adId: +adId }));
    await h.addSearch();
    await h.crawl();
    const { items } = (await h.json("GET", "/offers")).body;
    expect(items).toHaveLength(1);
    const room = items[0].id as number;
    const db = h.runtime.db;
    db.update(offerAds)
      .set({ lastBumpAt: new Date(h.clock.now - 20 * DAY) })
      .where(eq(offerAds.adId, stale))
      .run();
    expect((await h.call("POST", `/offers/${room}/recheck`)).status).toBe(202);
    h.site.cards = [];
    h.site.pages.set(Number(fresh), adapterFixture("deactivated"));

    db.delete(searchMatches).where(eq(searchMatches.adId, fresh)).run();
    const half = 77;
    const row = db.select().from(offers).where(eq(offers.id, room)).get();
    if (row === undefined) throw new Error("expected the room's Offer");
    db.insert(offers)
      .values({ ...row, id: half })
      .run();
    db.update(offerAds).set({ offerId: half }).where(eq(offerAds.adId, fresh)).run();
    const long = new Date(h.clock.now - 85 * DAY);
    db.update(offers).set({ quietSince: long, recordClockSince: long }).run();

    expect(h.runtime.offers.dedupePass()).toBe(1);
    expect((await h.json("GET", `/offers/${room}`)).body.retention.state).toBe("not-quiet");

    h.clock.now += 4 * HOUR;
    await h.crawl();
    const after = (await h.json("GET", `/offers/${room}`)).body;
    expect(after.stale).toBe(true);
    const recheckedAt = h.clock.now;
    expect(new Date(after.retention.recordExpiresAt).getTime()).toBeGreaterThan(
      recheckedAt + 89 * DAY,
    );

    nights(h, 10);
    expect(recordExists(h, room)).toBe(true);
  });
});

describe("a Stale Offer a Sweep sights every day on a deep page", () => {
  it("keeps the clocks of the night it was first found quiet", async () => {
    const h = bootSweep({ pageSize: 1 });
    h.site.listing = h.cards(9001000, 3);
    await h.addSearch();
    await h.crawlUntil(berlin(4, 23));
    const { id, lastBumpAt } = await h.offerOf(9001002);
    const quietAt = Date.parse(lastBumpAt) + 7 * DAY;
    // From now on the cards show the day they were published: no sighting is a Bump.
    h.site.listing = h.site.listing.map((card) => ({ ...card, age: "02.11.2026" }));

    const row = () => h.runtime.db.select().from(offers).where(eq(offers.id, id)).get();
    const lastSeen = () =>
      h.runtime.db.select().from(seenAds).where(eq(seenAds.adId, "9001002")).get()?.lastSeenAt;
    await h.crawlUntil(quietAt + DAY);
    h.runtime.retention.prune();
    const { quietSince, recordClockSince } = row() ?? {};
    expect(quietSince).toBeInstanceOf(Date);
    expect(recordClockSince).toBeInstanceOf(Date);

    let sighted = 0;
    for (let night = 0; night < 5; night++) {
      const day = h.clock.now;
      await h.crawlUntil(day + DAY);
      sighted = (lastSeen()?.getTime() ?? 0) > day ? sighted + 1 : sighted;
      h.runtime.retention.prune();
    }

    expect(sighted).toBeGreaterThanOrEqual(4);
    expect(row()).toMatchObject({ quietSince, recordClockSince });
  });
});
