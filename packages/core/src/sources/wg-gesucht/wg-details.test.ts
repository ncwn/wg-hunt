import { describe, expect, it } from "vitest";
import { FLATSHARE_TYPES } from "../../offer-facts/index.js";
import { fact, fixture, offer } from "./testing.js";

const flatshareHtml = fixture("flatshare");

const withLine = (from: string, to: string) => {
  expect(flatshareHtml).toContain(from);
  return offer("flatshare", flatshareHtml.replace(from, to)).facts;
};

describe("flatshare details", () => {
  const f = offer("flatshare").facts;

  it("reads gender and age sought", () => {
    expect(f.genderSought).toEqual(fact(["woman"], "Frau zwischen 23 und 28 Jahren"));
    expect(f.ageSought).toEqual(fact({ min: 23, max: 28 }, "Frau zwischen 23 und 28 Jahren"));
  });

  it("reads the flatmates' age range", () => {
    expect(f.flatmateAges).toEqual(fact({ min: 19, max: 29 }, "Bewohneralter: 19 bis 29 Jahre"));
  });

  it("reads smoking, pets present, languages and flatshare types", () => {
    expect(f.smoking).toEqual(fact("not_wanted", "Rauchen nicht erwünscht"));
    expect(f.petsPresent).toEqual(fact(false, "Haustiere vorhanden: Nein"));
    expect(f.languages).toEqual(fact(["en", "de"], "Sprache/n: Englisch, Deutsch"));
    expect(f.flatshareTypes).toEqual(
      fact(
        ["students", "mixed_gender", "vegetarian_vegan"],
        "Studenten-WG, gemischte WG, Vegetarisch/Vegan",
      ),
    );
  });

  it("reads 'Geschlecht egal' as any gender, with no age sought when none is stated", () => {
    const g = withLine("Frau zwischen 23 und 28 Jahren", "Geschlecht egal");
    expect(g.genderSought).toEqual(fact("any", "Geschlecht egal"));
    expect(g.ageSought).toEqual(fact("unknown", ""));
  });

  it("reads a man sought, and a one-sided age range as {min?, max?}", () => {
    const g = withLine("Frau zwischen 23 und 28 Jahren", "Mann ab 25 Jahren");
    expect(g.genderSought?.value).toEqual(["man"]);
    expect(g.ageSought?.value).toEqual({ min: 25 });
  });

  it("reads all 24 flatshare types", () => {
    const labels = [
      "Zweck-WG",
      "Studenten-WG",
      "Frauen-WG",
      "Männer-WG",
      "Business-WG",
      "Wohnheim",
      "Berufstätigen-WG",
      "Azubi-WG",
      "Senioren-WG",
      "WG mit Kindern",
      "Verbindung",
      "keine Zweck-WG",
      "gemischte WG",
      "Plus-WG",
      "Mehrgenerationen",
      "Vegetarisch/Vegan",
      "LGBTQIA+",
      "Wohnen für Hilfe",
      "Alleinerziehende",
      "Internationals welcome",
      "inklusive WG",
      "funktionale WG",
      "WG-Neugründung",
      "keine Angaben zum Geschlecht",
    ];
    const g = withLine("Studenten-WG, gemischte WG, Vegetarisch/Vegan", labels.join(", "));
    expect(g.flatshareTypes?.value).toEqual([...FLATSHARE_TYPES]);
  });

  it("reads the other smoking wordings", () => {
    expect(withLine("Rauchen nicht erwünscht", "Rauchen überall erlaubt").smoking?.value).toBe(
      "anywhere",
    );
    expect(withLine("Rauchen nicht erwünscht", "Rauchen im Zimmer erlaubt").smoking?.value).toBe(
      "own_room",
    );
    expect(
      withLine("Rauchen nicht erwünscht", "Rauchen auf dem Balkon erlaubt").smoking?.value,
    ).toBe("balcony");
  });

  it("leaves a flatshare language without an ISO code as the Source's own word", () => {
    const g = withLine("Sprache/n: Englisch, Deutsch", "Sprache/n: Französisch, Esperanto");
    expect(g.languages?.value).toEqual(["fr", "esperanto"]);
  });

  it("treats a flatshare with no WG-Details lines as unknown, not as a no", () => {
    const html = flatshareHtml.replace(
      /<h2>WG-Details<\/h2>[\s\S]*?<h2>Angaben zum Objekt<\/h2>/,
      "<h2>Angaben zum Objekt</h2>",
    );
    const g = offer("flatshare", html).facts;
    for (const key of [
      "genderSought",
      "ageSought",
      "flatmateAges",
      "smoking",
      "petsPresent",
      "languages",
      "flatshareTypes",
    ] as const) {
      expect(g[key], key).toEqual(fact("unknown", ""));
    }
  });

  it("reads (0w,0m,0d,0n) as unknown flatmates, but still reads the flatshare size", () => {
    const g = withLine("(1w,2m,0d,0n)", "(0w,0m,0d,0n)");
    expect(g.flatmates?.value).toBe("unknown");
    expect(g.flatshareSize?.value).toBe(6);
  });
});
