import { describe, expect, it } from "vitest";
import { bootOffers, offerPageWith } from "./offers-harness.js";

describe("GET /offers after a crawl", () => {
  it("lists the Offers the crawl found, newest first, with their key facts", async () => {
    const h = bootOffers();
    h.site.cards = h.freshCards([9000001, 9000002]);
    h.site.pages.set(9000001, offerPageWith({ title: "Zimmer am Park", warmRent: 450 }));
    h.site.pages.set(9000002, offerPageWith({ title: "Zimmer am Kanal", warmRent: 520 }));
    await h.addSearch();

    await h.crawl();

    const { status, body } = await h.json("GET", "/offers");
    expect(status).toBe(200);
    expect(body.nextCursor).toBeNull();
    // Both were first seen by the same poll; the later fetch is the newer Offer.
    expect(body.items.map((o: { title: string }) => o.title)).toEqual([
      "Zimmer am Kanal",
      "Zimmer am Park",
    ]);
    const park = body.items.find((o: { title: string }) => o.title === "Zimmer am Park");
    expect(park).toEqual({
      id: expect.any(Number),
      category: "flatshare-room",
      title: "Zimmer am Park",
      firstSeenAt: new Date(h.clock.now - 30 * 60_000).toISOString(),
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      lastBumpAt: expect.any(String),
      pageStatus: "active",
      stale: false,
      tracked: true,
      analysisState: "pending",
      analysisStatus: {
        status: "waiting-for-key",
        next: "add-key",
        reason: null,
        at: null,
        willRead: false,
      },
      marks: { dismissed: false, shortlisted: false, contacted: false },
      distance: null,
      band: "match",
      bandChangedAt: park.createdAt,
      reasons: [],
      chips: [],
      hiddenBecause: null,
      visibility: { hidden: [], actions: { recheck: true, undismiss: false } },
      url: "https://www.wg-gesucht.de/wg-zimmer-in-Teststadt-Mitte.9000001.html",
      keyFacts: {
        warmRent: { amount: 450, converted: false },
        size: 18,
        district: "Testviertel",
        availableFrom: "2026-12-01",
      },
    });
  });
});
