import { describe, expect, it } from "vitest";
import { fact, fixture, offer } from "./testing.js";

const flatshareHtml = fixture("flatshare");
const MAP = /var map_config = .*;/;

const withMap = (markers: string) =>
  offer("flatshare", flatshareHtml.replace(MAP, `var map_config = {markers:[${markers}]};`)).facts;

const marker = (id: string, lat: string, lng: string) =>
  `{"lat":${lat},"lng":${lng},"offer_id":"${id}","title":"x"}`;

describe("coordinates", () => {
  it("come from the marker whose offer_id is this Ad ID, not the first marker on the page", () => {
    const f = withMap(
      [marker("999", "1.111111", "2.222222"), marker("1000001", "3.333333", "4.444444")].join(","),
    );
    expect(f.coordinates).toEqual(
      fact({ lat: 3.333333, lng: 4.444444 }, '"lat":3.333333,"lng":4.444444'),
    );
  });

  it("are unknown when no marker belongs to this Ad ID", () => {
    expect(withMap(marker("999", "1.111111", "2.222222")).coordinates).toEqual(fact("unknown", ""));
  });

  it("are unknown when the markers carry no offer_id", () => {
    expect(withMap('{"lat":1.111111,"lng":2.222222}').coordinates).toEqual(fact("unknown", ""));
  });
});

describe("district", () => {
  const district = (line: string) =>
    offer("flatshare", flatshareHtml.replace("12345 Teststadt Testviertel", line)).facts.district;

  it("is what follows a one-word city", () => {
    expect(district("12345 Teststadt Testviertel")?.value).toBe("Testviertel");
  });

  it("is a multi-word district, whole", () => {
    expect(district("12345 Teststadt Alt Testviertel")?.value).toBe("Alt Testviertel");
  });

  it.each([
    ["12345 Frankfurt am Main Nordend", "Nordend"],
    ["12345 Freiburg im Breisgau Wiehre", "Wiehre"],
    ["12345 Rothenburg ob der Tauber Altstadt", "Altstadt"],
    ["12345 Halle (Saale) Neustadt", "Neustadt"],
    ["12345 Bad Testburg Mitte", "Mitte"],
    ["12345 Sankt Testheim Nord Ost", "Nord Ost"],
  ])("skips a multi-word city in %s", (line, expected) => {
    expect(district(line)?.value).toBe(expected);
  });

  it("is unknown when the line names only the city", () => {
    expect(district("12345 Frankfurt am Main")?.value).toBe("unknown");
    expect(district("12345 Teststadt")?.value).toBe("unknown");
  });

  it("is unknown when the district repeats the city", () => {
    expect(district("12345 Teststadt Teststadt")?.value).toBe("unknown");
  });
});

describe("title", () => {
  it("prefers the original content in the h1 over any other span", () => {
    const html = fixture("translated").replace(
      '<span class="display-none original_content">Bright room in a quiet flat</span>',
      '<span class="display-none original_content">Bright room in a quiet flat</span><span class="badge">Neu</span>',
    );
    expect(offer("translated", html).text.title).toBe("Bright room in a quiet flat");
  });

  it("falls back to the last span when nothing is translated", () => {
    expect(offer("flatshare").text.title).toBe("Helles Zimmer in ruhiger Studenten-WG");
  });
});
