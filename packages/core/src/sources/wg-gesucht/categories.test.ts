import { describe, expect, it } from "vitest";
import { ctx, fact, fixture, offer } from "./testing.js";

const FLATSHARE_ONLY = [
  "flatmates",
  "flatshareSize",
  "flatmateAges",
  "genderSought",
  "ageSought",
  "flatshareTypes",
  "languages",
  "smoking",
  "petsPresent",
] as const;

describe("1-room flat", () => {
  const page = offer("one-room-flat");
  const f = page.facts;

  it("is told apart from the other categories by the page itself", () => {
    expect(page.category).toBe("one-room-flat");
  });

  it("leaves out every fact that does not apply, rather than marking it unknown", () => {
    for (const key of [...FLATSHARE_ONLY, "rooms", "offeredAsWg"]) {
      expect(f, key).not.toHaveProperty(key);
    }
  });

  it("reads the flat size and the kitchen", () => {
    expect(f.flatSize).toEqual(fact(29, "Größe: 29m²"));
    expect(f.roomSize).toEqual(fact(29, "Größe: 29m²"));
    expect(f.kitchen).toEqual(fact(["Eigene Küche"], "Eigene Küche"));
  });

  it("reads n.a. as unknown, never 0, and 0€ as zero", () => {
    expect(f.utilities).toEqual(fact("unknown", "Nebenkosten: n.a."));
    expect(f.otherCosts).toEqual(fact({ amount: 0, converted: false }, "Sonstige Kosten: 0€"));
    expect(f.equipmentFee).toEqual(fact({ amount: 0, converted: false }, "Ablösevereinbarung: 0€"));
  });

  it("flags the costs as incomplete when the utilities are n.a.", () => {
    expect(f.costsComplete).toEqual(fact(false, "Nebenkosten: n.a."));
  });

  it("reads a Kaution that has no € sign", () => {
    expect(f.deposit).toEqual(fact({ amount: 1800, converted: false }, "Kaution: 1800"));
  });

  it("computes rent per m² from the warm rent and the flat size", () => {
    expect(f.rentPerSqm).toEqual(fact(22.41, "Gesamtmiete: 650€ / Größe: 29m²"));
  });

  it("resolves 'sofort' to the day the Offer was first seen, in Europe/Berlin", () => {
    expect(f.availableFrom).toEqual(fact("2026-11-04", "frei ab: sofort"));
    const lateEvening = offer("one-room-flat", fixture("one-room-flat"), {
      firstSeen: new Date("2026-11-04T23:30:00Z"),
    });
    expect(lateEvening.facts.availableFrom?.value).toBe("2026-11-05");
  });

  it("leaves a missing street, coordinates and documents unknown", () => {
    expect(f.street).toEqual(fact("unknown", ""));
    expect(f.coordinates).toEqual(fact("unknown", ""));
    expect(f.requiredDocuments).toEqual(fact("unknown", ""));
    expect(f.postalCode).toEqual(fact("12345", "12345 Teststadt Testviertel"));
  });

  it("parses a relative age in days", () => {
    expect(page.online).toEqual({ kind: "relative", minutes: 3 * 24 * 60 });
  });

  it("reads a private new account: not verified, no phone, no company profile", () => {
    expect(f.verified).toEqual(fact(false, "Mitglied seit November 2026"));
    expect(f.memberSince).toEqual(fact("2026-11", "Mitglied seit November 2026"));
    expect(f.phoneGiven).toEqual(fact(false, "Mitglied seit November 2026"));
    expect(f.companyProfile).toEqual(fact("unknown", ""));
    expect(f.schufaRequested).toEqual(fact(false, "SCHUFA-Auskunft:"));
  });
});

describe("flat", () => {
  const page = offer("flat");
  const f = page.facts;

  it("is a flat, with a number of rooms read with a decimal comma", () => {
    expect(page.category).toBe("flat");
    expect(f.rooms).toEqual(fact(2.5, "Zimmer: 2,5"));
    expect(f.flatSize).toEqual(fact(64, "Größe: 64m²"));
    expect(f.roomSize).toEqual(fact(64, "Größe: 64m²"));
  });

  it("leaves out flatshare facts", () => {
    for (const key of FLATSHARE_ONLY) expect(f, key).not.toHaveProperty(key);
  });

  it("reads a limited stay and a date for 'Online:'", () => {
    expect(f.rentType).toEqual(fact("limited", 'setTargeting("wgg_rent_type", "1")'));
    expect(f.availableFrom).toEqual(fact("2027-01-15", "frei ab: 15.01.2027"));
    expect(f.availableUntil).toEqual(fact("2027-06-30", "frei bis: 30.06.2027"));
    expect(page.online).toEqual({ kind: "date", date: "2026-10-30" });
  });

  it("reads floor, furnishing and amenities, leaving what is not listed unknown", () => {
    expect(f.floor).toEqual(fact("3. OG", "3. OG"));
    expect(f.furnished).toEqual(fact("partly_furnished", "teilmöbliert"));
    expect(f.amenities).toEqual(fact(["balcony", "dishwasher"], "Balkon, Spülmaschine"));
    expect(f.petsAllowed).toEqual(fact("unknown", ""));
    expect(f.offeredAsWg).toEqual(fact("unknown", ""));
  });

  it("computes rent per m² and a complete cost picture", () => {
    expect(f.rentPerSqm).toEqual(fact(15.31, "Gesamtmiete: 980€ / Größe: 64m²"));
    expect(f.costsComplete).toEqual(fact(true, "Nebenkosten: 150€"));
    expect(f.equipmentFee).toEqual(
      fact({ amount: 500, converted: false }, "Ablösevereinbarung: 500€"),
    );
  });

  it("takes the category the crawler knows over the one the page suggests", () => {
    const hinted = offer("flat", fixture("flat"), { ...ctx, category: "house" });
    expect(hinted.category).toBe("house");
    expect(hinted.facts).toHaveProperty("offeredAsWg");
  });
});

describe("house", () => {
  const page = offer("house");
  const f = page.facts;

  it("is a house offered as a WG", () => {
    expect(page.category).toBe("house");
    expect(f.rooms).toEqual(fact(5, "Zimmer: 5"));
    expect(f.roomSize).toEqual(fact(140, "Größe: 140m²"));
    expect(f.offeredAsWg).toEqual(fact(true, "WG geeignet"));
    for (const key of FLATSHARE_ONLY) expect(f, key).not.toHaveProperty(key);
  });

  it("reads the energy certificate without the legal blurb", () => {
    expect(f.energyCertificate).toEqual(
      fact(
        {
          type: "consumption",
          energyValue: "117kW h/(m²a)",
          energySource: "Fernwärme",
          buildYear: 1921,
          efficiencyClass: "B",
        },
        "Verbrauchsausweis, V: 117kW h/(m²a), Fernwärme, Baujahr 1921, Energieeffizienzklasse B",
      ),
    );
  });

  it("reads amenities and pets allowed, and a deposit that is n.a.", () => {
    expect(f.amenities?.value).toEqual(["garden", "cellar"]);
    expect(f.petsAllowed).toEqual(fact(true, "Haustiere erlaubt"));
    expect(f.deposit).toEqual(fact("unknown", "Kaution: n.a."));
  });

  it("reads a verified company with its profile", () => {
    expect(f.verified?.value).toBe(true);
    expect(f.companyProfile?.value).toBe("/profile/company/haus-verwaltung.77.html");
    expect(f.phoneGiven).toEqual(fact(false, "Mitglied seit März 2019"));
  });

  it("recognises a house from the page title when the URL does not say", () => {
    const html = fixture("house").replace("haeuser-in-", "objekt-in-");
    expect(offer("house", html).category).toBe("house");
  });
});
