import { describe, expect, it } from "vitest";
import { fact, fixture, offer } from "./testing.js";

describe("flatshare page", () => {
  const flatshare = offer("flatshare");

  it("reads the page status, Ad ID, category and the Offer's own text", () => {
    expect(flatshare).toMatchObject({
      status: "active",
      adId: "1000001",
      category: "flatshare-room",
    });
    expect(flatshare.text.title).toBe("Helles Zimmer in ruhiger Studenten-WG");
    expect(flatshare.text.sections.map((s) => s.label)).toEqual([
      "Zimmer",
      "Lage",
      "WG-Leben",
      "Sonstiges",
    ]);
    expect(flatshare.text.sections[0]?.text).toBe(
      "Das Zimmer ist hell und möbliert.\nAnmeldung ist möglich.",
    );
  });

  it("parses the time since the last publish", () => {
    expect(flatshare.online).toEqual({ kind: "relative", minutes: 22 });
  });

  it("reads current flatmates and the flatshare size from the h1", () => {
    const quote = "6er WG (1w,2m,0d,0n)";
    expect(flatshare.facts.flatmates).toEqual(
      fact({ women: 1, men: 2, diverse: 0, unspecified: 0 }, quote),
    );
    expect(flatshare.facts.flatshareSize).toEqual(fact(6, quote));
  });

  it("reads a rent of 0 as unknown, so it never ranks as the cheapest room, but keeps a deposit of 0", () => {
    const zero = offer(
      "flatshare",
      fixture("flatshare")
        .replace(
          'Gesamtmiete</span><b class="key_fact_value">489€',
          'Gesamtmiete</span><b class="key_fact_value">0€',
        )
        .replace(
          'Miete:</span><span class="section_panel_value">375€',
          'Miete:</span><span class="section_panel_value">0€',
        )
        .replace(
          'Kaution:</span><span class="section_panel_value">900€',
          'Kaution:</span><span class="section_panel_value">0€',
        ),
    );
    expect(zero.facts.warmRent).toEqual(fact("unknown", "Gesamtmiete: 0€"));
    expect(zero.facts.baseRent).toEqual(fact("unknown", "Miete: 0€"));
    expect(zero.facts.rentPerSqm).toEqual(fact("unknown", ""));
    expect(zero.facts.deposit).toEqual(fact({ amount: 0, converted: false }, "Kaution: 0€"));
  });

  it("reads room size and flat size", () => {
    expect(flatshare.facts.roomSize).toEqual(fact(18, "Zimmergröße: 18m²"));
    expect(flatshare.facts.flatSize).toEqual(fact(80, "Wohnungsgröße: 80m²"));
  });

  it("reads every cost field, with n.a. as unknown and the warm rent as Gesamtmiete", () => {
    const f = flatshare.facts;
    expect(f.baseRent).toEqual(fact({ amount: 375, converted: false }, "Miete: 375€"));
    expect(f.utilities).toEqual(fact({ amount: 75, converted: false }, "Nebenkosten: 75€"));
    expect(f.otherCosts).toEqual(fact({ amount: 39, converted: false }, "Sonstige Kosten: 39€"));
    expect(f.deposit).toEqual(fact({ amount: 900, converted: false }, "Kaution: 900€"));
    expect(f.equipmentFee).toEqual(fact("unknown", "Ablösevereinbarung: n.a."));
    expect(f.warmRent).toEqual(fact({ amount: 489, converted: false }, "Gesamtmiete: 489€"));
    expect(f.costsComplete).toEqual(fact(true, "Nebenkosten: 75€"));
    expect(f.rentPerSqm).toEqual(fact(27.17, "Gesamtmiete: 489€ / Zimmergröße: 18m²"));
    expect(f.schufaRequested).toEqual(fact(true, "SCHUFA-Auskunft erwünscht:"));
  });

  it("reads availability and rent type", () => {
    const f = flatshare.facts;
    expect(f.availableFrom).toEqual(fact("2026-12-01", "frei ab: 01.12.2026"));
    expect(f.availableUntil).toEqual(fact("none", "frei ab: 01.12.2026"));
    expect(f.rentType).toEqual(fact("unlimited", 'setTargeting("wgg_rent_type", "0")'));
  });

  it("reads PLZ, district, street and coordinates", () => {
    const f = flatshare.facts;
    expect(f.postalCode).toEqual(fact("12345", "12345 Teststadt Testviertel"));
    expect(f.district).toEqual(fact("Testviertel", "12345 Teststadt Testviertel"));
    expect(f.street).toEqual(fact("Teststraße 12", "Teststraße 12"));
    expect(f.coordinates).toEqual(
      fact({ lat: 12.345678, lng: 23.456789 }, '"lat":12.345678,"lng":23.456789'),
    );
  });
});
