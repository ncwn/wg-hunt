import { describe, expect, it } from "vitest";
import { DAY, doubtful, fact, NOW } from "../ranking/test-helpers.js";
import { assessScam, type ScamInput } from "./assess.js";
import type { RentBaseline } from "./baseline.js";

const field = <T>(value: T, quote = "field quote") => fact(value, { origin: "field", quote });

const said = (kind: string, quote = `text about ${kind}`) => fact(kind, { quote });

const NEW_ACCOUNT = {
  verified: field(false),
  memberSince: field("2026-10", "Mitglied seit Oktober 2026"),
};
const OLD_ACCOUNT = {
  verified: field(false),
  memberSince: field("2019-03", "Mitglied seit März 2019"),
};

const baseline = (extra: Partial<RentBaseline> = {}): RentBaseline => ({
  median: 20,
  count: 23,
  district: "Neukölln",
  ...extra,
});

function assess(facts: Record<string, unknown> = {}, extra: Partial<ScamInput> = {}) {
  return assessScam({
    facts: { category: "flatshare-room", ...facts } as ScamInput["facts"],
    now: NOW,
    ...extra,
  });
}

const kinds = (result: ReturnType<typeof assess>) => result.signals.map((s) => s.kind);

describe("an Offer with no signals", () => {
  it("is not a Likely scam and says so", () => {
    expect(assess()).toMatchObject({
      likelyScam: false,
      computedLikelyScam: false,
      mark: null,
      signals: [],
      cautions: [],
      strong: 0,
      soft: 0,
    });
  });

  it("is not made suspicious by what is not a signal: SCHUFA, documents, Ablöse, a high price", () => {
    const result = assess({
      schufaRequested: field(true, "SCHUFA-Auskunft erwünscht"),
      requiredDocuments: field(["credit_check", "enrolment_certificate"], "Dokumente"),
      equipmentFee: field({ amount: 4000, converted: false }, "Ablöse: 4000 €"),
      warmRent: field({ amount: 3500, converted: false }, "Gesamtmiete: 3500 €"),
      rentPerSqm: field(90, "90"),
    });
    expect(result.signals).toEqual([]);
    expect(result.likelyScam).toBe(false);
  });
});

describe("text signals (read by the model)", () => {
  it.each([["money_before_viewing"], ["keys_by_post"], ["cannot_show_in_person"]])(
    "%s is strong: one is enough for a Likely scam",
    (kind) => {
      const result = assess({ scamSignals: [said(kind, "Bitte erst überweisen")] });
      expect(result).toMatchObject({ likelyScam: true, strong: 1, soft: 0, cautions: [] });
      expect(result.signals).toEqual([
        expect.objectContaining({
          kind,
          strength: "strong",
          origin: "text",
          quote: "Bitte erst überweisen",
          doubtful: false,
        }),
      ]);
    },
  );

  it.each([["off_platform_contact"], ["id_copy_upfront"], ["deposit_over_three_months"]])(
    "%s is soft",
    (kind) => {
      const result = assess({ scamSignals: [said(kind)] });
      expect(result.signals).toEqual([expect.objectContaining({ kind, strength: "soft" })]);
      expect(result.likelyScam).toBe(false);
    },
  );

  it("counts a kind once however often the model lists it", () => {
    const result = assess({
      scamSignals: [said("off_platform_contact", "a"), said("off_platform_contact", "b")],
    });
    expect(result.soft).toBe(1);
  });

  it("ignores a list entry whose value is unknown", () => {
    const result = assess({
      scamSignals: [doubtful<string>("unknown", "Western Union")],
    });
    expect(result.signals).toEqual([]);
  });

  it("counts a Doubtful signal as soft whatever its kind, and marks it", () => {
    const result = assess({ scamSignals: [doubtful("money_before_viewing", "Western Union")] });
    expect(result.signals).toEqual([
      expect.objectContaining({
        kind: "money_before_viewing",
        strength: "soft",
        doubtful: true,
        quote: "Western Union",
      }),
    ]);
    expect(result.likelyScam).toBe(false);
    expect(result.cautions).toHaveLength(1);
  });

  it("lists strong signals before soft ones", () => {
    const result = assess({
      scamSignals: [said("off_platform_contact"), said("keys_by_post")],
    });
    expect(kinds(result)).toEqual(["keys_by_post", "off_platform_contact"]);
  });
});

describe("the verdict", () => {
  const soft = (n: number) =>
    ["off_platform_contact", "id_copy_upfront", "deposit_over_three_months"]
      .slice(0, n)
      .map((kind) => said(kind));

  it("one strong signal: Likely scam", () => {
    expect(assess({ scamSignals: [said("keys_by_post")] }).likelyScam).toBe(true);
  });

  it("two soft signals: caution chips only", () => {
    const result = assess({ scamSignals: soft(2) });
    expect(result.likelyScam).toBe(false);
    expect(result.cautions.map((s) => s.kind)).toEqual(["off_platform_contact", "id_copy_upfront"]);
  });

  it("three soft signals: Likely scam, with no separate cautions", () => {
    const result = assess({ scamSignals: soft(3) });
    expect(result).toMatchObject({ likelyScam: true, computedLikelyScam: true, soft: 3 });
    expect(result.cautions).toEqual([]);
  });

  it("a strong and a soft signal are both listed as reasons", () => {
    const result = assess({ scamSignals: [said("off_platform_contact"), said("keys_by_post")] });
    expect(result.strong).toBe(1);
    expect(result.soft).toBe(1);
    expect(result.signals.every((s) => s.quote !== undefined && s.message !== "")).toBe(true);
  });
});

describe("new unverified account", () => {
  const kindsFor = (facts: Record<string, unknown>, now = NOW) => kinds(assess(facts, { now }));

  it("fires for an account that joined this month and is not Verifiziert", () => {
    const result = assess(NEW_ACCOUNT);
    expect(result.signals).toEqual([
      expect.objectContaining({
        kind: "new_unverified_account",
        strength: "soft",
        origin: "derived",
        quote: "Mitglied seit Oktober 2026",
      }),
    ]);
    expect(result.signals[0]?.evidence).toMatch(/2026-10/);
  });

  it("counts a month-only join date as the middle of the month", () => {
    const october15 = Date.parse("2026-10-15T00:00:00Z");
    expect(kindsFor(NEW_ACCOUNT, october15 + 30 * DAY)).toEqual(["new_unverified_account"]);
    expect(kindsFor(NEW_ACCOUNT, october15 + 31 * DAY)).toEqual([]);
  });

  it("is silent for an account that is older than 30 days", () => {
    expect(kindsFor(OLD_ACCOUNT)).toEqual([]);
  });

  it("never fires for a Verifiziert Advertiser", () => {
    expect(kindsFor({ ...NEW_ACCOUNT, verified: field(true, "Verifiziert") })).toEqual([]);
  });

  it("never fires for a company Advertiser", () => {
    expect(
      kindsFor({
        ...NEW_ACCOUNT,
        companyProfile: field("/profile/company/12", "/profile/company/12"),
      }),
    ).toEqual([]);
  });

  it("is silent when Verifiziert or the join date is unknown", () => {
    expect(kindsFor({ ...NEW_ACCOUNT, verified: fact<never>("unknown") })).toEqual([]);
    expect(kindsFor({ ...NEW_ACCOUNT, memberSince: fact<never>("unknown") })).toEqual([]);
    expect(kindsFor({ verified: field(false) })).toEqual([]);
  });
});

describe("rent below the district median", () => {
  const cheap = (rent: number, extra: Record<string, unknown> = {}) => ({
    warmRent: field({ amount: 400, converted: false }, "Gesamtmiete: 400 €"),
    rentPerSqm: field(rent, "400 € / 20 m²"),
    ...extra,
  });

  it("fires under 60% of the median, showing the baseline as evidence", () => {
    const result = assess(cheap(11.99), { baseline: baseline() });
    expect(result.signals).toEqual([
      expect.objectContaining({
        kind: "rent_below_median",
        strength: "soft",
        origin: "derived",
        quote: "400 € / 20 m²",
        evidence: expect.stringContaining("district median €20.00/m² from 23 Offers"),
      }),
    ]);
  });

  it("names the Offer's own rent in the evidence", () => {
    const result = assess(cheap(9.2), { baseline: baseline({ median: 18.4, count: 23 }) });
    expect(result.signals[0]?.evidence).toBe(
      "warm rent €9.20/m² is under 60% of the district median €18.40/m² from 23 Offers",
    );
  });

  it("is silent at exactly 60% and above", () => {
    expect(kinds(assess(cheap(12), { baseline: baseline() }))).toEqual([]);
    expect(kinds(assess(cheap(15), { baseline: baseline() }))).toEqual([]);
  });

  it("is silent under 15 comparable Offers", () => {
    expect(kinds(assess(cheap(5), { baseline: baseline({ count: 14 }) }))).toEqual([]);
    expect(kinds(assess(cheap(5), { baseline: baseline({ count: 15 }) }))).toEqual([
      "rent_below_median",
    ]);
  });

  it("is silent without a baseline or without a rent per m²", () => {
    expect(kinds(assess(cheap(5)))).toEqual([]);
    expect(kinds(assess(cheap(5), { baseline: null }))).toEqual([]);
    expect(kinds(assess({ warmRent: cheap(5).warmRent }, { baseline: baseline() }))).toEqual([]);
    expect(kinds(assess({ rentPerSqm: fact<never>("unknown") }, { baseline: baseline() }))).toEqual(
      [],
    );
  });

  it("is silent for a rent converted from a per-night price", () => {
    const converted = cheap(5, {
      warmRent: field({ amount: 300, converted: true }, "Gesamtmiete: 10 € pro Nacht"),
    });
    expect(kinds(assess(converted, { baseline: baseline() }))).toEqual([]);
  });
});

describe("price mismatch", () => {
  const rentOf = (amount: number, alternative: number | null, key = "warmRent") => ({
    [key]: {
      ...field({ amount, converted: false }, "Gesamtmiete: 650 €"),
      ...(alternative !== null && {
        alternatives: [
          {
            value: { amount: alternative, converted: false },
            origin: "text",
            quote: `nur ${alternative} Euro`,
          },
        ],
      }),
    },
  });

  it("fires when the text names another warm rent than the field", () => {
    const result = assess(rentOf(650, 450));
    expect(result.signals).toEqual([
      expect.objectContaining({
        kind: "price_mismatch",
        strength: "soft",
        origin: "derived",
        quote: "nur 450 Euro",
        evidence: "the text says €450, the field says €650",
      }),
    ]);
  });

  it("also fires on the cold rent", () => {
    expect(kinds(assess(rentOf(500, 300, "baseRent")))).toEqual(["price_mismatch"]);
  });

  it("is silent when the text and the field agree, or there is no text price", () => {
    expect(kinds(assess(rentOf(650, null)))).toEqual([]);
    expect(kinds(assess(rentOf(650, 650)))).toEqual([]);
  });

  it("does not read other costs (utilities, Kaution) as the rent", () => {
    expect(kinds(assess(rentOf(100, 40, "utilities")))).toEqual([]);
  });
});

describe("Kaution over 3 months", () => {
  const money = (amount: number, quote: string) => field({ amount, converted: false }, quote);

  it("fires by rule when the Kaution is over 3 months' cold rent", () => {
    const result = assess({
      baseRent: money(500, "Miete: 500 €"),
      deposit: money(1800, "Kaution: 1800 €"),
    });
    expect(result.signals).toEqual([
      expect.objectContaining({
        kind: "deposit_over_three_months",
        strength: "soft",
        origin: "derived",
        quote: "Kaution: 1800 €",
        evidence: "Kaution €1800 against a cold rent of €500 (3.6 months)",
      }),
    ]);
  });

  it("is silent at exactly 3 months, or when either is not known", () => {
    expect(kinds(assess({ baseRent: money(500, "m"), deposit: money(1500, "k") }))).toEqual([]);
    expect(kinds(assess({ deposit: money(5000, "k") }))).toEqual([]);
    expect(kinds(assess({ baseRent: money(500, "m"), deposit: fact<never>("unknown") }))).toEqual(
      [],
    );
  });

  it("is one signal when the model read it too, keeping the Offer's words and the arithmetic", () => {
    const result = assess({
      baseRent: money(500, "Miete: 500 €"),
      deposit: money(1800, "Kaution: 1800 €"),
      scamSignals: [said("deposit_over_three_months", "Kaution: vier Monatsmieten")],
    });
    expect(result.signals).toEqual([
      expect.objectContaining({
        kind: "deposit_over_three_months",
        origin: "text",
        quote: "Kaution: vier Monatsmieten",
        evidence: "Kaution €1800 against a cold rent of €500 (3.6 months)",
      }),
    ]);
    expect(result.soft).toBe(1);
  });

  it("is silent for a rent converted from a per-night price", () => {
    expect(
      kinds(
        assess({
          baseRent: field({ amount: 500, converted: true }, "m"),
          deposit: money(5000, "k"),
        }),
      ),
    ).toEqual([]);
  });
});

describe("Cloned offer", () => {
  const original = (memberSince: string | null, extra = {}) => ({
    offerId: 7,
    memberSince,
    sharedImages: 4,
    textSimilarity: 0.93,
    ...extra,
  });

  it("is strong when the copier joined after the original's Advertiser and is not Verifiziert", () => {
    const result = assess(NEW_ACCOUNT, { originals: [original("2019-03")] });
    expect(result.signals.find((s) => s.kind === "cloned_offer")).toMatchObject({
      strength: "strong",
      origin: "derived",
      evidence: expect.stringContaining("Offer 7"),
    });
    expect(result.likelyScam).toBe(true);
  });

  it("is soft when the copier is Verifiziert", () => {
    const result = assess(
      { verified: field(true, "Verifiziert"), memberSince: field("2026-10") },
      { originals: [original("2019-03")] },
    );
    expect(result.signals).toEqual([
      expect.objectContaining({ kind: "cloned_offer", strength: "soft" }),
    ]);
    expect(result.likelyScam).toBe(false);
  });

  it("is soft when the copier's account is older than the original's", () => {
    const result = assess(OLD_ACCOUNT, { originals: [original("2024-01")] });
    expect(result.signals).toEqual([
      expect.objectContaining({ kind: "cloned_offer", strength: "soft" }),
    ]);
  });

  it("is soft when both joined in the same month", () => {
    const result = assess(OLD_ACCOUNT, { originals: [original("2019-03")] });
    expect(result.signals[0]).toMatchObject({ kind: "cloned_offer", strength: "soft" });
  });

  it("is soft when either join date is unknown, or the copier's Verifiziert is", () => {
    const clonedOf = (result: ReturnType<typeof assess>) =>
      result.signals.find((s) => s.kind === "cloned_offer");
    expect(clonedOf(assess(NEW_ACCOUNT, { originals: [original(null)] }))).toMatchObject({
      strength: "soft",
    });
    const unknownDate = assess({ verified: field(false) }, { originals: [original("2019-03")] });
    expect(clonedOf(unknownDate)).toMatchObject({ strength: "soft" });
  });

  it("is one signal, strong when any original makes it strong", () => {
    const result = assess(NEW_ACCOUNT, {
      originals: [original("2026-10", { offerId: 3 }), original("2019-03", { offerId: 9 })],
    });
    const cloned = result.signals.filter((s) => s.kind === "cloned_offer");
    expect(cloned).toHaveLength(1);
    expect(cloned[0]).toMatchObject({
      strength: "strong",
      evidence: expect.stringContaining("Offer 9"),
    });
  });

  it("is silent when the Offer copies nobody", () => {
    expect(kinds(assess(NEW_ACCOUNT, { originals: [] }))).toEqual(["new_unverified_account"]);
  });
});

describe("the seeker's mark", () => {
  const strong = { scamSignals: [said("keys_by_post", "Schlüssel per Post")] };

  it("'not a scam' overrides a computed Likely scam, and the signals stay listed", () => {
    const result = assess(strong, { mark: "not" });
    expect(result).toMatchObject({ likelyScam: false, computedLikelyScam: true, mark: "not" });
    expect(result.signals).toHaveLength(1);
    expect(result.cautions).toEqual([]);
  });

  it("'scam' makes a Likely scam of an Offer with no signals at all", () => {
    expect(assess({}, { mark: "scam" })).toMatchObject({
      likelyScam: true,
      computedLikelyScam: false,
      mark: "scam",
    });
  });

  it("clearing the mark restores the computed verdict", () => {
    expect(assess(strong, { mark: null }).likelyScam).toBe(true);
    expect(assess(strong, { mark: undefined }).likelyScam).toBe(true);
    expect(assess({}, { mark: null }).likelyScam).toBe(false);
  });

  it("'not a scam' also silences the caution chips", () => {
    const result = assess(NEW_ACCOUNT, { mark: "not" });
    expect(result.cautions).toEqual([]);
    expect(result.signals).toHaveLength(1);
  });
});
