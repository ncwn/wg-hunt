import { describe, expect, it } from "vitest";
import { checkOverride, isOverridable, overrideFacts } from "./overrides.js";
import type { OfferFacts } from "./schema.js";

const field = (value: unknown, quote: string) => ({ value, origin: "field" as const, quote });
const model = (value: unknown, quote: string) => ({
  value,
  origin: "text" as const,
  quote,
  confidence: { status: "doubtful" as const, reasons: ["model_ambiguous" as const] },
});

const facts = (over: Record<string, unknown> = {}) =>
  ({
    category: "flatshare-room",
    baseRent: field({ amount: 400, converted: false }, "Miete: 400 €"),
    anmeldung: model("unknown", ""),
    scamSignals: [model("money_before_viewing", "Überweisen Sie die Kaution vorab")],
    ...over,
  }) as unknown as OfferFacts;

describe("which facts a seeker can correct", () => {
  it("allows rule and model facts, and not the model's field/text conflicts or the photo list", () => {
    expect(isOverridable("anmeldung")).toBe(true);
    expect(isOverridable("baseRent")).toBe(true);
    expect(isOverridable("conflicts")).toBe(false);
    expect(isOverridable("imageUrls")).toBe(false);
    expect(isOverridable("favouriteColour")).toBe(false);
  });
});

describe("checking an override's value", () => {
  it("accepts a value of the fact's own shape and returns it as stored", () => {
    expect(checkOverride("anmeldung", "possible")).toEqual({ ok: true, value: "possible" });
    expect(checkOverride("baseRent", { amount: 600, converted: false })).toEqual({
      ok: true,
      value: { amount: 600, converted: false },
    });
  });

  it("accepts unknown, which says the Offer does not say", () => {
    expect(checkOverride("anmeldung", "unknown")).toEqual({ ok: true, value: "unknown" });
  });

  it("refuses a value the fact cannot have", () => {
    expect(checkOverride("anmeldung", "maybe").ok).toBe(false);
    expect(checkOverride("baseRent", 600).ok).toBe(false);
  });

  it("takes a list fact as a list of item values, which may be empty", () => {
    expect(checkOverride("scamSignals", [])).toEqual({ ok: true, value: [] });
    expect(checkOverride("scamSignals", ["keys_by_post"]).ok).toBe(true);
    expect(checkOverride("scamSignals", "keys_by_post").ok).toBe(false);
    expect(
      checkOverride("requirements", [{ kind: "diet", strictness: "required", value: "vegan" }]).ok,
    ).toBe(true);
  });

  it("refuses a fact that cannot be corrected", () => {
    expect(checkOverride("conflicts", []).ok).toBe(false);
  });
});

describe("laying overrides over the facts", () => {
  it("makes a manual fact that replaces the field's and keeps the old reading as an alternative", () => {
    const result = overrideFacts(facts(), [
      { key: "baseRent", value: { amount: 550, converted: false } },
    ]);
    expect(result.baseRent).toEqual({
      value: { amount: 550, converted: false },
      origin: "manual",
      quote: "",
      alternatives: [
        { value: { amount: 400, converted: false }, origin: "field", quote: "Miete: 400 €" },
      ],
    });
  });

  it("makes a manual fact of a model fact that was Doubtful, which is no longer Doubtful", () => {
    const result = overrideFacts(facts({ anmeldung: model("conditional", "evtl. Anmeldung") }), [
      { key: "anmeldung", value: "possible" },
    ]);
    expect(result.anmeldung).toMatchObject({ value: "possible", origin: "manual" });
    expect((result.anmeldung as { confidence?: unknown }).confidence).toBeUndefined();
  });

  it("gives a fact the Offer lacks (a model fact before analysis) its manual value", () => {
    const result = overrideFacts(facts({ anmeldung: undefined }), [
      { key: "anmeldung", value: "possible" },
    ]);
    expect(result.anmeldung).toEqual({ value: "possible", origin: "manual", quote: "" });
  });

  it("replaces a list fact with one manual fact per item, or none", () => {
    const some = overrideFacts(facts(), [
      { key: "scamSignals", value: ["keys_by_post", "id_copy_upfront"] },
    ]);
    expect(some.scamSignals).toEqual([
      { value: "keys_by_post", origin: "manual", quote: "" },
      { value: "id_copy_upfront", origin: "manual", quote: "" },
    ]);
    expect(overrideFacts(facts(), [{ key: "scamSignals", value: [] }]).scamSignals).toEqual([]);
  });

  it("leaves the facts alone without overrides, and does not change what it was given", () => {
    const original = facts();
    expect(overrideFacts(original, [])).toEqual(original);
    overrideFacts(original, [{ key: "baseRent", value: { amount: 1, converted: false } }]);
    expect((original.baseRent as { value: unknown }).value).toEqual({
      amount: 400,
      converted: false,
    });
  });

  it("skips an override for a fact that does not apply to the category", () => {
    const result = overrideFacts(facts({ category: "flat" }), [
      { key: "smoking", value: "not_wanted" },
    ]);
    expect(result.smoking).toBeUndefined();
  });

  it("applies a fact that only applies once another override says the flat is offered as a WG", () => {
    const flat = facts({ category: "flat" });
    const result = overrideFacts(flat, [
      { key: "genderSought", value: ["woman"] },
      { key: "offeredAsWg", value: true },
    ]);
    expect(result.genderSought).toMatchObject({ value: ["woman"], origin: "manual" });
  });
});

const euros = (amount: number) => ({ amount, converted: false });

const room = (over: Record<string, unknown> = {}) =>
  facts({
    warmRent: field(euros(600), "Gesamtmiete: 600€"),
    utilities: field(euros(100), "Nebenkosten: 100€"),
    costsComplete: field(true, "Nebenkosten: 100€"),
    roomSize: field(20, "Zimmergröße: 20m²"),
    flatSize: field(60, "Wohnungsgröße: 60m²"),
    rentPerSqm: field(30, "Gesamtmiete: 600€ / Zimmergröße: 20m²"),
    ...over,
  });

const flat = () =>
  facts({
    category: "flat",
    warmRent: field(euros(900), "Gesamtmiete: 900€"),
    roomSize: field(45, "Größe: 45m²"),
    flatSize: field(45, "Größe: 45m²"),
    rentPerSqm: field(20, "Gesamtmiete: 900€ / Größe: 45m²"),
  });

describe("derived facts follow a correction of their inputs", () => {
  it("works rent per m² out again from a corrected warm rent, as a Rules fact", () => {
    const result = overrideFacts(room(), [{ key: "warmRent", value: euros(500) }]);
    expect(result.rentPerSqm).toEqual({
      value: 25,
      origin: "field",
      quote: "your correction: 500 € / Zimmergröße: 20m²",
      alternatives: [
        { value: 30, origin: "field", quote: "Gesamtmiete: 600€ / Zimmergröße: 20m²" },
      ],
    });
  });
});

describe("derived facts follow a correction of their inputs, case by case", () => {
  it("works rent per m² out again from a corrected room size of a flatshare room", () => {
    const result = overrideFacts(room(), [{ key: "roomSize", value: 24 }]);
    expect(result.rentPerSqm).toMatchObject({
      value: 25,
      origin: "field",
      quote: "Gesamtmiete: 600€ / your correction: 24 m²",
    });
  });

  it("keeps a flatshare room's size and rent per m² apart from a corrected flat size", () => {
    const original = room();
    const result = overrideFacts(original, [{ key: "flatSize", value: 90 }]);
    expect(result.roomSize).toEqual(original.roomSize);
    expect(result.rentPerSqm).toEqual(original.rentPerSqm);
  });

  it("makes a flat's room size follow its corrected size, and its rent per m² with it", () => {
    const result = overrideFacts(flat(), [{ key: "flatSize", value: 50 }]);
    expect(result.roomSize).toEqual({
      value: 50,
      origin: "field",
      quote: "your correction: 50 m²",
      alternatives: [{ value: 45, origin: "field", quote: "Größe: 45m²" }],
    });
    expect(result.rentPerSqm).toEqual({
      value: 18,
      origin: "field",
      quote: "Gesamtmiete: 900€ / your correction: 50 m²",
      alternatives: [{ value: 20, origin: "field", quote: "Gesamtmiete: 900€ / Größe: 45m²" }],
    });
  });

  it("rounds a recomputed rent per m² to the cent, as the rules do", () => {
    const result = overrideFacts(room(), [{ key: "warmRent", value: euros(489) }]);
    expect(result.rentPerSqm?.value).toBe(24.45);
    const odd = overrideFacts(room(), [{ key: "roomSize", value: 18 }]);
    expect(odd.rentPerSqm?.value).toBe(33.33);
  });

  it("makes rent per m² unknown when the rent or the size is corrected to unknown", () => {
    for (const override of [
      { key: "warmRent", value: "unknown" },
      { key: "roomSize", value: "unknown" },
    ]) {
      expect(overrideFacts(room(), [override]).rentPerSqm).toMatchObject({
        value: "unknown",
        origin: "field",
      });
    }
    const flatUnknown = overrideFacts(flat(), [{ key: "flatSize", value: "unknown" }]);
    expect(flatUnknown.roomSize?.value).toBe("unknown");
    expect(flatUnknown.rentPerSqm?.value).toBe("unknown");
  });

  it("works rent per m² out from a corrected rent where the rules could not", () => {
    const result = overrideFacts(
      room({ warmRent: field("unknown", ""), rentPerSqm: field("unknown", "") }),
      [{ key: "warmRent", value: euros(500) }],
    );
    expect(result.rentPerSqm).toEqual({
      value: 25,
      origin: "field",
      quote: "your correction: 500 € / Zimmergröße: 20m²",
    });
  });

  it("makes costs complete once the utilities are corrected to a value, and not when to unknown", () => {
    const unstated = room({
      utilities: field("unknown", "Nebenkosten: n.a."),
      costsComplete: field(false, "Nebenkosten: n.a."),
    });
    expect(overrideFacts(unstated, [{ key: "utilities", value: euros(80) }]).costsComplete).toEqual(
      {
        value: true,
        origin: "field",
        quote: "your correction: 80 €",
        alternatives: [{ value: false, origin: "field", quote: "Nebenkosten: n.a." }],
      },
    );
    expect(
      overrideFacts(room(), [{ key: "utilities", value: "unknown" }]).costsComplete,
    ).toMatchObject({ value: false, origin: "field", quote: "your correction: unknown" });
    const noRow = room({ utilities: field("unknown", ""), costsComplete: field("unknown", "") });
    expect(
      overrideFacts(noRow, [{ key: "utilities", value: euros(80) }]).costsComplete?.value,
    ).toBe(true);
  });

  it("lets a correction of the derived fact itself win, whichever was set first", () => {
    const cases: [string, unknown, string, unknown][] = [
      ["rentPerSqm", 12, "warmRent", euros(500)],
      ["roomSize", 30, "flatSize", 50],
      ["costsComplete", false, "utilities", euros(80)],
    ];
    for (const [derived, own, input, value] of cases) {
      const base = derived === "roomSize" ? flat() : room();
      for (const order of [
        [
          { key: derived, value: own },
          { key: input, value },
        ],
        [
          { key: input, value },
          { key: derived, value: own },
        ],
      ]) {
        const result = overrideFacts(base, order) as unknown as Record<string, { value: unknown }>;
        expect(result[derived]).toMatchObject({ value: own, origin: "manual" });
      }
    }
  });

  it("works rent per m² out from a corrected room size of a flat, not from its flat size", () => {
    const result = overrideFacts(flat(), [
      { key: "roomSize", value: 30 },
      { key: "flatSize", value: 50 },
    ]);
    expect(result.roomSize).toMatchObject({ value: 30, origin: "manual" });
    expect(result.rentPerSqm?.value).toBe(30);
  });

  it("recomputes nothing without a correction to an input", () => {
    const original = room();
    const result = overrideFacts(original, [{ key: "baseRent", value: euros(1) }]);
    expect(result.rentPerSqm).toBe(original.rentPerSqm);
    expect(result.roomSize).toBe(original.roomSize);
    expect(result.costsComplete).toBe(original.costsComplete);
  });
});
