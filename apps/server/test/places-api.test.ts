import { plzCentre } from "@wg-hunt/core";
import { describe, expect, it, vi } from "vitest";
import { saveFilters } from "../src/seeking.js";
import { offerPageWith } from "./fixtures/search-pages.js";
import { bootOffers, HOUR } from "./offers-harness.js";

type Boot = ReturnType<typeof bootOffers>;
type Listed = {
  id: number;
  title: string;
  band: string;
  reasons: { filter: string; outcome: string; cause: string; message: string }[];
  distance: { place: string; km: number; approximate: boolean } | null;
  bandChangedAt: string;
};

const centre = plzCentre("10115") ?? { lat: 0, lng: 0 };
/** One degree of latitude is 111.195 km. */
const northOfWork = (km: number) => centre.lat + km / 111.195;

/** A marker that belongs to another Ad ID leaves the page without coordinates. */
function pageAt(title: string, where: { km: number } | { plz: string }) {
  const page = offerPageWith({ title, warmRent: 500 });
  if ("plz" in where) {
    return page
      .replace("12345 Teststadt", `${where.plz} Teststadt`)
      .replace('"offer_id":"1000001"', '"offer_id":"1"');
  }
  return page.replace(
    '"lat":12.345678,"lng":23.456789',
    `"lat":${northOfWork(where.km)},"lng":${centre.lng}`,
  );
}

const work = { name: "work", plz: "10115" };

async function bootWithOffers(): Promise<Boot> {
  const h = bootOffers();
  h.site.cards = h.freshCards([9100001, 9100002, 9100003, 9100004]);
  h.site.pages.set(9100001, pageAt("Far", { km: 12 }));
  h.site.pages.set(9100002, pageAt("Near", { km: 1 }));
  h.site.pages.set(9100003, pageAt("Approx", { plz: "10117" }));
  h.site.pages.set(9100004, pageAt("Lost", { plz: "99999" }));
  await h.addSearch();
  await h.crawl();
  return h;
}

async function saveWork(h: Boot, places: unknown[] = [work]) {
  const profile = (await h.json("GET", "/profile")).body;
  return h.json("PUT", "/profile", { ...profile, places });
}

const sorted = async (h: Boot, query = "sort=distance&place=work") =>
  (await h.json("GET", `/offers?${query}`)).body;
const titles = (body: { items: Listed[] }) => body.items.map((o) => o.title);

const withinFive = async (h: Boot, patch: Record<string, unknown> = {}) => {
  const filters = (await h.json("GET", "/filters")).body;
  filters.distance = {
    enabled: true,
    strength: "want",
    place: "work",
    limit: 5,
    margin: null,
    ...patch,
  };
  return filters;
};
const bands = async (h: Boot) =>
  Object.fromEntries(
    ((await h.json("GET", "/offers?includeHidden=true")).body.items as Listed[]).map((o) => [
      o.title,
      o.band,
    ]),
  );

describe("Places in the Seeker Profile", () => {
  it("ship empty, and are saved with the profile and survive a restart", async () => {
    const h = bootOffers();
    expect((await h.json("GET", "/profile")).body.places).toEqual([]);

    const saved = await saveWork(h, [work, { name: "gym", lat: 10.5, lng: -20.25 }]);
    expect(saved.status).toBe(200);
    expect(saved.body.places).toEqual([work, { name: "gym", lat: 10.5, lng: -20.25 }]);
    h.runtime.close();

    const again = bootOffers({ dataDir: h.dataDir });
    expect((await again.json("GET", "/profile")).body.places).toEqual(saved.body.places);
  });

  it("resolve a PLZ offline: an unknown PLZ is a validation error at that Place", async () => {
    const h = bootOffers();
    const bad = await saveWork(h, [work, { name: "gym", plz: "00000" }]);
    expect(bad.status).toBe(400);
    expect(bad.body.type).toBe("validation-error");
    expect(bad.body.errors).toEqual([
      { path: "places.1.plz", message: "This PLZ is not in the dataset" },
    ]);
    expect((await h.json("GET", "/profile")).body.places).toEqual([]);
  });

  it("reject a Place with neither a PLZ nor coordinates, or two Places with one name", async () => {
    const h = bootOffers();
    expect((await saveWork(h, [{ name: "work" }])).status).toBe(400);
    expect((await saveWork(h, [work, { ...work, name: "Work" }])).status).toBe(400);
  });

  it("never echo pasted coordinates in an error", async () => {
    const h = bootOffers();
    const bad = await saveWork(h, [{ name: "gym", lat: 987.654321, lng: 12.5 }]);
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain("987.654321");
  });

  it("keep an older saved profile without Places working", async () => {
    const h = bootOffers();
    const { places: _places, ...older } = (await h.json("GET", "/profile")).body;
    const saved = await h.json("PUT", "/profile", older);
    expect(saved.status).toBe(200);
    expect(saved.body.places).toEqual([]);
  });
});

describe("GET /offers?sort=distance", () => {
  it("lists the nearest first, an approximate distance in its place, and unknown last", async () => {
    const h = await bootWithOffers();
    await saveWork(h);
    const body = await sorted(h);
    expect(titles(body)).toEqual(["Near", "Approx", "Far", "Lost"]);

    const [near, approx, far, lost] = body.items as Listed[];
    expect(near?.distance).toMatchObject({ place: "work", approximate: false });
    expect(near?.distance?.km).toBeCloseTo(1, 1);
    expect(far?.distance?.km).toBeCloseTo(12, 1);
    expect(approx?.distance?.approximate).toBe(true);
    expect(lost?.distance).toBeNull();
  });

  it("measures from the first Place when none is named, and from the one named, whatever its case", async () => {
    const h = await bootWithOffers();
    await saveWork(h, [work, { name: "Gym", lat: northOfWork(12), lng: centre.lng }]);
    expect(titles(await sorted(h, "sort=distance"))).toEqual(["Near", "Approx", "Far", "Lost"]);
    expect(titles(await sorted(h, "sort=distance&place=gYm"))[0]).toBe("Far");
  });

  it("is a validation error without a Place to measure from, or with an unknown one", async () => {
    const h = await bootWithOffers();
    const none = await h.json("GET", "/offers?sort=distance");
    expect(none.status).toBe(400);
    expect(none.body.type).toBe("validation-error");
    expect(none.body.errors[0].path).toBe("place");

    await saveWork(h);
    const unknown = await h.json("GET", "/offers?sort=distance&place=nowhere");
    expect(unknown.status).toBe(400);
    expect(unknown.body.errors[0].path).toBe("place");
  });

  it("pages with a cursor", async () => {
    const h = await bootWithOffers();
    await saveWork(h);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page++) {
      const query: string = `sort=distance&place=work&limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const body = await sorted(h, query);
      seen.push(...titles(body));
      cursor = body.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(["Near", "Approx", "Far", "Lost"]);
  });

  it("refuses a cursor under another Place, and continues the list under the one it measured to", async () => {
    const h = await bootWithOffers();
    await saveWork(h, [work, { name: "Gym", lat: northOfWork(12), lng: centre.lng }]);
    const first = await sorted(h, "sort=distance&place=work&limit=2");
    expect(titles(first)).toEqual(["Near", "Approx"]);
    const cursor = encodeURIComponent(first.nextCursor);

    const refused = await h.json("GET", `/offers?sort=distance&place=gym&limit=2&cursor=${cursor}`);
    expect(refused.status).toBe(400);
    expect(refused.body.type).toBe("invalid-cursor");

    for (const same of ["&place=work", "&place=WORK", ""]) {
      const second = await sorted(h, `sort=distance${same}&limit=2&cursor=${cursor}`);
      expect(titles(second)).toEqual(["Far", "Lost"]);
    }

    await saveWork(h, [{ name: "Gym", lat: northOfWork(12), lng: centre.lng }, work]);
    const moved = await h.json("GET", `/offers?sort=distance&limit=2&cursor=${cursor}`);
    expect(moved.body.type).toBe("invalid-cursor");
  });

  it("takes a cursor of another sort whatever `place` says, since only a distance sort reads it", async () => {
    const h = await bootWithOffers();
    await saveWork(h);
    const first = await sorted(h, "sort=warm-rent&limit=2");
    const cursor = encodeURIComponent(first.nextCursor);

    const second = await h.json(
      "GET",
      `/offers?sort=warm-rent&place=work&limit=2&cursor=${cursor}`,
    );
    expect(second.status).toBe(200);
    expect(second.body.items).toHaveLength(2);
    expect(titles(second.body)).not.toEqual(titles(first));
  });

  it("leaves `distance` null when the list is not sorted by distance", async () => {
    const h = await bootWithOffers();
    await saveWork(h);
    const body = await sorted(h, "place=work");
    expect((body.items as Listed[]).every((o) => o.distance === null)).toBe(true);
  });
});

describe("the distance Filter through the API", () => {
  it("ships off, a Want, and unset", async () => {
    const h = bootOffers();
    expect((await h.json("GET", "/filters")).body.distance).toEqual({
      enabled: false,
      strength: "want",
      place: null,
      limit: null,
      margin: null,
    });
  });

  it("bands Offers by distance, marking an approximate distance in its reason", async () => {
    const h = await bootWithOffers();
    await saveWork(h);
    await h.json("PUT", "/filters", await withinFive(h));
    expect(await bands(h)).toEqual({
      Near: "match",
      Approx: "match",
      Far: "near-match",
      Lost: "near-match",
    });
    const listed = (await h.json("GET", "/offers")).body.items as Listed[];
    const reason = (title: string) =>
      listed.find((o) => o.title === title)?.reasons.find((r) => r.filter === "distance");
    expect(reason("Near")?.message).toBe("Distance to work 1 km is at most 5 km");
    expect(reason("Approx")?.message).toMatch(/^Approximate distance to work /);
    expect(reason("Lost")?.cause).toBe("unknown");
  });

  it("hides a Dealbreaker miss outside its margin, and keeps one inside it as a Near match", async () => {
    const h = await bootWithOffers();
    await saveWork(h);
    await h.json(
      "PUT",
      "/filters",
      await withinFive(h, { strength: "dealbreaker", margin: { value: 10, unit: "absolute" } }),
    );
    expect((await bands(h)).Far).toBe("near-match");
    await h.json(
      "PUT",
      "/filters",
      await withinFive(h, { strength: "dealbreaker", margin: { value: 1, unit: "absolute" } }),
    );
    expect((await bands(h)).Far).toBe("hidden");
  });

  it("previews the change without saving it", async () => {
    const h = await bootWithOffers();
    await saveWork(h);
    const draft = await withinFive(h, { strength: "dealbreaker" });
    const preview = await h.json("POST", "/ranking/preview", { filters: draft });
    const moves = Object.fromEntries(
      preview.body.changes.map((c: { title: string; to: string }) => [c.title, c.to]),
    );
    expect(moves).toEqual({ Far: "hidden", Lost: "near-match" });
    expect((await h.json("GET", "/filters")).body.distance.enabled).toBe(false);
  });

  it("is a validation error to name a Place the profile does not have", async () => {
    const h = await bootWithOffers();
    const bad = await h.json("PUT", "/filters", await withinFive(h, { strength: "dealbreaker" }));
    expect(bad.status).toBe(400);
    expect(bad.body.type).toBe("validation-error");
    expect(bad.body.detail).toBe(
      "The distance Filter measures from a Place that the Seeker Profile does not have.",
    );
    expect(bad.body.errors).toEqual([
      { path: "distance.place", message: "The Seeker Profile has no Place with this name" },
    ]);
    expect((await h.json("GET", "/filters")).body.distance.enabled).toBe(false);
    expect(Object.values(await bands(h)).every((band) => band === "match")).toBe(true);
  });

  it("finds the Place whatever its case, and lets a disabled Filter name no Place", async () => {
    const h = await bootWithOffers();
    await saveWork(h);
    expect((await h.json("PUT", "/filters", await withinFive(h, { place: "WORK" }))).status).toBe(
      200,
    );
    const none = await withinFive(h, { enabled: false, place: null, limit: null });
    expect((await h.json("PUT", "/filters", none)).status).toBe(200);
  });

  it("checks a draft against the draft profile when previewing", async () => {
    const h = await bootWithOffers();
    const draft = await withinFive(h);
    const without = await h.json("POST", "/ranking/preview", { filters: draft });
    expect(without.status).toBe(400);
    expect(without.body.errors[0].path).toBe("distance.place");

    const profile = (await h.json("GET", "/profile")).body;
    const withWork = await h.json("POST", "/ranking/preview", {
      profile: { ...profile, places: [work] },
      filters: draft,
    });
    expect(withWork.status).toBe(200);
  });
});

const renamed = (body: { places: { name: string }[] }, name: string) => ({
  ...body,
  places: body.places.map((place) => (place.name === "work" ? { ...place, name } : place)),
});

async function etags(h: Boot) {
  const [profile, filters] = await Promise.all([
    h.call("GET", "/profile"),
    h.call("GET", "/filters"),
  ]);
  return { profile: profile.headers.get("ETag"), filters: filters.headers.get("ETag") };
}

const bandChanges = (h: Boot) => h.events.filter((e) => e.type === "offer-band-changed");

describe("PUT /seeking", () => {
  it("renames a Place the distance Filter measures from in one write: one re-band, no band-change event, the same bandChangedAt", async () => {
    const h = await bootWithOffers();
    await saveWork(h);
    await h.json("PUT", "/filters", await withinFive(h));
    expect(await bands(h)).toMatchObject({ Far: "near-match", Lost: "near-match" });
    const changedAt = async () =>
      Object.fromEntries(
        ((await h.json("GET", "/offers?includeHidden=true")).body.items as Listed[]).map((o) => [
          o.title,
          o.bandChangedAt,
        ]),
      );
    const before = await changedAt();
    const since = new Date(h.clock.now).toISOString();
    h.events.length = 0;
    h.clock.now += HOUR;
    const reband = vi.spyOn(h.runtime.offers, "rebandAll");

    const profile = renamed((await h.json("GET", "/profile")).body, "office");
    const filters = await withinFive(h, { place: "office" });
    const saved = await h.json("PUT", "/seeking", { profile, filters });

    expect(saved.status).toBe(200);
    expect(saved.body.profile.places).toEqual([{ ...work, name: "office" }]);
    expect(saved.body.filters.distance.place).toBe("office");
    expect(saved.body.revisions).toEqual(await etags(h));
    expect(reband).toHaveBeenCalledTimes(1);
    expect(bandChanges(h)).toEqual([]);
    expect(await changedAt()).toEqual(before);
    expect((await h.json("GET", `/offers/counts?since=${since}`)).body.new).toBe(0);
    const far = ((await h.json("GET", "/offers")).body.items as Listed[]).find(
      (o) => o.title === "Far",
    );
    expect(far?.reasons.find((r) => r.filter === "distance")?.message).toMatch(
      /^Distance to office /,
    );
  });

  it("refuses Filters that name a Place the Profile in the same write lacks, and saves neither", async () => {
    const h = await bootWithOffers();
    await saveWork(h);
    const before = await etags(h);
    const profile = renamed((await h.json("GET", "/profile")).body, "office");
    const bad = await h.json("PUT", "/seeking", { profile, filters: await withinFive(h) });

    expect(bad.status).toBe(400);
    expect(bad.body.type).toBe("validation-error");
    expect(bad.body.detail).toBe(
      "The distance Filter measures from a Place that the Seeker Profile does not have.",
    );
    expect(bad.body.errors).toEqual([
      { path: "filters.distance.place", message: "The Seeker Profile has no Place with this name" },
    ]);
    expect(JSON.stringify(bad.body)).not.toContain("work");
    expect(await etags(h)).toEqual(before);
    expect(bandChanges(h)).toEqual([]);
  });

  it("refuses a Profile sent alone without the Place the saved Filters measure from, even when the pair was already dangling", async () => {
    const h = await bootWithOffers();
    await saveWork(h);
    await h.json("PUT", "/filters", await withinFive(h));
    const profile = renamed((await h.json("GET", "/profile")).body, "office");
    const bad = await h.json("PUT", "/seeking", { profile });
    expect(bad.status).toBe(400);
    expect(bad.body.errors).toEqual([
      {
        path: "profile.places",
        message: "The distance Filter measures from a Place this Seeker Profile does not have",
      },
    ]);
    expect(JSON.stringify(bad.body)).not.toContain("work");

    saveFilters(h.runtime.db, await withinFive(h, { place: "gym" }));
    const unrelated = { ...(await h.json("GET", "/profile")).body, age: 30 };
    expect((await h.json("PUT", "/seeking", { profile: unrelated })).status).toBe(400);
  });

  it("saves one half alone and answers with both", async () => {
    const h = await bootWithOffers();
    const profile = (await saveWork(h)).body;
    const filters = await withinFive(h);
    const saved = await h.json("PUT", "/seeking", { filters });
    expect(saved.status).toBe(200);
    expect(saved.body.profile).toEqual(profile);
    expect(saved.body.filters).toEqual(filters);
    expect((await h.json("GET", "/filters")).body).toEqual(filters);
  });

  it("refuses a body with neither half, or with an unknown key", async () => {
    const h = bootOffers();
    const none = await h.json("PUT", "/seeking", {});
    expect(none.status).toBe(400);
    expect(none.body.type).toBe("validation-error");
    const profile = (await h.json("GET", "/profile")).body;
    expect((await h.json("PUT", "/seeking", { profile, extra: true })).status).toBe(400);
  });
});

describe("PUT /profile and the Place the distance Filter measures from", () => {
  const DETAIL =
    "The distance Filter measures from a Place this Seeker Profile does not have. To rename or remove that Place, save the Seeker Profile and the Filters together.";

  async function measuring(h: Boot) {
    await saveWork(h, [work, { name: "gym", plz: "10117" }]);
    await h.json("PUT", "/filters", await withinFive(h));
    h.events.length = 0;
    return (await h.json("GET", "/profile")).body;
  }

  it("refuses removing that Place, without naming it", async () => {
    const h = await bootWithOffers();
    const profile = await measuring(h);
    const bad = await h.json("PUT", "/profile", {
      ...profile,
      places: [{ name: "gym", plz: "10117" }],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.type).toBe("validation-error");
    expect(bad.body.detail).toBe(DETAIL);
    expect(bad.body.errors).toEqual([
      {
        path: "places",
        message: "The distance Filter measures from a Place this Seeker Profile does not have",
      },
    ]);
    expect(JSON.stringify(bad.body)).not.toContain("work");
    expect((await h.json("GET", "/profile")).body).toEqual(profile);
    expect(bandChanges(h)).toEqual([]);
  });

  it("refuses a rename, and saves a change of case or of PLZ", async () => {
    const h = await bootWithOffers();
    const profile = await measuring(h);
    expect((await h.json("PUT", "/profile", renamed(profile, "office"))).status).toBe(400);
    expect((await h.json("PUT", "/profile", renamed(profile, "Work"))).status).toBe(200);
    const moved = {
      ...profile,
      places: profile.places.map((p: { name: string }) =>
        p.name === "work" ? { ...p, plz: "10117" } : p,
      ),
    };
    expect((await h.json("PUT", "/profile", moved)).status).toBe(200);
  });

  it("saves any change when the saved pair already names a missing Place", async () => {
    const h = await bootWithOffers();
    const profile = await measuring(h);
    saveFilters(h.runtime.db, await withinFive(h, { place: "office" }));
    expect((await h.json("PUT", "/profile", { ...profile, age: 30 })).status).toBe(200);
    const removed = { ...profile, age: 30, places: [{ name: "gym", plz: "10117" }] };
    expect((await h.json("PUT", "/profile", removed)).status).toBe(200);
  });
});
