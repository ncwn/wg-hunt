import { describe, expect, it } from "vitest";
import { bootOffers } from "./offers-harness.js";

describe("GET /presets/example", () => {
  it("is the fictional Seeker Profile, Filters and Search", async () => {
    const h = bootOffers();
    const { status, body } = await h.json("GET", "/presets/example");
    expect(status).toBe(200);
    expect(body.profile).toEqual({
      gender: "woman",
      age: 27,
      anmeldungNeeded: true,
      moveIn: { earliest: "2027-01-01", latest: "2027-01-15" },
      stay: { minMonths: 12, maxMonths: null },
      diet: "vegetarian",
      occupation: "working",
      smoker: false,
      hasPets: false,
      languages: ["de", "en"],
      places: [{ name: "work", plz: "10115" }],
    });
    expect(body.filters.maxRent).toEqual({
      enabled: true,
      strength: "dealbreaker",
      limit: 700,
      margin: { value: 50, unit: "absolute" },
    });
    expect(body.filters.minSize).toMatchObject({ enabled: true, limit: 12 });
    expect(body.filters.distance).toEqual({
      enabled: true,
      strength: "want",
      place: "work",
      limit: 5,
      margin: null,
    });
    expect(body.search).toEqual({
      city: "Berlin",
      categories: ["flatshare-room", "one-room-flat"],
      rentTypes: ["unlimited"],
      priceCeiling: 800,
      recencyDays: 7,
    });
  });

  it("puts the move-in window in the month two months after loading, wherever the year ends", async () => {
    const window = async (at: string) => {
      const h = bootOffers({ start: Date.parse(at) });
      return (await h.json("GET", "/presets/example")).body.profile.moveIn;
    };
    expect(await window("2026-03-10T12:00:00Z")).toEqual({
      earliest: "2026-05-01",
      latest: "2026-05-15",
    });
    expect(await window("2026-11-04T09:00:00Z")).toEqual({
      earliest: "2027-01-01",
      latest: "2027-01-15",
    });
    expect(await window("2026-12-31T12:00:00Z")).toEqual({
      earliest: "2027-02-01",
      latest: "2027-02-15",
    });
  });

  it("uses the Berlin date, not the UTC one, around midnight", async () => {
    // 23:30 UTC on 31 Dec is already 1 Jan in Berlin.
    const h = bootOffers({ start: Date.parse("2026-12-31T23:30:00Z") });
    const { moveIn } = (await h.json("GET", "/presets/example")).body.profile;
    expect(moveIn.earliest).toBe("2027-03-01");
  });

  it("never applies itself: the saved Profile and Filters stay the neutral defaults", async () => {
    const h = bootOffers();
    const before = {
      profile: (await h.json("GET", "/profile")).body,
      filters: (await h.json("GET", "/filters")).body,
    };
    await h.json("GET", "/presets/example");
    expect((await h.json("GET", "/profile")).body).toEqual(before.profile);
    expect((await h.json("GET", "/filters")).body).toEqual(before.filters);
    expect((await h.json("GET", "/searches")).body.items).toEqual([]);
  });

  it("is a draft that can be saved as is, Place and all", async () => {
    const h = bootOffers();
    const preset = (await h.json("GET", "/presets/example")).body;
    expect((await h.json("PUT", "/profile", preset.profile)).status).toBe(200);
    expect((await h.json("PUT", "/filters", preset.filters)).status).toBe(200);
    const search = await h.json("POST", "/searches", preset.search);
    expect(search.status).toBe(201);
  });

  it("needs the access token", async () => {
    const h = bootOffers();
    const res = await h.runtime.app.request("/api/v1/presets/example");
    expect(res.status).toBe(401);
  });
});
