import { describe, expect, it } from "vitest";
import { fact, fixture, offer } from "./testing.js";

const flatshareHtml = fixture("flatshare");
const variant = (from: string | RegExp, to: string) => {
  expect(flatshareHtml).toMatch(from);
  return offer("flatshare", flatshareHtml.replace(from, to)).facts;
};

describe("Angaben zum Objekt", () => {
  const f = offer("flatshare").facts;

  it("reads furnished, floor, building type and accessibility", () => {
    expect(f.furnished).toEqual(fact("furnished", "möbliert"));
    expect(f.floor).toEqual(fact("2. OG", "2. OG"));
    expect(f.buildingType).toEqual(fact("Altbau", "Altbau"));
    expect(f.accessible).toEqual(fact(true, "Barrierefrei"));
  });

  it("reads the comma lists", () => {
    expect(f.bathroom).toEqual(fact(["Dusche", "Badewanne"], "Dusche, Badewanne"));
    expect(f.internet).toEqual(fact(["DSL", "WLAN"], "DSL, WLAN"));
    expect(f.tv).toEqual(fact(["Kabel"], "Kabel"));
    expect(f.flooring).toEqual(fact(["Parkett"], "Parkett"));
    expect(f.heating).toEqual(fact(["Zentralheizung"], "Zentralheizung"));
    expect(f.parking).toEqual(fact(["Bewohnerparken"], "Bewohnerparken"));
    expect(f.greenElectricity).toEqual(fact(true, "Ökostrom"));
  });

  it("reads transit minutes, amenities and pets allowed", () => {
    expect(f.transitMinutes).toEqual(fact(5, "5 Minuten zu Fuß entfernt"));
    expect(f.amenities).toEqual(
      fact(
        ["washing_machine", "balcony", "bike_cellar"],
        "Waschmaschine, Balkon, Fahrradkeller, Haustiere erlaubt",
      ),
    );
    expect(f.petsAllowed).toEqual(fact(true, "Haustiere erlaubt"));
  });

  it("leaves an item the page does not list as unknown, never as a no", () => {
    expect(f.energyCertificate).toEqual(fact("unknown", ""));
    const g = variant(
      /<div class="text-center"><span class="mdi mdi-plus-circle-outline[\s\S]*?<\/div>/,
      "",
    );
    expect(g.petsAllowed).toEqual(fact("unknown", ""));
    expect(g.amenities).toEqual(fact("unknown", ""));
  });

  it("reads partly furnished and unfurnished", () => {
    expect(variant("> möbliert<", "> teilmöbliert<").furnished?.value).toBe("partly_furnished");
    expect(variant("> möbliert<", "> unmöbliert<").furnished?.value).toBe("unfurnished");
  });
});

describe("advertiser box", () => {
  const f = offer("flatshare").facts;

  it("reads Verifiziert, member since, company profile and phone from the first box only", () => {
    expect(f.verified).toEqual(fact(true, "Verifiziert"));
    expect(f.memberSince).toEqual(fact("2026-10", "Mitglied seit Oktober 2026"));
    expect(f.companyProfile).toEqual(
      fact(
        "/profile/company/beispiel-verwaltung.55.html",
        "/profile/company/beispiel-verwaltung.55.html",
      ),
    );
    expect(f.phoneGiven).toEqual(fact(true, "Telefonnummer anzeigen"));
  });

  it("reports no Verifiziert badge and no phone as false, since the box is shown without them", () => {
    const g = variant(/<a href="\/fuer-immobilienprofis[\s\S]*?<\/a>/, "");
    expect(g.verified).toEqual(fact(false, "Mitglied seit Oktober 2026"));
    const h = variant(/<button class="auth_required">[\s\S]*?<\/button>/, "");
    expect(h.phoneGiven).toEqual(fact(false, "Mitglied seit Oktober 2026"));
  });

  it("leaves everything unknown when the page has no advertiser box", () => {
    const g = variant(
      /<div class="user_profile_info">[\s\S]*?<\/div>\s*<div class="user_profile_info">[\s\S]*?<\/div>/,
      "",
    );
    for (const key of ["verified", "memberSince", "companyProfile", "phoneGiven"] as const) {
      expect(g[key], key).toEqual(fact("unknown", ""));
    }
  });
});

describe("required documents and SCHUFA", () => {
  const f = offer("flatshare").facts;

  it("reads every selected document, including the ones hidden behind '+N weitere'", () => {
    expect(f.requiredDocuments).toEqual(
      fact(
        [
          "applicant_portfolio",
          "id_copy",
          "proof_of_income",
          "self_disclosure",
          "enrolment_certificate",
          "credit_check",
        ],
        "Bewerbermappe / Ausweis/ID / Einkommensnachweis / Mieterselbstauskunft / Immatrikulationsbescheinigung / itsmydata oder SCHUFA",
      ),
    );
  });

  it("flags a SCHUFA request from the cost label", () => {
    expect(f.schufaRequested).toEqual(fact(true, "SCHUFA-Auskunft erwünscht:"));
  });

  it("reads the plain 'SCHUFA-Auskunft:' label as no request, even with a credit-check document", () => {
    const g = variant("SCHUFA-Auskunft erwünscht:", "SCHUFA-Auskunft:");
    expect(g.schufaRequested).toEqual(fact(false, "SCHUFA-Auskunft:"));
  });

  it("leaves SCHUFA unknown when the cost block has no SCHUFA label, whatever else it shows", () => {
    const g = variant(
      /<span class="section_panel_detail">SCHUFA-Auskunft erwünscht:<\/span><span class="section_panel_value">[\s\S]*?<\/a><\/span>/,
      "",
    );
    expect(g.schufaRequested).toEqual(fact("unknown", ""));
    expect(g.deposit?.value).not.toBe("unknown");
  });

  it("leaves documents unknown when the section is missing", () => {
    const g = variant(
      /<h2>Benötigte Unterlagen<\/h2>[\s\S]*?(?=<div class="user_profile_info">)/,
      "",
    );
    expect(g.requiredDocuments).toEqual(fact("unknown", ""));
  });
});

describe("photos and language", () => {
  const f = offer("flatshare").facts;

  it("reads the photo count and the Source image URLs, with the stray '/./' removed", () => {
    expect(f.photoCount).toEqual(fact(3, "3 Fotos"));
    expect(f.imageUrls?.value).toEqual([
      "https://img.wg-gesucht.de/media/up/2026/45/bbbb000000000000000000000000000000000000000000000000000000000001_zimmer-1.large.jpg",
      "https://img.wg-gesucht.de/media/up/2026/45/bbbb000000000000000000000000000000000000000000000000000000000002_zimmer-2.large.jpg",
      "https://img.wg-gesucht.de/media/up/2026/45/bbbb000000000000000000000000000000000000000000000000000000000003_zimmer-3.large.jpg",
    ]);
  });

  it("says the page showed no translation when there was none", () => {
    expect(f.offerLanguage).toEqual(fact("german", "Helles Zimmer in ruhiger Studenten-WG"));
  });
});
