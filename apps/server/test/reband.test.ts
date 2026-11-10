import { describe, expect, it } from "vitest";
import { REBAND_EVERY_MS } from "../src/offers/offers.js";
import { bootOffers, HOUR, MINUTE } from "./offers-harness.js";

const DAY = 24 * HOUR;

type Boot = ReturnType<typeof bootOffers>;
type Listed = { id: number; title: string; band: string; bandChangedAt: string };

async function threeRooms(): Promise<Boot> {
  const h = bootOffers();
  h.site.cards = h.freshCards([9000001, 9000002, 9000003]);
  await h.addSearch();
  await h.crawl();
  return h;
}

const writes = (h: Boot) =>
  (h.runtime.db.$client.prepare("SELECT total_changes() AS n").get() as { n: number }).n;

async function readEverything(h: Boot, since?: number): Promise<void> {
  const query = since === undefined ? "" : `&since=${new Date(since).toISOString()}`;
  const { items } = (await h.json("GET", `/offers?includeHidden=true${query}`)).body;
  await h.json("GET", `/offers/counts${query.replace("&", "?")}`);
  for (const offer of items as Listed[]) await h.json("GET", `/offers/${offer.id}`);
}

const bandChanges = (h: Boot) => h.events.filter((e) => e.type === "offer-band-changed");

describe("reading Offers", () => {
  it("writes nothing and publishes nothing while no band has moved", async () => {
    const h = await threeRooms();
    const before = writes(h);
    h.events.length = 0;

    await readEverything(h);
    h.clock.now += 6 * DAY;
    await readEverything(h);
    await readEverything(h, h.clock.now - HOUR);

    expect(writes(h)).toBe(before);
    expect(h.events).toEqual([]);
  });

  it("records a move only time caused on the first read after it, once, so the band agrees with its cause", async () => {
    const h = await threeRooms();
    h.events.length = 0;
    h.clock.now += 8 * DAY;
    const looked = h.clock.now;

    expect((await h.json("GET", "/offers")).body.items).toEqual([]);
    expect((await h.json("GET", "/offers/counts")).body.bands).toMatchObject({
      match: 0,
      hidden: 3,
    });
    const hidden = (await h.json("GET", "/offers?band=hidden")).body.items as Listed[];
    expect(hidden.map((o) => o.bandChangedAt)).toEqual(
      Array(3).fill(new Date(looked).toISOString()),
    );
    expect(bandChanges(h)).toHaveLength(3);

    const before = writes(h);
    await readEverything(h);
    expect(writes(h)).toBe(before);
    expect(bandChanges(h)).toHaveLength(3);
  });
});

describe("the periodic re-band", () => {
  it("stores an Offer past its 7-day Stale line as Hidden, with no read made, and announces it once", async () => {
    const h = bootOffers();
    h.site.cards = h.freshCards([9000001]);
    await h.addSearch();
    await h.crawl();
    h.events.length = 0;

    h.clock.now += 8 * DAY;
    const tickedAt = h.clock.now;
    h.runtime.offers.tick();

    const [offer] = (await h.json("GET", "/offers?band=hidden")).body.items as Listed[];
    expect(offer?.bandChangedAt).toBe(new Date(tickedAt).toISOString());
    expect(bandChanges(h)).toEqual([
      {
        type: "offer-band-changed",
        data: {
          offerId: offer?.id,
          band: "hidden",
          previousBand: "match",
          bandChangedAt: new Date(tickedAt).toISOString(),
        },
      },
    ]);
  });

  it("makes ?since= and the counts follow the move", async () => {
    const h = await threeRooms();
    h.clock.now += 8 * DAY;
    const looked = new Date(h.clock.now).toISOString();
    h.clock.now += MINUTE;

    h.runtime.offers.tick();

    expect((await h.json("GET", "/offers/counts")).body.bands).toMatchObject({
      match: 0,
      hidden: 3,
    });
    const since = (await h.json("GET", `/offers?band=hidden&since=${looked}`)).body.items;
    expect(since).toHaveLength(3);
    expect((await h.json("GET", `/offers/counts?since=${looked}`)).body.new).toBe(0);
  });

  it("waits for its interval since the last re-band", async () => {
    const h = await threeRooms();
    const [first] = (await h.json("GET", "/offers")).body.items as Listed[];
    const { lastBumpAt } = (await h.json("GET", `/offers/${first?.id}`)).body;
    const staleLine = Date.parse(lastBumpAt) + 7 * DAY;
    h.clock.now = staleLine - MINUTE;
    h.runtime.offers.tick();
    const lastReband = h.clock.now;
    h.events.length = 0;

    h.clock.now = staleLine + MINUTE;
    h.runtime.offers.tick();
    h.clock.now = lastReband + REBAND_EVERY_MS - 1;
    h.runtime.offers.tick();
    expect(bandChanges(h)).toEqual([]);

    h.clock.now = lastReband + REBAND_EVERY_MS;
    h.runtime.offers.tick();
    expect(bandChanges(h)).toHaveLength(3);
  });
});

describe("starting the periodic re-band", () => {
  it("re-bands at once, so a move made while the server was off is recorded at the start", async () => {
    const h = await threeRooms();
    h.events.length = 0;
    h.clock.now += 8 * DAY;

    h.runtime.offers.start();
    h.runtime.offers.stop();

    expect(bandChanges(h)).toHaveLength(3);
    expect((await h.json("GET", "/offers/counts")).body.bands).toMatchObject({ hidden: 3 });
  });
});

describe("a finished Sweep", () => {
  it("re-bands every Offer, so one that went Stale unseen is stored as Hidden without a read", async () => {
    const h = await threeRooms();
    const gone = (await h.json("GET", "/offers/lookup?adId=9000003")).body as Listed;
    h.events.length = 0;

    h.clock.now += 8 * DAY;
    h.site.cards = h.freshCards([9000001, 9000002]);
    await h.crawl(DAY);

    expect(bandChanges(h).map((e) => e.data)).toEqual([
      expect.objectContaining({ offerId: gone?.id, band: "hidden", previousBand: "match" }),
    ]);
  });
});
