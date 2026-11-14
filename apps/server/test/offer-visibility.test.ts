import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { offerAds, offers } from "../src/db/schema.js";
import { bootOffers, HOUR, MINUTE } from "./offers-harness.js";

const DAY = 24 * HOUR;

type Boot = ReturnType<typeof bootOffers>;

async function oneOffer(): Promise<{ h: Boot; id: number }> {
  const h = bootOffers();
  h.site.cards = h.freshCards([9000001]);
  await h.addSearch();
  await h.crawl();
  const { items } = (await h.json("GET", "/offers")).body;
  expect(items).toHaveLength(1);
  h.events.length = 0;
  return { h, id: items[0].id as number };
}

const bandChanges = (h: Boot) =>
  h.events.filter((e) => e.type === "offer-band-changed").map((e) => e.data);

const writes = (h: Boot) =>
  (h.runtime.db.$client.prepare("SELECT total_changes() AS n").get() as { n: number }).n;

async function searchId(h: Boot): Promise<number> {
  const [search] = (await h.json("GET", "/searches")).body.items as { id: number }[];
  if (search === undefined) throw new Error("no Search");
  return search.id;
}

describe("a band never contradicts its hidden cause", () => {
  it("shows an Offer that went Stale by age as Hidden on the very next read, before any re-band", async () => {
    const { h, id } = await oneOffer();
    h.clock.now += 8 * DAY;
    const readAt = new Date(h.clock.now).toISOString();

    const offer = (await h.json("GET", `/offers/${id}`)).body;
    expect(offer).toMatchObject({ band: "hidden", hiddenBecause: "stale", stale: true });
    expect(offer.bandChangedAt).toBe(readAt);
    expect((await h.json("GET", "/offers")).body.items).toEqual([]);
    expect((await h.json("GET", "/offers/counts")).body.bands).toMatchObject({
      match: 0,
      hidden: 1,
    });
    expect(bandChanges(h)).toEqual([
      { offerId: id, band: "hidden", previousBand: "match", bandChangedAt: readAt },
    ]);
  });

  it("records nothing more on a second read", async () => {
    const { h, id } = await oneOffer();
    h.clock.now += 8 * DAY;
    await h.json("GET", `/offers?includeHidden=true`);
    const before = writes(h);
    h.events.length = 0;

    await h.json("GET", `/offers?includeHidden=true`);
    await h.json("GET", "/offers/counts");
    await h.json("GET", `/offers/${id}`);

    expect(writes(h)).toBe(before);
    expect(h.events).toEqual([]);
  });

  it("lists every Offer in the band its causes say, list and counts alike", async () => {
    const { h } = await oneOffer();
    h.clock.now += 8 * DAY;
    const { items } = (await h.json("GET", "/offers?includeHidden=true")).body;
    for (const item of items as { band: string; visibility: { hidden: unknown[] } }[]) {
      if (item.visibility.hidden.length > 0) expect(item.band).toBe("hidden");
    }
  });
});

describe("Dismiss is remembered whatever the cause", () => {
  it("records a Dismiss made while the Offer is Untracked, and announces nothing when it is tracked again", async () => {
    const { h, id } = await oneOffer();
    const search = await searchId(h);
    await h.json("PATCH", `/searches/${search}`, { enabled: false });
    h.events.length = 0;

    const dismissed = await h.json("PATCH", `/offers/${id}/marks`, { dismissed: true });
    expect(dismissed.body).toMatchObject({ band: "hidden", hiddenBecause: "untracked" });
    expect(dismissed.body.visibility.hidden.map((c: { cause: string }) => c.cause)).toEqual([
      "untracked",
      "dismissed",
    ]);
    expect(bandChanges(h)).toEqual([]);
    const stored = h.runtime.db.select().from(offers).where(eq(offers.id, id)).get();
    expect(stored?.band).toBe("hidden");

    h.events.length = 0;
    await h.json("PATCH", `/searches/${search}`, { enabled: true });
    await h.crawl();
    const back = (await h.json("GET", `/offers/${id}`)).body;
    expect(back).toMatchObject({ band: "hidden", hiddenBecause: "dismissed", tracked: true });
    expect(bandChanges(h)).toEqual([]);
  });

  it("brings an Untracked Offer back in its band once tracked again when nothing else changed", async () => {
    const { h, id } = await oneOffer();
    const search = await searchId(h);
    await h.json("PATCH", `/searches/${search}`, { enabled: false });
    expect((await h.json("GET", `/offers/${id}`)).body).toMatchObject({
      band: "hidden",
      hiddenBecause: "untracked",
    });
    await h.json("PATCH", `/searches/${search}`, { enabled: true });
    await h.crawl();
    expect((await h.json("GET", `/offers/${id}`)).body).toMatchObject({
      band: "match",
      hiddenBecause: null,
    });
    expect(bandChanges(h)).toEqual([]);
  });
});

describe("the preview and the counts agree", () => {
  it("counts the same bands before a draft as GET /offers/counts, also when a move only time caused is pending", async () => {
    const { h } = await oneOffer();
    h.clock.now += 8 * DAY;
    const preview = (await h.json("POST", "/ranking/preview", {})).body;
    const counts = (await h.json("GET", "/offers/counts")).body;
    expect(preview.counts.before).toEqual(counts.bands);
    expect(preview.counts.before).toMatchObject({ hidden: 1, match: 0 });
  });
});

describe("a full re-band counts only the moves it records", () => {
  it("does not count an Untracked Offer as moved", async () => {
    const { h } = await oneOffer();
    await h.json("PATCH", `/searches/${await searchId(h)}`, { enabled: false });
    expect(h.runtime.offers.rebandAll()).toBe(0);
    expect(bandChanges(h)).toEqual([]);
  });
});

describe("band events wait for the write to commit", () => {
  it("publishes nothing when an outer transaction rolls the write back", async () => {
    const { h, id } = await oneOffer();
    expect(() =>
      h.runtime.db.$client.transaction(() => {
        h.runtime.offers.setMarks(id, { dismissed: true });
        throw new Error("a later step failed");
      })(),
    ).toThrow("a later step failed");
    await Promise.resolve();
    expect(bandChanges(h)).toEqual([]);
    expect((await h.json("GET", `/offers/${id}`)).body.band).toBe("match");
  });

  it("publishes after the outer transaction commits", async () => {
    const { h, id } = await oneOffer();
    h.runtime.db.$client.transaction(() => {
      h.runtime.offers.setMarks(id, { dismissed: true });
      expect(bandChanges(h)).toEqual([]);
    })();
    await Promise.resolve();
    expect(bandChanges(h)).toEqual([
      expect.objectContaining({ offerId: id, band: "hidden", previousBand: "match" }),
    ]);
  });
});

describe("every hidden cause, with its sub-cause, since-time and what ends it", () => {
  it("is empty for a shown Offer, which may be dismissed and rechecked", async () => {
    const { h, id } = await oneOffer();
    expect((await h.json("GET", `/offers/${id}`)).body.visibility).toEqual({
      hidden: [],
      actions: { recheck: true, undismiss: false },
    });
  });

  it("says when an Offer aged out and that a Bump ends it", async () => {
    const { h, id } = await oneOffer();
    const { lastBumpAt } = (await h.json("GET", `/offers/${id}`)).body;
    h.clock.now += 8 * DAY;
    expect((await h.json("GET", `/offers/${id}`)).body.visibility.hidden).toEqual([
      {
        cause: "stale",
        why: "aged",
        since: new Date(Date.parse(lastBumpAt) + 7 * DAY).toISOString(),
        endsWhen: "bumped",
      },
    ]);
  });

  it("names a deactivated page and a deleted one", async () => {
    const { h, id } = await oneOffer();
    h.runtime.db.update(offerAds).set({ pageStatus: "deactivated" }).run();
    expect((await h.json("GET", `/offers/${id}`)).body.visibility.hidden).toEqual([
      { cause: "stale", why: "deactivated", since: null, endsWhen: "reactivated" },
    ]);
    h.runtime.db.update(offerAds).set({ pageStatus: "deleted" }).run();
    expect((await h.json("GET", `/offers/${id}`)).body.visibility.hidden).toEqual([
      { cause: "stale", why: "deleted", since: null, endsWhen: "reposted" },
    ]);
  });

  it("keeps Dismissed beside Stale, with when it was dismissed, and offers to undo it", async () => {
    const { h, id } = await oneOffer();
    h.clock.now += HOUR;
    const dismissedAt = new Date(h.clock.now).toISOString();
    await h.json("PATCH", `/offers/${id}/marks`, { dismissed: true });
    h.runtime.db.update(offerAds).set({ pageStatus: "deactivated" }).run();

    const stale = (await h.json("GET", `/offers/${id}`)).body;
    expect(stale.hiddenBecause).toBe("stale");
    expect(stale.visibility).toEqual({
      hidden: [
        { cause: "stale", why: "deactivated", since: null, endsWhen: "reactivated" },
        { cause: "dismissed", since: dismissedAt, endsWhen: "undismissed" },
      ],
      actions: { recheck: true, undismiss: true },
    });

    h.runtime.db.update(offerAds).set({ pageStatus: "active" }).run();
    const back = (await h.json("GET", `/offers/${id}`)).body;
    expect(back.hiddenBecause).toBe("dismissed");
    expect(back.visibility.hidden).toEqual([
      { cause: "dismissed", since: dismissedAt, endsWhen: "undismissed" },
    ]);

    const undone = (await h.json("PATCH", `/offers/${id}/marks`, { dismissed: false })).body;
    expect(undone.visibility).toEqual({
      hidden: [],
      actions: { recheck: true, undismiss: false },
    });
  });

  it("lists Untracked with what ends it, and no Recheck while no Search matches", async () => {
    const { h, id } = await oneOffer();
    await h.json("PATCH", `/searches/${await searchId(h)}`, { enabled: false });
    expect((await h.json("GET", `/offers/${id}`)).body.visibility).toEqual({
      hidden: [{ cause: "untracked", since: null, endsWhen: "a-search-matches" }],
      actions: { recheck: false, undismiss: false },
    });
    expect((await h.json("POST", `/offers/${id}/recheck`)).status).toBe(409);
  });
});

describe("the Recheck action follows the same rule as automatic Rechecks", () => {
  it("is refused when the Offer is tracked only through an Ad ID other than the one a Recheck would fetch", async () => {
    const { h, id } = await oneOffer();
    h.runtime.db
      .insert(offerAds)
      .values({
        source: "wg-gesucht",
        adId: "9000099",
        offerId: id,
        path: "/wg-zimmer-in-Berlin-Mitte.9000099.html",
        firstSeenAt: new Date(h.clock.now),
        lastBumpAt: new Date(h.clock.now + MINUTE),
        pageStatus: "active",
      })
      .run();
    h.clock.now += 2 * MINUTE;

    const offer = (await h.json("GET", `/offers/${id}`)).body;
    expect(offer.tracked).toBe(true);
    expect(offer.ads.find((ad: { current: boolean }) => ad.current)?.adId).toBe("9000099");
    expect(offer.visibility.actions.recheck).toBe(false);
    expect((await h.json("POST", `/offers/${id}/recheck`)).status).toBe(409);
  });
});
