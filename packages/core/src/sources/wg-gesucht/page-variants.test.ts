import { describe, expect, it } from "vitest";
import { fact, fixture, offer } from "./testing.js";

describe("per-night page", () => {
  const page = offer("per-night");
  const f = page.facts;

  it("converts a per-night or per-day price to a monthly one at 30 days, marked converted", () => {
    expect(f.warmRent).toEqual(
      fact({ amount: 2100, converted: true }, "Gesamtmiete pro Nacht: 70€"),
    );
    expect(f.baseRent).toEqual(fact({ amount: 1800, converted: true }, "Miete pro Tag: 60€"));
    expect(f.utilities).toEqual(fact({ amount: 300, converted: true }, "Nebenkosten: 10€"));
    expect(f.otherCosts).toEqual(fact({ amount: 0, converted: true }, "Sonstige Kosten: 0€"));
  });

  it("leaves a one-off deposit as stated", () => {
    expect(f.deposit).toEqual(fact({ amount: 200, converted: false }, "Kaution: 200€"));
  });

  it("is an overnight stay with a start and an end", () => {
    expect(f.rentType).toEqual(fact("overnight", 'setTargeting("wgg_rent_type", "2")'));
    expect(f.availableFrom?.value).toBe("2026-12-20");
    expect(f.availableUntil?.value).toBe("2026-12-27");
    expect(page.online).toEqual({ kind: "relative", minutes: 60 });
  });

  it("computes rent per m² from the converted rent", () => {
    expect(f.rentPerSqm?.value).toBe(46.67);
  });

  it("reads no pictures from the ad targeting, and quotes it", () => {
    const quote = 'setTargeting("wgg_pic", "0")';
    expect(f.photoCount).toEqual(fact(0, quote));
    expect(f.imageUrls).toEqual(fact([], quote));
  });

  it("leaves photos unknown when there is no gallery and the targeting does not say", () => {
    const html = fixture("per-night").replace(/.*wgg_pic.*\n/, "");
    const g = offer("per-night", html).facts;
    expect(g.photoCount).toEqual(fact("unknown", ""));
    expect(g.imageUrls).toEqual(fact("unknown", ""));
  });
});

describe("translated page", () => {
  const page = offer("translated");
  const f = page.facts;

  it("takes the Advertiser's own text and never the machine translation", () => {
    expect(page.text.title).toBe("Bright room in a quiet flat");
    expect(page.text.sections).toEqual([
      { label: "Zimmer", text: "Bright room.\nRegistration is possible." },
    ]);
  });

  it("records that a translation was shown, so the original is not German", () => {
    expect(f.offerLanguage).toEqual(
      fact("other", "Text automatisch übersetzt - Original anzeigen"),
    );
  });

  it("reads (0w,0m,0d,0n) as unknown flatmates", () => {
    expect(f.flatmates).toEqual(fact("unknown", "3er WG (0w,0m,0d,0n)"));
    expect(f.flatshareSize).toEqual(fact(3, "3er WG (0w,0m,0d,0n)"));
  });

  it("leaves a cost row the page does not have unknown, and the costs unknown to be complete", () => {
    expect(f.utilities).toEqual(fact("unknown", ""));
    expect(f.costsComplete).toEqual(fact("unknown", ""));
    expect(f.warmRent).toEqual(fact({ amount: 540, converted: false }, "Gesamtmiete: 540€"));
  });

  it("reads a limited stay", () => {
    expect(f.rentType?.value).toBe("limited");
    expect(f.availableUntil).toEqual(fact("2027-07-31", "frei bis: 31.07.2027"));
  });
});

describe("deactivated page", () => {
  const page = offer("deactivated");

  it("is reported as deactivated, and the ad is still parsed", () => {
    expect(page.status).toBe("deactivated");
    expect(page.adId).toBe("1000007");
    expect(page.facts.warmRent).toEqual(
      fact({ amount: 780, converted: false }, "Gesamtmiete: 780€"),
    );
  });

  it("has no activity, and no availability", () => {
    expect(page.online).toBeUndefined();
    expect(page.facts.availableFrom).toEqual(fact("unknown", "frei ab: n.a."));
  });
});
