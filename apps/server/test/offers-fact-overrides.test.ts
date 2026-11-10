import type { Source, SourceAdapter } from "@wg-hunt/core";
import { fakeProvider, outputWith, sure, unsure } from "@wg-hunt/core/analysis/testing";
import { wgGesuchtSource } from "@wg-hunt/core/sources/wg-gesucht";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { storeFetchedPage } from "../src/crawl/detail-fetch.js";
import { createSnapshotStore } from "../src/crawl/snapshots.js";
import { offerAds, offerFactOverrides, offers as offerRows } from "../src/db/schema.js";
import { createOffers } from "../src/offers/offers.js";
import {
  type FetchedAd,
  fetchedAd,
  ingestAds,
  OTHER_ROOM_TEXT,
  photo,
  ROOM_TEXT_EDITED,
} from "./dedupe-harness.js";
import { adapterFixture, offerPageWith } from "./fixtures/search-pages.js";
import { bootOffers } from "./offers-harness.js";
import { HOUR, MINUTE, settledRooms } from "./recheck-harness.js";

const KEY = "sk-ant-api03-test-key-do-not-leak-0123456789";

async function bootAnalysed(
  scripts = [
    outputWith({ anmeldung: { value: "not_possible", ...sure("Anmeldung ist möglich") } }),
  ],
) {
  const fake = fakeProvider(scripts);
  const h = bootOffers({ analysis: { providerFor: () => fake.provider, sleep: async () => {} } });
  await h.call("PUT", "/secrets/anthropic", { value: KEY });
  const profile = (await h.json("GET", "/profile")).body;
  await h.json("PUT", "/profile", { ...profile, anmeldungNeeded: true });
  h.site.cards = h.freshCards([9000001]);
  await h.addSearch();
  await h.crawl();
  await h.runtime.analysis.idle();
  const id = (await h.json("GET", "/offers?includeHidden=true")).body.items[0].id as number;
  return { h, id, fake };
}

describe("PUT /offers/{id}/facts/{fact}", () => {
  it("sets the value with origin manual, over the model's, and re-bands the Offer at once", async () => {
    const { h, id } = await bootAnalysed();
    const before = await h.json("GET", `/offers/${id}`);
    expect(before.body).toMatchObject({ band: "hidden", hiddenBecause: null });
    expect(before.body.facts.anmeldung.origin).toBe("text");

    const res = await h.json("PUT", `/offers/${id}/facts/anmeldung`, { value: "possible" });

    expect(res.status).toBe(200);
    expect(res.body.facts.anmeldung).toEqual({
      value: "possible",
      origin: "manual",
      quote: "",
      alternatives: [{ value: "not_possible", origin: "text", quote: "Anmeldung ist möglich" }],
    });
    expect(res.body.band).toBe("match");
    expect((await h.json("GET", "/offers")).body.items.map((o: { id: number }) => o.id)).toEqual([
      id,
    ]);
  });

  it("announces the band change like any other re-banding", async () => {
    const { h, id } = await bootAnalysed();
    h.events.length = 0;
    await h.json("PUT", `/offers/${id}/facts/anmeldung`, { value: "possible" });
    expect(h.events.filter((e) => e.type === "offer-band-changed")).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ offerId: id, band: "match", previousBand: "hidden" }),
      }),
    ]);
  });

  it("wins over a rule fact too, and shows in the key facts", async () => {
    const { h, id } = await bootAnalysed();
    const res = await h.json("PUT", `/offers/${id}/facts/warmRent`, {
      value: { amount: 777, converted: false },
    });
    expect(res.status).toBe(200);
    expect(res.body.facts.warmRent).toMatchObject({
      value: { amount: 777, converted: false },
      origin: "manual",
      alternatives: [expect.objectContaining({ origin: "field" })],
    });
    expect(res.body.keyFacts.warmRent).toEqual({ amount: 777, converted: false });
  });

  it("is never Doubtful, so it can make a Match where a Doubtful reading could not", async () => {
    const { h, id } = await bootAnalysed([
      outputWith({
        anmeldung: { value: "possible", ...unsure("Anmeldung ist möglich") },
      }),
    ]);
    const doubtful = await h.json("GET", `/offers/${id}`);
    expect(doubtful.body.facts.anmeldung.confidence.status).toBe("doubtful");
    expect(doubtful.body.band).toBe("near-match");

    const res = await h.json("PUT", `/offers/${id}/facts/anmeldung`, { value: "possible" });
    expect(res.body.facts.anmeldung.confidence).toBeUndefined();
    expect(res.body.band).toBe("match");
  });

  it("sets a fact the model has not read yet, and a list fact as a list of values", async () => {
    const h = bootOffers();
    h.site.cards = h.freshCards([9000001]);
    await h.addSearch();
    await h.crawl();
    const id = (await h.json("GET", "/offers?includeHidden=true")).body.items[0].id as number;

    const anmeldung = await h.json("PUT", `/offers/${id}/facts/anmeldung`, {
      value: "conditional",
    });
    expect(anmeldung.body.facts.anmeldung).toMatchObject({
      value: "conditional",
      origin: "manual",
    });

    const signals = await h.json("PUT", `/offers/${id}/facts/scamSignals`, {
      value: ["keys_by_post"],
    });
    expect(signals.body.facts.scamSignals).toEqual([
      { value: "keys_by_post", origin: "manual", quote: "" },
    ]);
    expect(signals.body.band).toBe("warned");
    expect(signals.body.scam.signals).toHaveLength(1);
  });

  it("refuses a value the fact cannot have, a fact it does not know, and a fact that does not apply", async () => {
    const { h, id } = await bootAnalysed();
    const bad = await h.json("PUT", `/offers/${id}/facts/anmeldung`, { value: "maybe" });
    expect(bad.status).toBe(400);
    expect(bad.body.type).toBe("validation-error");
    expect(bad.body.errors[0].path).toBe("value");

    expect((await h.json("PUT", `/offers/${id}/facts/favouriteColour`, { value: 1 })).status).toBe(
      400,
    );
    expect((await h.json("PUT", `/offers/${id}/facts/conflicts`, { value: [] })).status).toBe(400);
    // The fixture Offer is a flatshare room: a rooms count is for flats and houses.
    expect((await h.json("PUT", `/offers/${id}/facts/rooms`, { value: 3 })).status).toBe(400);
    expect((await h.json("PUT", `/offers/${id}/facts/anmeldung`, {})).status).toBe(400);
  });

  it("is a 404 for an Offer that is not there", async () => {
    const { h } = await bootAnalysed();
    const res = await h.json("PUT", "/offers/9999/facts/anmeldung", { value: "possible" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /offers/{id}/facts/{fact}", () => {
  it("reverts to the model's value and re-bands the Offer at once", async () => {
    const { h, id } = await bootAnalysed();
    await h.json("PUT", `/offers/${id}/facts/anmeldung`, { value: "possible" });

    const res = await h.json("DELETE", `/offers/${id}/facts/anmeldung`);

    expect(res.status).toBe(200);
    expect(res.body.facts.anmeldung).toMatchObject({ value: "not_possible", origin: "text" });
    expect(res.body.band).toBe("hidden");
  });

  it("reverts a rule fact to the field's value", async () => {
    const { h, id } = await bootAnalysed();
    const original = (await h.json("GET", `/offers/${id}`)).body.facts.warmRent;
    await h.json("PUT", `/offers/${id}/facts/warmRent`, { value: { amount: 1, converted: false } });
    const res = await h.json("DELETE", `/offers/${id}/facts/warmRent`);
    expect(res.body.facts.warmRent).toEqual(original);
  });

  it("does not mind a fact that has no override", async () => {
    const { h, id } = await bootAnalysed();
    expect((await h.json("DELETE", `/offers/${id}/facts/anmeldung`)).status).toBe(200);
    expect((await h.json("DELETE", "/offers/9999/facts/anmeldung")).status).toBe(404);
  });
});

describe("an override outlasts the readings it replaced", () => {
  it("survives a re-analysis, which still shows the new reading as the alternative", async () => {
    const { h, id } = await bootAnalysed([
      outputWith({ anmeldung: { value: "not_possible", ...sure("Anmeldung ist möglich") } }),
      outputWith({ anmeldung: { value: "conditional", ...sure("Anmeldung ist möglich") } }),
    ]);
    await h.json("PUT", `/offers/${id}/facts/anmeldung`, { value: "possible" });

    expect((await h.json("POST", `/offers/${id}/reanalyze`)).status).toBe(202);
    await h.runtime.analysis.idle();

    const { body } = await h.json("GET", `/offers/${id}`);
    expect(body.analysis.analyzedAt).not.toBeNull();
    expect(body.facts.anmeldung).toMatchObject({
      value: "possible",
      origin: "manual",
      alternatives: [{ value: "conditional", origin: "text", quote: "Anmeldung ist möglich" }],
    });
    expect(body.band).toBe("match");

    const reverted = await h.json("DELETE", `/offers/${id}/facts/anmeldung`);
    expect(reverted.body.facts.anmeldung).toMatchObject({ value: "conditional", origin: "text" });
  });

  it("survives a Recheck that reads a changed page", async () => {
    const w = await settledRooms(9003000, 3);
    const id = (await w.offerOf(9003001)).id as number;
    await w.json("PUT", `/offers/${id}/facts/baseRent`, {
      value: { amount: 321, converted: false },
    });

    w.bump(
      9003001,
      { title: "Zimmer 9003001, jetzt günstiger" },
      { title: "Frisch renoviert", warmRent: 450 },
    );
    await w.crawlUntil(w.clock.now + 2 * HOUR);

    const { body } = await w.json("GET", `/offers/${id}`);
    expect(body.title).toBe("Frisch renoviert");
    expect(body.facts.baseRent).toMatchObject({
      value: { amount: 321, converted: false },
      origin: "manual",
    });
    expect(body.facts.warmRent.value.amount).toBe(450);
  });

  it("survives the rules being read again from the stored pages", async () => {
    const { h, id } = await bootAnalysed();
    await h.json("PUT", `/offers/${id}/facts/roomSize`, { value: 25 });
    const next = wgGesuchtSource.rulesVersion + 1;
    const improved: SourceAdapter = {
      ...wgGesuchtSource,
      rulesVersion: next,
      parseOffer(html, ctx) {
        const parsed = wgGesuchtSource.parseOffer(html, ctx);
        if (parsed.outcome !== "parsed" || parsed.status === "deleted") return parsed;
        return {
          ...parsed,
          rulesVersion: next,
          facts: {
            ...parsed.facts,
            roomSize: { value: 20, origin: "field", quote: "Zimmergröße: 20m²" },
          },
        };
      },
    };
    const offers = createOffers({
      db: h.runtime.db,
      adapters: { "wg-gesucht": improved },
      snapshots: createSnapshotStore(h.dataDir),
      clock: () => h.clock.now,
    });

    expect(await offers.reparseOutdated()).toMatchObject({ done: 1 });

    const { body } = await h.json("GET", `/offers/${id}`);
    expect(body.rulesVersion).toBe(next);
    expect(body.facts.roomSize).toMatchObject({
      value: 25,
      origin: "manual",
      alternatives: [{ value: 20, origin: "field" }],
    });
    expect(body.keyFacts.size).toBe(25);
  });

  it("is kept over a restart", async () => {
    const { h, id } = await bootAnalysed();
    await h.json("PUT", `/offers/${id}/facts/anmeldung`, { value: "possible" });
    h.runtime.close();
    const again = bootOffers({ dataDir: h.dataDir });
    const { body } = await again.json("GET", `/offers/${id}`);
    expect(body.facts.anmeldung).toMatchObject({ value: "possible", origin: "manual" });
  });

  it("moves to the surviving Offer when two Offers are merged", async () => {
    const h = bootOffers();
    h.site.cards = h.freshCards([9000001, 9000002]);
    h.site.pages.set(9000001, offerPageWith({ title: "Room one", warmRent: 450 }));
    h.site.pages.set(9000002, offerPageWith({ title: "Other room", warmRent: 600 }));
    await h.addSearch();
    await h.crawl();
    const items = (await h.json("GET", "/offers")).body.items as { id: number; title: string }[];
    const keep = items.find((o) => o.title === "Room one")?.id as number;
    const drop = items.find((o) => o.title === "Other room")?.id as number;
    await h.json("PUT", `/offers/${drop}/facts/anmeldung`, { value: "possible" });
    await h.json("PUT", `/offers/${keep}/facts/furnished`, { value: "furnished" });

    const merged = await h.json("POST", `/offers/${keep}/merge`, { offerId: drop });

    expect(merged.body.facts.anmeldung).toMatchObject({ value: "possible", origin: "manual" });
    expect(merged.body.facts.furnished).toMatchObject({ value: "furnished", origin: "manual" });
  });
});

describe("GET /offers/overrides", () => {
  it("lists the corrections in the shape `pnpm eval export-overrides` reads", async () => {
    const { h, id } = await bootAnalysed();
    await h.json("PUT", `/offers/${id}/facts/anmeldung`, { value: "possible" });
    await h.json("PUT", `/offers/${id}/facts/minimumStay`, { value: 6 });
    await h.json("PUT", `/offers/${id}/facts/scamSignals`, { value: [] });

    const { status, body } = await h.json("GET", "/offers/overrides");

    expect(status).toBe(200);
    expect(body.items).toEqual([
      expect.objectContaining({
        source: "wg-gesucht",
        adId: "9000001",
        key: "anmeldung",
        value: "possible",
      }),
      expect.objectContaining({
        source: "wg-gesucht",
        adId: "9000001",
        key: "minimumStay",
        value: 6,
      }),
      expect.objectContaining({
        source: "wg-gesucht",
        adId: "9000001",
        key: "scamSignals",
        value: [],
      }),
    ]);
    expect(body.items[0].offerId).toBe(id);
  });

  it("is empty until the seeker corrects something", async () => {
    const h = bootOffers();
    expect((await h.json("GET", "/offers/overrides")).body).toEqual({ items: [] });
  });
});

const RETITLED_VERSION = wgGesuchtSource.rulesVersion + 1;
const RETITLED: SourceAdapter = {
  ...wgGesuchtSource,
  rulesVersion: RETITLED_VERSION,
  parseOffer(html, ctx) {
    const parsed = wgGesuchtSource.parseOffer(html, ctx);
    if (parsed.outcome !== "parsed" || parsed.status === "deleted") return parsed;
    return {
      ...parsed,
      rulesVersion: RETITLED_VERSION,
      text: { ...parsed.text, title: `${parsed.text.title} (read anew)` },
    };
  },
};

/** The Offers of `h`, read by rules that read the title differently. */
function retitled(h: ReturnType<typeof bootOffers>) {
  return createOffers({
    db: h.runtime.db,
    adapters: { "wg-gesucht": RETITLED },
    snapshots: createSnapshotStore(h.dataDir),
    clock: () => h.clock.now,
  });
}

type Offers = ReturnType<typeof createOffers>;

function readAnew(fetched: FetchedAd, html = fetched.html): FetchedAd {
  const parsed = RETITLED.parseOffer(html, {
    firstSeen: new Date(fetched.fetchedAt),
    category: fetched.category,
  });
  if (parsed.outcome !== "parsed") throw new Error("unreadable");
  return { ...fetched, html, parsed };
}

/** As a crawl hands on a page it fetched, with `offers` behind it. */
function arrives(
  h: ReturnType<typeof bootOffers>,
  offers: Offers,
  fetched: FetchedAd,
  beforeReplace: (ad: { source: Source; adId: string }) => void = offers.reparseIfOutdated,
) {
  storeFetchedPage(
    { db: h.runtime.db, snapshots: h.runtime.snapshots, beforeReplace },
    {
      source: fetched.source,
      adId: fetched.adId,
      html: fetched.html,
      deleted: fetched.parsed.status === "deleted",
      fetchedAt: fetched.fetchedAt,
    },
  );
  return offers.ingest(fetched);
}

describe("where a correction was made", () => {
  const overrideOf = async (h: Pick<ReturnType<typeof bootOffers>, "json">, key: string) =>
    ((await h.json("GET", "/offers/overrides")).body.items as Record<string, unknown>[]).find(
      (item) => item.key === key,
    );

  it("names the Ad ID and words it was made on, which are still the ones shown", async () => {
    const { h, id } = await bootAnalysed();
    await h.json("PUT", `/offers/${id}/facts/anmeldung`, { value: "possible" });
    const textHash = (await h.json("GET", `/offers/${id}`)).body.ads[0].textHash as string;

    expect(await overrideOf(h, "anmeldung")).toMatchObject({
      madeOn: { source: "wg-gesucht", adId: "9000001", textHash },
      wordsChanged: false,
      adCount: 1,
    });
  });

  it("is unknown for a correction stored before it was recorded", async () => {
    const { h, id } = await bootAnalysed();
    h.runtime.db
      .insert(offerFactOverrides)
      .values({ offerId: id, fact: "anmeldung", value: '"possible"', createdAt: new Date(0) })
      .run();

    expect(await overrideOf(h, "anmeldung")).toMatchObject({
      adId: "9000001",
      madeOn: null,
      wordsChanged: null,
    });
  });

  it("says the words changed after a Recheck reads an edited page", async () => {
    const w = await settledRooms(9003000, 3);
    const id = (await w.offerOf(9003001)).id as number;
    await w.json("PUT", `/offers/${id}/facts/baseRent`, {
      value: { amount: 321, converted: false },
    });
    const before = await overrideOf(w, "baseRent");
    expect(before).toMatchObject({ madeOn: { adId: "9003001" }, wordsChanged: false });

    w.bump(
      9003001,
      { title: "Zimmer 9003001, jetzt günstiger" },
      { title: "Frisch renoviert", warmRent: 450 },
    );
    await w.crawlUntil(w.clock.now + 2 * HOUR);

    const after = await overrideOf(w, "baseRent");
    expect(after).toMatchObject({ madeOn: before?.madeOn, wordsChanged: true });
  });

  it("keeps the Ad ID it was made on when a merge makes another one current", async () => {
    const h = bootOffers();
    const [first, second] = ingestAds(
      h,
      { adId: 9000001, warmRent: 450, roomSize: 18 },
      { adId: 9000002, warmRent: 400, roomSize: 12, text: OTHER_ROOM_TEXT, images: [photo(40)] },
    ).map((ingested) => ingested.offerId);
    await h.json("PUT", `/offers/${first}/facts/anmeldung`, { value: "possible" });

    await h.json("POST", `/offers/${first}/merge`, { offerId: second });

    expect(await overrideOf(h, "anmeldung")).toMatchObject({
      offerId: first,
      adId: "9000002",
      madeOn: { adId: "9000001" },
      wordsChanged: true,
      adCount: 2,
    });
  });

  it("keeps when and where it was made when its Offer is merged into another", async () => {
    const h = bootOffers();
    const [first, second] = ingestAds(
      h,
      { adId: 9000001, warmRent: 450, roomSize: 18 },
      { adId: 9000002, warmRent: 400, roomSize: 12, text: OTHER_ROOM_TEXT, images: [photo(40)] },
    ).map((ingested) => ingested.offerId);
    await h.json("PUT", `/offers/${second}/facts/anmeldung`, { value: "possible" });
    const before = await overrideOf(h, "anmeldung");
    h.clock.now += HOUR;

    await h.json("POST", `/offers/${first}/merge`, { offerId: second });

    expect(await overrideOf(h, "anmeldung")).toMatchObject({
      offerId: first,
      createdAt: before?.createdAt,
      madeOn: { adId: "9000002" },
    });
  });

  it("is not read as the words changing when new rules read the same page differently", async () => {
    const { h, id } = await bootAnalysed();
    await h.json("PUT", `/offers/${id}/facts/roomSize`, { value: 25 });
    const offers = retitled(h);
    const before = (await h.json("GET", `/offers/${id}`)).body.ads[0].textHash;

    expect(await offers.reparseOutdated()).toMatchObject({ done: 1 });

    const { body } = await h.json("GET", `/offers/${id}`);
    expect(body.ads[0].textHash).not.toBe(before);
    expect(body.corrections).toEqual([
      expect.objectContaining({
        key: "roomSize",
        madeOn: expect.objectContaining({ textHash: body.ads[0].textHash }),
        wordsChanged: false,
      }),
    ]);
  });

  describe("when a page arrives before new rules have re-read its Offer", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    async function corrected() {
      const h = bootOffers();
      const fetched = fetchedAd(h, { adId: 9000001 });
      const id = arrives(h, h.runtime.offers, fetched).offerId as number;
      await h.json("PUT", `/offers/${id}/facts/roomSize`, { value: 25 });
      const before = (await h.json("GET", `/offers/${id}`)).body;
      return { h, id, fetched, before };
    }

    it("is not read as the words changing when the words are the same", async () => {
      const { h, id, fetched } = await corrected();
      const offers = retitled(h);

      arrives(h, offers, readAnew({ ...fetched, fetchedAt: fetched.fetchedAt + HOUR }));

      expect(await offers.reparseOutdated()).toMatchObject({ done: 0 });
      const { body } = await h.json("GET", `/offers/${id}`);
      expect(body.rulesVersion).toBe(RETITLED_VERSION);
      expect(body.corrections).toEqual([
        expect.objectContaining({
          key: "roomSize",
          madeOn: expect.objectContaining({ textHash: body.ads[0].textHash }),
          wordsChanged: false,
        }),
      ]);
    });

    it("says the words changed when the page was edited", async () => {
      const { h, id } = await corrected();

      arrives(
        h,
        retitled(h),
        readAnew(fetchedAd(h, { adId: 9000001, text: ROOM_TEXT_EDITED }, HOUR)),
      );

      const { body } = await h.json("GET", `/offers/${id}`);
      expect(body.corrections).toEqual([expect.objectContaining({ wordsChanged: true })]);
    });

    it("is not read as the words changing when the page is of a twin, not the current Ad ID", async () => {
      const h = bootOffers();
      const title = "Zimmer in der WG";
      const twin = fetchedAd(h, { adId: 9000001, title });
      const id = arrives(h, h.runtime.offers, twin).offerId as number;
      await h.json("PUT", `/offers/${id}/facts/roomSize`, { value: 25 });
      const repost = arrives(
        h,
        h.runtime.offers,
        fetchedAd(h, { adId: 9000002, title }, 10 * MINUTE),
      );
      expect(repost).toMatchObject({ outcome: "merged", offerId: id });
      const offers = retitled(h);

      arrives(h, offers, readAnew(twin));
      await offers.reparseOutdated();

      const { body } = await h.json("GET", `/offers/${id}`);
      const madeOn = body.ads.find((ad: { adId: string }) => ad.adId === "9000001");
      expect(body.ads.find((ad: { current: boolean }) => ad.current).adId).toBe("9000002");
      expect(body.corrections).toEqual([
        expect.objectContaining({
          madeOn: expect.objectContaining({ adId: "9000001", textHash: madeOn.textHash }),
          wordsChanged: false,
        }),
      ]);
    });

    it("re-reads nothing for a page that says the ad was deleted", async () => {
      const { h, id, fetched, before } = await corrected();
      const reads = vi.spyOn(RETITLED, "parseOffer");
      const html = adapterFixture("deleted");
      const deleted = readAnew({ ...fetched, fetchedAt: fetched.fetchedAt + HOUR }, html);
      expect(deleted.parsed).toMatchObject({ status: "deleted" });
      reads.mockClear();

      arrives(h, retitled(h), deleted);

      expect(reads).not.toHaveBeenCalled();
      const { body } = await h.json("GET", `/offers/${id}`);
      expect(body.rulesVersion).toBe(before.rulesVersion);
      expect(body.corrections).toEqual(before.corrections);
    });

    it("re-reads nothing for an Offer already on the newest rules", async () => {
      const { h, id, fetched } = await corrected();
      const offers = retitled(h);
      await offers.reparseOutdated();
      const before = (await h.json("GET", `/offers/${id}`)).body;
      const again = readAnew({ ...fetched, fetchedAt: fetched.fetchedAt + HOUR });
      const reads = vi.spyOn(RETITLED, "parseOffer");

      arrives(h, offers, again);

      expect(reads).not.toHaveBeenCalled();
      expect((await h.json("GET", `/offers/${id}`)).body.corrections).toEqual(before.corrections);
    });

    it("still stores and reads the page when the re-read fails", async () => {
      const { h, id } = await corrected();
      vi.spyOn(console, "error").mockImplementation(() => {});
      const edited = readAnew(fetchedAd(h, { adId: 9000001, text: ROOM_TEXT_EDITED }, HOUR));
      const offers = retitled(h);

      arrives(h, offers, edited, () => {
        throw new Error("disk gone");
      });

      expect(h.runtime.snapshots.read("wg-gesucht", "9000001")).toBe(edited.html);
      const { body } = await h.json("GET", `/offers/${id}`);
      expect(body.title).toBe("Zimmer 9000001 (read anew)");
      expect(body.ads[0].textHash).not.toBe(null);
    });

    it("is re-read when a Recheck brings a page whose Offer was read by older rules", async () => {
      const { h, id } = await bootAnalysed();
      await h.json("PUT", `/offers/${id}/facts/roomSize`, { value: 25 });
      const { db } = h.runtime;
      db.update(offerRows)
        .set({ rulesVersion: wgGesuchtSource.rulesVersion - 1 })
        .where(eq(offerRows.id, id))
        .run();
      db.update(offerAds).set({ contentHash: "an older reading" }).run();
      db.update(offerFactOverrides).set({ contentHash: "an older reading" }).run();

      expect((await h.call("POST", `/offers/${id}/recheck`)).status).toBe(202);
      await h.crawl();

      const { body } = await h.json("GET", `/offers/${id}`);
      expect(body.corrections).toEqual([
        expect.objectContaining({
          madeOn: expect.objectContaining({ textHash: body.ads[0].textHash }),
          wordsChanged: false,
        }),
      ]);
    });
  });

  it("keeps the page's new hash and the correction's in step when the second write fails", async () => {
    const { h, id } = await bootAnalysed();
    await h.json("PUT", `/offers/${id}/facts/roomSize`, { value: 25 });
    const before = (await h.json("GET", `/offers/${id}`)).body.ads[0].textHash;
    h.runtime.db.$client.exec(
      "CREATE TRIGGER no_rehash BEFORE UPDATE OF contentHash ON offer_fact_overrides BEGIN SELECT RAISE(ABORT, 'disk gone'); END",
    );

    expect(await retitled(h).reparseOutdated()).toMatchObject({ failed: 1 });

    expect((await h.json("GET", `/offers/${id}`)).body.ads[0].textHash).toBe(before);
    h.runtime.db.$client.exec("DROP TRIGGER no_rehash");
    expect(await retitled(h).reparseOutdated()).toMatchObject({ done: 1 });
    const { body } = await h.json("GET", `/offers/${id}`);
    expect(body.corrections).toEqual([expect.objectContaining({ wordsChanged: false })]);
  });
});

describe("the detail of an Offer", () => {
  it("lists which facts are overridden, so the pane can offer to revert them", async () => {
    const { h, id } = await bootAnalysed();
    await h.json("PUT", `/offers/${id}/facts/anmeldung`, { value: "possible" });
    const { body } = await h.json("GET", `/offers/${id}`);
    expect(body.overrides).toEqual(["anmeldung"]);
  });

  it("serves each correction with when and where it was made", async () => {
    const { h, id } = await bootAnalysed();
    await h.json("PUT", `/offers/${id}/facts/minimumStay`, { value: 6 });
    await h.json("PUT", `/offers/${id}/facts/anmeldung`, { value: "possible" });
    const { body } = await h.json("GET", `/offers/${id}`);
    const madeOn = { source: "wg-gesucht", adId: "9000001", textHash: body.ads[0].textHash };
    expect(body.overrides).toEqual(["anmeldung", "minimumStay"]);
    expect(body.corrections).toEqual([
      { key: "anmeldung", createdAt: expect.any(String), madeOn, wordsChanged: false },
      { key: "minimumStay", createdAt: expect.any(String), madeOn, wordsChanged: false },
    ]);
  });
});
