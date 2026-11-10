import { describe, expect, it } from "vitest";
import type { SearchSpec } from "../../source/source.js";
import { wgGesuchtSource } from "./index.js";

const berlin: SearchSpec = {
  city: "Berlin",
  cityId: null,
  categories: ["flatshare-room"],
  rentTypes: ["unlimited", "limited", "overnight"],
  priceCeiling: null,
  recencyDays: 7,
};

function requests(search: Partial<SearchSpec>, page = 0) {
  const result = wgGesuchtSource.searchPages({ ...berlin, ...search }, page);
  if (!result.ok) throw new Error(result.reason);
  return result.requests.map((request) => {
    const url = new URL(request.path, "https://source.test");
    return {
      category: request.category,
      pathname: url.pathname,
      query: [...url.searchParams.entries()].map(([key, value]) => `${key}=${value}`),
    };
  });
}

describe("search URLs", () => {
  it("builds the flatshare URL for Berlin: slug, city, category and a 0-based page", () => {
    expect(requests({})[0]?.pathname).toBe("/wg-zimmer-in-Berlin.8.0.1.0.html");
    expect(requests({}, 2)[0]?.pathname).toBe("/wg-zimmer-in-Berlin.8.0.1.2.html");
  });

  it("gives each category its own slug and number, one request per category", () => {
    const all = requests({ categories: ["flatshare-room", "one-room-flat", "flat", "house"] });
    expect(all.map((r) => [r.category, r.pathname])).toEqual([
      ["flatshare-room", "/wg-zimmer-in-Berlin.8.0.1.0.html"],
      ["one-room-flat", "/1-zimmer-wohnungen-in-Berlin.8.1.1.0.html"],
      ["flat", "/wohnungen-in-Berlin.8.2.1.0.html"],
      ["house", "/haeuser-in-Berlin.8.3.1.0.html"],
    ]);
  });

  it("filters by recency through sin and never through offers_since", () => {
    const sinOf = (recencyDays: number) =>
      requests({ recencyDays })[0]?.query.find((q) => q.startsWith("sin="));
    expect(sinOf(1)).toBe("sin=1");
    expect(sinOf(3)).toBe("sin=1");
    expect(sinOf(4)).toBe("sin=2");
    expect(sinOf(7)).toBe("sin=2");
    for (const recencyDays of [1, 3, 4, 7]) {
      expect(requests({ recencyDays })[0]?.query.join("&")).not.toContain("offers_since");
    }
  });

  it("maps rent types to the search numbers 2, 1 and 3, not the detail page's 0, 1 and 2", () => {
    const rentOf = (rentTypes: SearchSpec["rentTypes"]) =>
      requests({ rentTypes })[0]?.query.filter((q) => q.startsWith("rent_types[]="));
    expect(rentOf(["unlimited"])).toEqual(["rent_types[]=2"]);
    expect(rentOf(["limited"])).toEqual(["rent_types[]=1"]);
    expect(rentOf(["overnight"])).toEqual(["rent_types[]=3"]);
    expect(rentOf(["unlimited", "limited"])).toEqual(["rent_types[]=2", "rent_types[]=1"]);
  });

  it("leaves the rent types out when all three are wanted", () => {
    expect(requests({})[0]?.query.join("&")).not.toContain("rent_types");
  });

  it("sends the price ceiling as rMax, and nothing when there is none", () => {
    expect(requests({ priceCeiling: 650 })[0]?.query).toContain("rMax=650");
    expect(requests({})[0]?.query.join("&")).not.toContain("rMax");
  });

  it("hides deactivated Offers and names the city, as the Source's own links do", () => {
    expect(requests({})[0]?.query).toEqual(
      expect.arrayContaining(["offer_filter=1", "city_id=8", "noDeact=1", "categories[]=0"]),
    );
  });

  it("drops offer_filter from page 2 on, as the Source's pagination links do", () => {
    const later = requests({}, 1)[0]?.query ?? [];
    expect(later).not.toContain("offer_filter=1");
    expect(later).toContain("noDeact=1");
    expect(later).toContain("sin=2");
  });
});

describe("search URLs: the city", () => {
  it("knows Berlin whatever the case", () => {
    expect(requests({ city: "berlin" })[0]?.pathname).toBe("/wg-zimmer-in-Berlin.8.0.1.0.html");
  });

  it.each([
    ["Berlin", "/wg-zimmer-in-Berlin.8.0.1.0.html"],
    ["Hamburg", "/wg-zimmer-in-Hamburg.55.0.1.0.html"],
    ["München", "/wg-zimmer-in-Muenchen.90.0.1.0.html"],
    ["Köln", "/wg-zimmer-in-Koeln.73.0.1.0.html"],
    ["Frankfurt am Main", "/wg-zimmer-in-Frankfurt-am-Main.41.0.1.0.html"],
    ["Stuttgart", "/wg-zimmer-in-Stuttgart.124.0.1.0.html"],
    ["Düsseldorf", "/wg-zimmer-in-Duesseldorf.30.0.1.0.html"],
    ["Leipzig", "/wg-zimmer-in-Leipzig.77.0.1.0.html"],
    ["Dresden", "/wg-zimmer-in-Dresden.27.0.1.0.html"],
    ["Hannover", "/wg-zimmer-in-Hannover.57.0.1.0.html"],
    ["Nürnberg", "/wg-zimmer-in-Nuernberg.96.0.1.0.html"],
    ["Bremen", "/wg-zimmer-in-Bremen.17.0.1.0.html"],
    ["Heidelberg", "/wg-zimmer-in-Heidelberg.59.0.1.0.html"],
    ["Freiburg im Breisgau", "/wg-zimmer-in-Freiburg-im-Breisgau.43.0.1.0.html"],
    ["Münster", "/wg-zimmer-in-Muenster.91.0.1.0.html"],
    ["Aachen", "/wg-zimmer-in-Aachen.1.0.1.0.html"],
    ["Göttingen", "/wg-zimmer-in-Goettingen.49.0.1.0.html"],
    ["Karlsruhe", "/wg-zimmer-in-Karlsruhe.68.0.1.0.html"],
    ["Mannheim", "/wg-zimmer-in-Mannheim.85.0.1.0.html"],
    ["Bonn", "/wg-zimmer-in-Bonn.13.0.1.0.html"],
    ["Darmstadt", "/wg-zimmer-in-Darmstadt.23.0.1.0.html"],
  ])("knows %s without a city id", (city, path) => {
    expect(requests({ city, cityId: null })[0]?.pathname).toBe(path);
  });

  it.each([
    ["München", "muenchen", "MÜNCHEN", "  münchen "],
    ["Frankfurt am Main", "frankfurt-am-main", "Frankfurt-am-Main", "frankfurt  am main"],
    ["Freiburg im Breisgau", "freiburg-im-breisgau", "FREIBURG IM BREISGAU"],
    ["Düsseldorf", "duesseldorf", "DÜSSELDORF"],
    ["Köln", "koeln", "KÖLN"],
    ["Göttingen", "goettingen", "GÖTTINGEN"],
  ])("knows %s however it is typed: umlaut or written out, any case", (canonical, ...typed) => {
    const path = (city: string) => requests({ city, cityId: null })[0]?.pathname;
    for (const city of typed) expect(path(city)).toBe(path(canonical));
  });

  it("lets a given id win over the table for a built-in city too", () => {
    expect(requests({ city: "München", cityId: "12345" })[0]?.pathname).toBe(
      "/wg-zimmer-in-Muenchen.12345.0.1.0.html",
    );
  });

  it("refuses a city it has no id for, so the Search is never polled blind", () => {
    expect(wgGesuchtSource.searchPages({ ...berlin, city: "Teststadt" }, 0)).toEqual({
      ok: false,
      reason: "unknown-city",
    });
  });

  it("uses the id the Search gives, with the city name spelled the way the Source's slugs are", () => {
    const paths = (city: string) => requests({ city, cityId: "55" })[0]?.pathname;
    expect(paths("Hamburg")).toBe("/wg-zimmer-in-Hamburg.55.0.1.0.html");
    expect(paths("München")).toBe("/wg-zimmer-in-Muenchen.55.0.1.0.html");
    expect(paths("Frankfurt am Main")).toBe("/wg-zimmer-in-Frankfurt-am-Main.55.0.1.0.html");
    expect(paths("Köln")).toBe("/wg-zimmer-in-Koeln.55.0.1.0.html");
    expect(paths("Fürth/Bayern")).toBe("/wg-zimmer-in-Fuerth-Bayern.55.0.1.0.html");
  });

  it("lets a given id win over its own table", () => {
    expect(requests({ city: "Berlin", cityId: "9" })[0]?.pathname).toBe(
      "/wg-zimmer-in-Berlin.9.0.1.0.html",
    );
  });

  it("refuses an id that is not a number", () => {
    expect(
      wgGesuchtSource.searchPages({ ...berlin, city: "Hamburg", cityId: "5/../x" }, 0),
    ).toEqual({ ok: false, reason: "unknown-city" });
  });
});
