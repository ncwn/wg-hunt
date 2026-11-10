import { decodeCursor, encodeCursor } from "@wg-hunt/core";
import { describe, expect, it } from "vitest";
import { offerPageWith } from "./fixtures/search-pages.js";
import { bootOffers, HOUR } from "./offers-harness.js";

type Boot = ReturnType<typeof bootOffers>;
type Listed = { id: number; title: string; band: string; bandChangedAt: string; reasons: Reason[] };
type Reason = { filter: string; outcome: string; effect: string; cause: string; message: string };

const DAY = 24 * HOUR;

async function bootWithThreeRents(): Promise<Boot> {
  const h = bootOffers();
  h.site.cards = h.freshCards([9000001, 9000002, 9000003]);
  h.site.pages.set(9000001, offerPageWith({ title: "Cheap", warmRent: 450 }));
  h.site.pages.set(9000002, offerPageWith({ title: "Dear", warmRent: 520 }));
  h.site.pages.set(9000003, offerPageWith({ title: "Dearest", warmRent: 700 }));
  await h.addSearch();
  await h.crawl();
  return h;
}

const filtersOf = async (h: Boot) => (await h.json("GET", "/filters")).body;

async function withMaxRent(h: Boot, limit: number | null, margin: unknown = undefined) {
  const filters = await filtersOf(h);
  filters.maxRent.limit = limit;
  if (margin !== undefined) filters.maxRent.margin = margin;
  return filters;
}

const titles = (body: { items: Listed[] }) => body.items.map((o) => o.title);
const bandsByTitle = async (h: Boot) =>
  Object.fromEntries(
    (await h.json("GET", "/offers?includeHidden=true")).body.items.map((o: Listed) => [
      o.title,
      o.band,
    ]),
  );

describe("Seeker Profile and Filters", () => {
  it("ship the neutral defaults on a fresh install", async () => {
    const h = bootOffers();
    const profile = (await h.json("GET", "/profile")).body;
    expect(profile).toEqual({
      gender: null,
      age: null,
      anmeldungNeeded: false,
      moveIn: { earliest: null, latest: null },
      stay: { minMonths: null, maxMonths: null },
      diet: null,
      occupation: null,
      smoker: null,
      hasPets: null,
      languages: [],
      places: [],
    });
    const filters = await filtersOf(h);
    expect(filters.maxRent).toMatchObject({
      enabled: true,
      strength: "dealbreaker",
      limit: null,
      margin: { value: 10, unit: "percent" },
    });
    expect(filters.minSize).toMatchObject({ enabled: true, strength: "want", limit: null });
  });

  it("are saved and survive a restart", async () => {
    const h = bootOffers();
    const profile = { ...(await h.json("GET", "/profile")).body, gender: "woman", age: 27 };
    expect((await h.json("PUT", "/profile", profile)).body).toEqual(profile);
    const filters = await withMaxRent(h, 650, { value: 50, unit: "absolute" });
    expect((await h.json("PUT", "/filters", filters)).body).toEqual(filters);
    h.runtime.close();

    const again = bootOffers({ dataDir: h.dataDir });
    expect((await again.json("GET", "/profile")).body).toEqual(profile);
    expect((await again.json("GET", "/filters")).body).toEqual(filters);
  });

  it("reject a Profile whose move-in window or stay runs backwards", async () => {
    const h = bootOffers();
    const profile = (await h.json("GET", "/profile")).body;
    const window = await h.json("PUT", "/profile", {
      ...profile,
      moveIn: { earliest: "2027-02-01", latest: "2027-01-01" },
    });
    expect(window.status).toBe(400);
    expect(window.body.type).toBe("validation-error");
    const stay = await h.json("PUT", "/profile", {
      ...profile,
      stay: { minMonths: 12, maxMonths: 6 },
    });
    expect(stay.status).toBe(400);
    expect((await h.json("GET", "/profile")).body).toEqual(profile);
  });

  it("ship 'hide likely scams' off", async () => {
    const h = bootOffers();
    expect((await filtersOf(h)).hideLikelyScams).toEqual({
      enabled: false,
      strength: "dealbreaker",
    });
  });

  it("reject values they cannot hold", async () => {
    const h = bootOffers();
    const profile = (await h.json("GET", "/profile")).body;
    const bad = await h.json("PUT", "/profile", { ...profile, gender: "robot" });
    expect(bad.status).toBe(400);
    expect(bad.body.type).toBe("validation-error");
    const filters = await filtersOf(h);
    filters.maxRent.strength = "maybe";
    expect((await h.json("PUT", "/filters", filters)).status).toBe(400);
    expect((await h.json("GET", "/profile")).body).toEqual(profile);
  });
});

describe("GET /offers bands", () => {
  it("puts every Offer in Match while no Filter has anything to judge", async () => {
    const h = await bootWithThreeRents();
    expect(await bandsByTitle(h)).toEqual({ Cheap: "match", Dear: "match", Dearest: "match" });
  });

  it("bands by the maximum rent and its margin: EUR 500 with a EUR 50 margin", async () => {
    const h = await bootWithThreeRents();
    await h.json("PUT", "/filters", await withMaxRent(h, 500, { value: 50, unit: "absolute" }));

    expect(await bandsByTitle(h)).toEqual({
      Cheap: "match",
      Dear: "near-match",
      Dearest: "hidden",
    });
  });

  it("lists Match before Near match and leaves Hidden out unless asked", async () => {
    const h = await bootWithThreeRents();
    await h.json("PUT", "/filters", await withMaxRent(h, 500, { value: 50, unit: "absolute" }));

    expect(titles((await h.json("GET", "/offers")).body)).toEqual(["Cheap", "Dear"]);
    expect(titles((await h.json("GET", "/offers?includeHidden=true")).body)).toEqual([
      "Cheap",
      "Dear",
      "Dearest",
    ]);
    expect(titles((await h.json("GET", "/offers?band=hidden")).body)).toEqual(["Dearest"]);
    expect(titles((await h.json("GET", "/offers?band=near-match")).body)).toEqual(["Dear"]);
  });

  it("gives every Offer one reason per Filter, with the cause of the verdict", async () => {
    const h = await bootWithThreeRents();
    await h.json("PUT", "/filters", await withMaxRent(h, 500, { value: 50, unit: "absolute" }));

    const { items } = (await h.json("GET", "/offers?includeHidden=true")).body;
    const reasonOf = (title: string) =>
      items.find((o: Listed) => o.title === title).reasons as Reason[];
    expect(reasonOf("Cheap")).toEqual([
      expect.objectContaining({ filter: "maxRent", outcome: "pass", effect: "none" }),
    ]);
    expect(reasonOf("Dear")).toEqual([
      expect.objectContaining({ filter: "maxRent", outcome: "warn", cause: "within-margin" }),
    ]);
    expect(reasonOf("Dearest")).toEqual([
      expect.objectContaining({ filter: "maxRent", outcome: "fail", effect: "hidden" }),
    ]);
    const detail = (await h.json("GET", `/offers/${items[0].id}`)).body;
    expect(detail.reasons).toEqual(items[0].reasons);
    expect(detail.band).toBe(items[0].band);
  });

  it("sorts inside a band", async () => {
    const h = await bootWithThreeRents();
    const byRent = await h.json("GET", "/offers?sort=warm-rent");
    expect(titles(byRent.body)).toEqual(["Cheap", "Dear", "Dearest"]);
    const bySize = await h.json("GET", "/offers?sort=size");
    expect(bySize.status).toBe(200);
    expect((await h.json("GET", "/offers?sort=vibes")).status).toBe(400);
  });

  it("continues after its cursor when a band changes between pages, without repeating an Offer", async () => {
    const h = await bootWithThreeRents();
    await h.json("PUT", "/filters", await withMaxRent(h, 500, { value: 50, unit: "absolute" }));

    const first = (await h.json("GET", "/offers?includeHidden=true&limit=2&sort=warm-rent")).body;
    expect(titles(first)).toEqual(["Cheap", "Dear"]);
    await h.json("PUT", "/filters", await withMaxRent(h, 800));
    const second = (
      await h.json(
        "GET",
        `/offers?includeHidden=true&limit=2&sort=warm-rent&cursor=${first.nextCursor}`,
      )
    ).body;
    expect(second.items).toEqual([]);
    expect(second.nextCursor).toBeNull();
    expect(titles((await h.json("GET", "/offers?sort=warm-rent")).body)).toEqual([
      "Cheap",
      "Dear",
      "Dearest",
    ]);
  });

  it("lists an Offer again when it moves to a later band between two pages", async () => {
    const h = await bootWithThreeRents();
    const first = (await h.json("GET", "/offers?limit=1&sort=warm-rent")).body;
    expect(titles(first)).toEqual(["Cheap"]);
    await h.json("PUT", "/filters", await withMaxRent(h, 100, { value: 0, unit: "absolute" }));

    const second = (
      await h.json(
        "GET",
        `/offers?includeHidden=true&limit=5&sort=warm-rent&cursor=${first.nextCursor}`,
      )
    ).body;
    expect(titles(second)).toEqual(["Cheap", "Dear", "Dearest"]);
  });

  it("refuses a cursor under another sort, and continues the list under its own", async () => {
    const h = await bootWithThreeRents();
    const first = (await h.json("GET", "/offers?limit=1&sort=warm-rent")).body;
    expect(titles(first)).toEqual(["Cheap"]);

    for (const other of ["sort=size", "sort=recency", ""]) {
      const refused = await h.json("GET", `/offers?limit=1&${other}&cursor=${first.nextCursor}`);
      expect(refused.status).toBe(400);
      expect(refused.body.type).toBe("invalid-cursor");
    }

    const second = (
      await h.json("GET", `/offers?limit=1&sort=warm-rent&cursor=${first.nextCursor}`)
    ).body;
    expect(titles(second)).toEqual(["Dear"]);
  });

  it("refuses a cursor that names no sort", async () => {
    const h = await bootWithThreeRents();
    const keyOnly = (cursor: string) => encodeCursor({ key: decodeCursor(cursor)?.key });
    const first = (await h.json("GET", "/offers?limit=1")).body;
    const refused = await h.json("GET", `/offers?limit=1&cursor=${keyOnly(first.nextCursor)}`);
    expect(refused.status).toBe(400);
    expect(refused.body.type).toBe("invalid-cursor");
  });

  it("rejects a cursor from another list", async () => {
    const h = bootOffers();
    const foreign = Buffer.from(JSON.stringify({ createdAt: 1, id: 2 })).toString("base64url");
    const { status, body } = await h.json("GET", `/offers?cursor=${foreign}`);
    expect(status).toBe(400);
    expect(body.type).toBe("invalid-cursor");
  });
});

describe("changing a Filter", () => {
  it("re-bands the Offers at once, with no crawl request", async () => {
    const h = await bootWithThreeRents();
    const requestsBefore = h.sent.length;
    const eventsBefore = h.events.length;

    await h.json("PUT", "/filters", await withMaxRent(h, 500, { value: 50, unit: "absolute" }));

    expect(h.sent.length).toBe(requestsBefore);
    expect(await bandsByTitle(h)).toMatchObject({ Dearest: "hidden" });
    const changed = h.events.slice(eventsBefore).filter((e) => e.type === "offer-band-changed");
    expect(changed.map((e) => (e.data as { band: string }).band).sort()).toEqual([
      "hidden",
      "near-match",
    ]);
  });

  it("emits 'Offer band changed' with the old and the new band, and nothing for unchanged Offers", async () => {
    const h = await bootWithThreeRents();
    const before = (await h.json("GET", "/offers")).body.items as Listed[];
    const dearest = before.find((o) => o.title === "Dearest");
    h.events.length = 0;

    await h.json("PUT", "/filters", await withMaxRent(h, 600, { value: 0, unit: "absolute" }));

    expect(h.events).toEqual([
      {
        type: "offer-band-changed",
        data: {
          offerId: dearest?.id,
          band: "hidden",
          previousBand: "match",
          bandChangedAt: expect.any(String),
        },
      },
    ]);
  });

  it("stamps bandChangedAt, so ?since= returns the Offers that entered their band", async () => {
    const h = await bootWithThreeRents();
    const before = (await h.json("GET", "/offers")).body.items as Listed[];
    h.clock.now += 2 * HOUR;
    const looked = new Date(h.clock.now).toISOString();
    h.clock.now += HOUR;

    await h.json("PUT", "/filters", await withMaxRent(h, 500, { value: 50, unit: "absolute" }));

    const since = (await h.json("GET", `/offers?includeHidden=true&since=${looked}`)).body;
    expect(titles(since).sort()).toEqual(["Dear", "Dearest"]);
    const dear = since.items.find((o: Listed) => o.title === "Dear");
    expect(dear.bandChangedAt).toBe(new Date(h.clock.now).toISOString());
    const cheap = before.find((o) => o.title === "Cheap");
    expect(cheap?.bandChangedAt).toBeDefined();
    expect(new Date(cheap?.bandChangedAt ?? "").getTime()).toBeLessThan(Date.parse(looked));
  });

  it("changes the bands back when the Filter is switched off", async () => {
    const h = await bootWithThreeRents();
    const strict = await withMaxRent(h, 100, { value: 0, unit: "absolute" });
    await h.json("PUT", "/filters", strict);
    expect(await bandsByTitle(h)).toEqual({ Cheap: "hidden", Dear: "hidden", Dearest: "hidden" });

    strict.maxRent.enabled = false;
    await h.json("PUT", "/filters", strict);
    expect(await bandsByTitle(h)).toEqual({ Cheap: "match", Dear: "match", Dearest: "match" });
  });

  it("makes a Want move an Offer to Near match, never Hidden", async () => {
    const h = await bootWithThreeRents();
    const filters = await withMaxRent(h, 100, { value: 0, unit: "absolute" });
    filters.maxRent.strength = "want";
    await h.json("PUT", "/filters", filters);
    expect(await bandsByTitle(h)).toEqual({
      Cheap: "near-match",
      Dear: "near-match",
      Dearest: "near-match",
    });
  });
});

describe("POST /ranking/preview", () => {
  it("returns the band changes of a draft and saves nothing", async () => {
    const h = await bootWithThreeRents();
    const requestsBefore = h.sent.length;
    const eventsBefore = h.events.length;
    const savedFilters = await filtersOf(h);
    const savedProfile = (await h.json("GET", "/profile")).body;
    const draft = await withMaxRent(h, 500, { value: 50, unit: "absolute" });

    const { status, body } = await h.json("POST", "/ranking/preview", { filters: draft });

    expect(status).toBe(200);
    expect(body.changes).toEqual([
      expect.objectContaining({ title: expect.any(String), from: "match", to: "near-match" }),
      expect.objectContaining({ title: expect.any(String), from: "match", to: "hidden" }),
    ]);
    expect(body.changes.map((c: { title: string }) => c.title).sort()).toEqual(["Dear", "Dearest"]);
    expect(body.counts).toEqual({
      before: { match: 3, "near-match": 0, warned: 0, hidden: 0 },
      after: { match: 1, "near-match": 1, warned: 0, hidden: 1 },
    });
    expect(await filtersOf(h)).toEqual(savedFilters);
    expect((await h.json("GET", "/profile")).body).toEqual(savedProfile);
    expect(await bandsByTitle(h)).toEqual({ Cheap: "match", Dear: "match", Dearest: "match" });
    expect(h.events.length).toBe(eventsBefore);
    expect(h.sent.length).toBe(requestsBefore);
  });

  it("previews a draft Profile against the saved Filters", async () => {
    const h = await bootWithThreeRents();
    await h.json("PUT", "/filters", {
      ...(await filtersOf(h)),
      anmeldung: { enabled: true, strength: "dealbreaker" },
    });
    const draft = { ...(await h.json("GET", "/profile")).body, anmeldungNeeded: true };

    const { body } = await h.json("POST", "/ranking/preview", { profile: draft });

    expect(body.changes).toHaveLength(3);
    expect(body.changes.every((c: { to: string }) => c.to === "near-match")).toBe(true);
  });

  it("reports no changes for an unchanged draft", async () => {
    const h = await bootWithThreeRents();
    const { body } = await h.json("POST", "/ranking/preview", {});
    expect(body.changes).toEqual([]);
  });

  it("rejects a draft that is not a Profile", async () => {
    const h = bootOffers();
    const { status, body } = await h.json("POST", "/ranking/preview", { profile: { age: "old" } });
    expect(status).toBe(400);
    expect(body.type).toBe("validation-error");
  });
});

describe("Stale Offers", () => {
  it("are Hidden once their activity is older than 7 days, and say so in the event", async () => {
    const h = await bootWithThreeRents();
    h.events.length = 0;

    h.clock.now += 8 * DAY;
    // Time alone moves no band at a read: the periodic re-band notices it.
    h.runtime.offers.tick();
    expect((await h.json("GET", "/offers")).body.items).toEqual([]);

    const hidden = (await h.json("GET", "/offers?band=hidden")).body;
    expect(titles(hidden).sort()).toEqual(["Cheap", "Dear", "Dearest"]);
    expect(h.events.filter((e) => e.type === "offer-band-changed")).toHaveLength(3);
  });
});

describe("Untracked Offers", () => {
  it("are Hidden once no enabled Search matches them", async () => {
    const h = await bootWithThreeRents();
    const [search] = (await h.json("GET", "/searches")).body.items as { id: number }[];

    await h.json("PATCH", `/searches/${search?.id}`, { enabled: false });

    expect((await h.json("GET", "/offers")).body.items).toEqual([]);
    const hidden = (await h.json("GET", "/offers?band=hidden")).body.items as {
      hiddenBecause: string;
    }[];
    expect(hidden.map((o) => o.hiddenBecause)).toEqual(["untracked", "untracked", "untracked"]);
  });
});

describe("a Search edit", () => {
  it("keeps its Offers in their band while the edit's backfill runs: a new price ceiling hides nothing", async () => {
    const h = await bootWithThreeRents();
    await h.json("PUT", "/filters", await withMaxRent(h, 500, { value: 50, unit: "absolute" }));
    const before = (await h.json("GET", "/offers?includeHidden=true")).body.items as Listed[];
    expect(before.map((o) => [o.title, o.band])).toEqual([
      ["Cheap", "match"],
      ["Dear", "near-match"],
      ["Dearest", "hidden"],
    ]);
    const [search] = (await h.json("GET", "/searches")).body.items as { id: number }[];
    h.clock.now += HOUR;
    const looked = new Date(h.clock.now).toISOString();
    h.events.length = 0;

    await h.json("PATCH", `/searches/${search?.id}`, { priceCeiling: 900 });

    const during = (await h.json("GET", "/offers?includeHidden=true")).body.items as Listed[];
    expect(during.map((o) => [o.title, o.band, o.bandChangedAt])).toEqual(
      before.map((o) => [o.title, o.band, o.bandChangedAt]),
    );
    expect(
      during.every((o) => (o as { hiddenBecause?: string }).hiddenBecause !== "untracked"),
    ).toBe(true);
    expect(titles((await h.json("GET", "/offers")).body)).toEqual(["Cheap", "Dear"]);

    await h.crawl();
    const after = (await h.json("GET", "/offers?includeHidden=true")).body.items as Listed[];
    expect(after.map((o) => [o.title, o.band, o.bandChangedAt])).toEqual(
      before.map((o) => [o.title, o.band, o.bandChangedAt]),
    );
    expect(h.events.filter((e) => e.type === "offer-band-changed")).toEqual([]);
    expect((await h.json("GET", `/offers?since=${looked}`)).body.items).toEqual([]);
  });

  it("does not make its Offers look new again: Untracked for a while is not a band change", async () => {
    const h = await bootWithThreeRents();
    const before = (await h.json("GET", "/offers")).body.items as Listed[];
    const [search] = (await h.json("GET", "/searches")).body.items as { id: number }[];
    h.clock.now += HOUR;
    const looked = new Date(h.clock.now).toISOString();
    h.events.length = 0;

    await h.json("PATCH", `/searches/${search?.id}`, { enabled: false });
    expect((await h.json("GET", "/offers")).body.items).toEqual([]);
    await h.json("PATCH", `/searches/${search?.id}`, { enabled: true });
    await h.crawl();

    const after = (await h.json("GET", "/offers")).body.items as Listed[];
    expect(titles({ items: after }).sort()).toEqual(["Cheap", "Dear", "Dearest"]);
    expect(after.map((o) => [o.id, o.bandChangedAt]).sort()).toEqual(
      before.map((o) => [o.id, o.bandChangedAt]).sort(),
    );
    expect(h.events.filter((e) => e.type === "offer-band-changed")).toEqual([]);
    expect((await h.json("GET", `/offers?since=${looked}`)).body.items).toEqual([]);
  });
});
