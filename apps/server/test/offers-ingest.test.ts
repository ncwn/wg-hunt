import { wgGesuchtSource } from "@wg-hunt/core/sources/wg-gesucht";
import { describe, expect, it } from "vitest";
import type { FetchedOffer } from "../src/crawl/search-polls.js";
import { offers, seenAds } from "../src/db/schema.js";
import { adapterFixture, offerPageWith } from "./fixtures/search-pages.js";
import { bootOffers, HOUR, MINUTE } from "./offers-harness.js";

describe("what becomes an Offer", () => {
  it("never makes an Offer of a Promoted placement", async () => {
    const h = bootOffers();
    h.site.cards = [
      { id: 9000001, age: "5 Min." },
      { id: 9000002, age: "5 Min.", promoted: true },
    ];
    await h.addSearch();
    await h.crawl();

    const { body } = await h.json("GET", "/offers");
    expect(body.items).toHaveLength(1);
    expect((await h.json("GET", "/offers/lookup?adId=9000002")).body.type).toBe("not-known");
    expect(h.sent.some((path) => path.includes("9000002"))).toBe(false);
  });

  it("makes no Offer of a page the Source has deleted", async () => {
    const h = bootOffers();
    h.site.cards = h.freshCards([9000001]);
    h.site.pages.set(9000001, adapterFixture("deleted"));
    await h.addSearch();
    await h.crawl();

    expect((await h.json("GET", "/offers")).body.items).toEqual([]);
    expect((await h.json("GET", "/offers/lookup?adId=9000001")).body.type).toBe("not-known");
  });

  it("stores a deactivated page as an Offer whose page status says so", async () => {
    const h = bootOffers();
    h.site.cards = h.freshCards([9000001]);
    h.site.pages.set(9000001, adapterFixture("deactivated"));
    await h.addSearch();
    await h.crawl();

    expect((await h.json("GET", "/offers")).body.items).toEqual([]);
    const { items } = (await h.json("GET", "/offers?includeHidden=true")).body;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      pageStatus: "deactivated",
      band: "hidden",
      hiddenBecause: "stale",
    });
  });

  it("makes one Offer per Ad ID for now, however many Searches list it", async () => {
    const h = bootOffers();
    h.site.cards = h.freshCards([9000001]);
    await h.addSearch();
    await h.addSearch();
    await h.crawl(2 * HOUR);

    expect((await h.json("GET", "/offers")).body.items).toHaveLength(1);
  });
});

describe("pages stored without an Offer", () => {
  it("become Offers when the server starts, keeping the time the Ad ID was first seen", async () => {
    const first = bootOffers();
    first.site.cards = first.freshCards([9000001, 9000002]);
    await first.addSearch();
    await first.crawl();
    const before = (await first.json("GET", "/offers")).body.items;
    expect(before).toHaveLength(2);
    first.runtime.db.delete(offers).run();
    first.runtime.db.update(seenAds).set({ ingestedAt: null }).run();
    first.runtime.close();

    const restarted = bootOffers({ dataDir: first.dataDir });
    await restarted.runtime.catchUp;

    const after = (await restarted.json("GET", "/offers")).body.items;
    expect(
      after.map((o: { title: string; firstSeenAt: string }) => [o.title, o.firstSeenAt]).sort(),
    ).toEqual(
      before.map((o: { title: string; firstSeenAt: string }) => [o.title, o.firstSeenAt]).sort(),
    );
    expect(after.map((o: { url: string }) => o.url).sort()).toEqual(
      before.map((o: { url: string }) => o.url).sort(),
    );
  });

  it("leaves pages the Source has deleted without an Offer", async () => {
    const first = bootOffers();
    first.site.cards = first.freshCards([9000001]);
    first.site.pages.set(9000001, adapterFixture("deleted"));
    await first.addSearch();
    await first.crawl();
    first.runtime.close();

    const restarted = bootOffers({ dataDir: first.dataDir });
    await restarted.runtime.catchUp;

    expect((await restarted.json("GET", "/offers")).body.items).toEqual([]);
  });
});

describe("the Offer added event", () => {
  it("is published once for each new Offer, with the Offer as the list shows it", async () => {
    const h = bootOffers();
    h.site.cards = h.freshCards([9000001, 9000002]);
    await h.addSearch();
    await h.crawl();

    const added = h.events.filter((event) => event.type === "offer-added");
    expect(added).toHaveLength(2);
    const listed = (await h.json("GET", "/offers")).body.items;
    for (const event of added) {
      expect(listed).toContainEqual(event.data);
    }
  });

  it("reaches a client listening on /events", async () => {
    const h = bootOffers();
    const res = await h.call("GET", "/events");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let received = "";
    const until = async (marker: string) => {
      while (!received.includes(marker)) {
        const { value, done } = await reader.read();
        if (done) throw new Error("the stream ended");
        received += decoder.decode(value, { stream: true });
      }
    };
    await until("crawl-status-changed");

    h.site.cards = h.freshCards([9000001]);
    await h.addSearch();
    await h.crawl();
    await until("event: offer-added");
    await reader.cancel();

    const data = /event: offer-added\ndata: (.*)\n/.exec(received)?.[1] ?? "";
    expect(JSON.parse(data)).toMatchObject({ title: "Helles Zimmer in ruhiger Studenten-WG" });
  });

  it("is not published again when the same Ad ID is stored again", async () => {
    const h = bootOffers();
    h.site.cards = h.freshCards([9000001]);
    await h.addSearch();
    await h.crawl();
    expect(h.events.filter((event) => event.type === "offer-added")).toHaveLength(1);

    h.runtime.offers.ingest(
      await refetched(h, 9000001, offerPageWith({ title: "Neu", warmRent: 500 })),
    );

    expect(h.events.filter((event) => event.type === "offer-added")).toHaveLength(1);
  });
});

async function refetched(
  h: ReturnType<typeof bootOffers>,
  adId: number,
  html: string,
): Promise<FetchedOffer> {
  const parsed = wgGesuchtSource.parseOffer(html, {
    firstSeen: new Date(h.clock.now),
    category: "flatshare-room",
  });
  if (parsed.outcome !== "parsed" || parsed.status === "deleted") throw new Error("unreadable");
  return {
    source: "wg-gesucht",
    adId: String(adId),
    fetchedAt: h.clock.now + 5 * MINUTE,
    card: {
      adId: String(adId),
      path: `/wg-zimmer-in-Teststadt-Mitte.${adId}.html`,
      title: `Zimmer ${adId}`,
      advertiser: { name: "Anna", kind: "private" },
    },
    parsed,
  };
}

describe("storing an Ad ID that already has an Offer", () => {
  it("refreshes the Offer and keeps its id and first-seen time", async () => {
    const h = bootOffers();
    h.site.cards = h.freshCards([9000001]);
    await h.addSearch();
    await h.crawl();
    const before = (await h.json("GET", "/offers")).body.items[0];

    h.runtime.offers.ingest(
      await refetched(h, 9000001, offerPageWith({ title: "Neu", warmRent: 520 })),
    );

    const { items } = (await h.json("GET", "/offers")).body;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: before.id,
      firstSeenAt: before.firstSeenAt,
      title: "Neu",
    });
    expect(items[0].keyFacts.warmRent).toEqual({ amount: 520, converted: false });
  });

  it("adds a price point only when the rent changed", async () => {
    const h = bootOffers();
    h.site.cards = h.freshCards([9000001]);
    await h.addSearch();
    await h.crawl();
    const id = (await h.json("GET", "/offers")).body.items[0].id;

    h.runtime.offers.ingest(
      await refetched(h, 9000001, offerPageWith({ title: "Gleich", warmRent: 489 })),
    );
    expect((await h.json("GET", `/offers/${id}`)).body.priceHistory).toHaveLength(1);

    h.runtime.offers.ingest(
      await refetched(h, 9000001, offerPageWith({ title: "Teurer", warmRent: 520 })),
    );
    const { priceHistory } = (await h.json("GET", `/offers/${id}`)).body;
    expect(priceHistory.map((p: { warmRent: number }) => p.warmRent)).toEqual([489, 520]);
  });
});
