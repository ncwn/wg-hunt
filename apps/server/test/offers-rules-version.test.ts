import { rmSync } from "node:fs";
import { join } from "node:path";
import type { SourceAdapter } from "@wg-hunt/core";
import { wgGesuchtSource } from "@wg-hunt/core/sources/wg-gesucht";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { storeFetchedPage } from "../src/crawl/detail-fetch.js";
import { createSnapshotStore } from "../src/crawl/snapshots.js";
import { offerAds, offers } from "../src/db/schema.js";
import { createOffers } from "../src/offers/offers.js";
import { type FetchedAd, fetchedAd, OTHER_ROOM_TEXT } from "./dedupe-harness.js";
import { bootOffers } from "./offers-harness.js";

async function crawledOffer() {
  const h = bootOffers();
  h.site.cards = h.freshCards([9000001]);
  await h.addSearch();
  await h.crawl();
  const id = (await h.json("GET", "/offers")).body.items[0].id as number;
  return { h, id };
}

const CURRENT = wgGesuchtSource.rulesVersion;
const NEXT = CURRENT + 1;

const improvedAdapter: SourceAdapter = {
  ...wgGesuchtSource,
  rulesVersion: NEXT,
  parseOffer(html, ctx) {
    const parsed = wgGesuchtSource.parseOffer(html, ctx);
    if (parsed.outcome !== "parsed" || parsed.status === "deleted") return parsed;
    return {
      ...parsed,
      rulesVersion: NEXT,
      facts: {
        ...parsed.facts,
        roomSize: { value: 20, origin: "field", quote: "Zimmergröße: 20m²" },
      },
    };
  },
};

function offersWith(h: Awaited<ReturnType<typeof crawledOffer>>["h"], adapter: SourceAdapter) {
  return createOffers({
    db: h.runtime.db,
    adapters: { "wg-gesucht": adapter },
    snapshots: createSnapshotStore(h.dataDir),
    clock: () => h.clock.now,
  });
}

describe("bumping the rules version", () => {
  it("re-parses the stored pages and stamps the new version", async () => {
    const { h, id } = await crawledOffer();
    expect((await h.json("GET", `/offers/${id}`)).body).toMatchObject({
      rulesVersion: CURRENT,
      facts: { roomSize: { value: 18 } },
    });

    const reparsed = await offersWith(h, improvedAdapter).reparseOutdated();

    expect(reparsed).toMatchObject({ done: 1 });
    const { body } = await h.json("GET", `/offers/${id}`);
    expect(body.rulesVersion).toBe(NEXT);
    expect(body.facts.roomSize.value).toBe(20);
    expect(body.keyFacts.size).toBe(20);
  });

  it("leaves what the pages never showed alone: first-seen time, Ad IDs, price history", async () => {
    const { h, id } = await crawledOffer();
    const before = (await h.json("GET", `/offers/${id}`)).body;

    await offersWith(h, improvedAdapter).reparseOutdated();

    const after = (await h.json("GET", `/offers/${id}`)).body;
    expect(after).toMatchObject({
      id,
      firstSeenAt: before.firstSeenAt,
      ads: before.ads,
      priceHistory: before.priceHistory,
    });
  });

  it("fills the content hash of the Ad ID again", async () => {
    const { h } = await crawledOffer();
    const hashOf = () => h.runtime.db.select().from(offerAds).get()?.contentHash;
    const stored = hashOf();
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    h.runtime.db.update(offerAds).set({ contentHash: null }).run();

    await offersWith(h, improvedAdapter).reparseOutdated();

    expect(hashOf()).toBe(stored);
  });

  it("does nothing once every Offer carries the current version", async () => {
    const { h } = await crawledOffer();
    const service = offersWith(h, improvedAdapter);
    expect(await service.reparseOutdated()).toMatchObject({ done: 1 });
    expect(await service.reparseOutdated()).toMatchObject({ done: 0 });
  });

  it("keeps the older facts of an Offer whose stored page is gone", async () => {
    const { h, id } = await crawledOffer();
    rmSync(join(h.dataDir, "offer-pages", "wg-gesucht", "9000001.html.gz"));

    expect(await offersWith(h, improvedAdapter).reparseOutdated()).toMatchObject({
      done: 0,
      skipped: 1,
    });

    const { body } = await h.json("GET", `/offers/${id}`);
    expect(body.rulesVersion).toBe(CURRENT);
    expect(body.facts.roomSize.value).toBe(18);
  });

  it("happens by itself when the server starts", async () => {
    const first = await crawledOffer();
    // Facts as an older build's rules left them.
    first.h.runtime.db
      .update(offers)
      .set({
        rulesVersion: 0,
        facts: JSON.stringify({ roomSize: { value: 99, origin: "field", quote: "old" } }),
      })
      .where(eq(offers.id, first.id))
      .run();
    first.h.runtime.close();

    const restarted = bootOffers({ dataDir: first.h.dataDir });
    await restarted.runtime.catchUp;

    const { body } = await restarted.json("GET", `/offers/${first.id}`);
    expect(body.rulesVersion).toBe(wgGesuchtSource.rulesVersion);
    expect(body.facts.roomSize.value).toBe(18);
  });
});

describe("a page that arrives before the new rules have re-read its Offer", () => {
  /** Reads the 12 m² room as in another postal code, so it is no longer a room of the same flat. */
  const movedAdapter: SourceAdapter = {
    ...wgGesuchtSource,
    rulesVersion: NEXT,
    parseOffer(html, ctx) {
      const parsed = wgGesuchtSource.parseOffer(html, ctx);
      if (parsed.outcome !== "parsed" || parsed.status === "deleted") return parsed;
      const small = parsed.facts.roomSize?.value === 12;
      return {
        ...parsed,
        rulesVersion: NEXT,
        facts: {
          ...parsed.facts,
          ...(small && { postalCode: { value: "99999", origin: "field", quote: "99999" } }),
        },
      };
    },
  };

  function arrives(
    h: ReturnType<typeof bootOffers>,
    service: ReturnType<typeof createOffers>,
    fetched: FetchedAd,
  ) {
    storeFetchedPage(
      {
        db: h.runtime.db,
        snapshots: h.runtime.snapshots,
        beforeReplace: service.reparseIfOutdated,
      },
      { ...fetched, deleted: false },
    );
    return service.ingest(fetched);
  }

  const reparsed = (fetched: FetchedAd): FetchedAd => {
    const parsed = movedAdapter.parseOffer(fetched.html, {
      firstSeen: new Date(fetched.fetchedAt),
      category: fetched.category,
    });
    if (parsed.outcome !== "parsed") throw new Error("unreadable");
    return { ...fetched, parsed };
  };

  it("links its Offer to others as the new rules read it", async () => {
    const h = bootOffers();
    const pages = [
      fetchedAd(h, { adId: 9000001, roomSize: 18 }),
      fetchedAd(h, { adId: 9000002, roomSize: 12, text: OTHER_ROOM_TEXT }),
    ];
    const [first, second] = pages.map((page) => arrives(h, h.runtime.offers, page).offerId);
    const siblingsOf = async (id: number | null | undefined) =>
      (await h.json("GET", `/offers/${id}`)).body.siblings.map(
        (sibling: { offer: { id: number } }) => sibling.offer.id,
      );
    expect(await siblingsOf(first)).toEqual([second]);

    const service = offersWith(h, movedAdapter);
    for (const page of pages) arrives(h, service, reparsed(page));

    expect(await service.reparseOutdated()).toMatchObject({ done: 0 });
    expect(await siblingsOf(first)).toEqual([]);
    expect(await siblingsOf(second)).toEqual([]);
  });
});
