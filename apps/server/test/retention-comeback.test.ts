import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { offers, seenAds } from "../src/db/schema.js";
import { adapterFixture } from "./fixtures/search-pages.js";
import { HOUR } from "./offers-harness.js";
import { DAY, goStale, nights, oneOffer, recordExists } from "./retention-harness.js";
import { berlin, bootSweep } from "./sweep-harness.js";

describe("an Offer that comes back and goes quiet again between two prunes", () => {
  it("keeps the record 90 days from when it was last shown, not from the old quiet spell", async () => {
    const { h, id, adId } = await oneOffer();
    goStale(h);
    nights(h, 85);

    // The Ad ID is bumped and a poll sees it: the Offer is shown again.
    h.site.cards = h.freshCards([Number(adId)]);
    await h.crawl();
    const back = (await h.json("GET", `/offers/${id}`)).body;
    expect(back.stale).toBe(false);
    expect(back.retention.state).toBe("not-quiet");
    const shownAt = h.clock.now;

    // The same evening the seeker turns the Search off, so the Offer is Untracked before 03:00.
    h.clock.now += 6 * HOUR;
    const [search] = (await h.json("GET", "/searches")).body.items;
    await h.json("PATCH", `/searches/${search.id}`, { enabled: false });
    const quiet = (await h.json("GET", `/offers/${id}`)).body.retention;
    // What the API promises: 90 days from about now, since it was shown hours ago.
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

    // Taken that afternoon: a Recheck finds the page deactivated, so the Offer is Stale again.
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

    // Turned on again, the Search reads the card as it was, not Bumped: only its match brings the
    // Offer back.
    h.site.cards = [{ id: Number(adId), age: "3 Tage", title: `Zimmer ${adId}` }];
    await h.json("PATCH", `/searches/${search.id}`, { enabled: true });
    await h.crawl();
    expect((await h.json("GET", `/offers/${id}`)).body.retention.state).toBe("not-quiet");

    h.clock.now += 6 * HOUR;
    await h.json("PATCH", `/searches/${search.id}`, { enabled: false });

    // Counted from the first time it was turned off, it would be gone before these end.
    nights(h, 89);
    expect(recordExists(h, id)).toBe(true);
    nights(h, 2);
    expect(recordExists(h, id)).toBe(false);
  });
});

describe("a Stale Offer a Sweep sights every day on a deep page", () => {
  it("is still deleted 90 days after it went quiet", async () => {
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
    let sighted = 0;
    while (row() !== undefined && h.clock.now < quietAt + 120 * DAY) {
      const day = h.clock.now;
      await h.crawlUntil(day + DAY);
      sighted = (lastSeen()?.getTime() ?? 0) > day ? sighted + 1 : sighted;
      h.runtime.retention.prune();
    }

    expect(row()).toBeUndefined();
    expect(h.clock.now - quietAt).toBeGreaterThan(90 * DAY);
    expect(h.clock.now - quietAt).toBeLessThanOrEqual(92 * DAY);
    expect(sighted).toBeGreaterThan(90);
  });
});
