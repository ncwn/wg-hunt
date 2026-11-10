import { describe, expect, it } from "vitest";
import { assessScam } from "../scam/assess.js";
import { rankOffer } from "./rank.js";
import { fact, NOW, offer, reasonFor, seeking } from "./test-helpers.js";

const field = <T>(value: T, quote: string) => fact(value, { origin: "field", quote });

function rankScam(
  facts: Record<string, unknown>,
  mark: "scam" | "not" | null = null,
  hide = false,
) {
  const rankable = offer(facts);
  const scam = assessScam({ facts: rankable.facts, now: NOW, mark });
  return rankOffer(
    { ...rankable, scam },
    seeking({}, hide ? { hideLikelyScams: { enabled: true } } : {}),
  );
}

const strong = { scamSignals: [fact("keys_by_post", { quote: "Schlüssel per Post" })] };
const twoSoft = {
  scamSignals: [
    fact("off_platform_contact", { quote: "schreib mir auf WhatsApp" }),
    fact("id_copy_upfront", { quote: "Ausweiskopie vorab" }),
  ],
};
const newAccount = {
  verified: field(false, "Mitglied seit Oktober 2026"),
  memberSince: field("2026-10", "Mitglied seit Oktober 2026"),
};

describe("ranking with Scam signals", () => {
  it("puts a Likely scam in Warned", () => {
    expect(rankScam(strong).band).toBe("warned");
  });

  it("puts three soft signals in Warned", () => {
    const facts = { ...twoSoft, ...newAccount };
    expect(rankScam(facts).band).toBe("warned");
  });

  it("leaves two soft signals in their band, as caution chips with their quotes", () => {
    const result = rankScam(twoSoft);
    expect(result.band).toBe("match");
    expect(result.chips).toEqual([
      expect.objectContaining({
        kind: "scam-caution",
        tone: "warn",
        label: "Moves contact off the platform",
        quote: "schreib mir auf WhatsApp",
      }),
      expect.objectContaining({ kind: "scam-caution", quote: "Ausweiskopie vorab" }),
    ]);
  });

  it("shows a derived caution's evidence beside its quote", () => {
    const chip = rankScam(newAccount).chips[0];
    expect(chip).toMatchObject({ kind: "scam-caution", quote: "Mitglied seit Oktober 2026" });
    expect(chip?.evidence).toBe("member since 2026-10, not Verifiziert");
  });

  it("moves a Warned Offer to Hidden when hiding Likely scams is on", () => {
    const result = rankScam(strong, null, true);
    expect(result.band).toBe("hidden");
    expect(reasonFor(result, "hideLikelyScams")).toMatchObject({
      outcome: "fail",
      effect: "hidden",
    });
  });

  it("does not hide an Offer that is only cautioned", () => {
    expect(rankScam(twoSoft, null, true).band).toBe("match");
  });

  it("lets 'not a scam' lift a computed Likely scam out of Warned, with no chips", () => {
    const result = rankScam(strong, "not");
    expect(result.band).toBe("match");
    expect(result.chips).toEqual([]);
  });

  it("lets 'scam' warn about an Offer with no signals", () => {
    expect(rankScam({}, "scam").band).toBe("warned");
  });

  it("leaves an Offer with no assessment as it was", () => {
    expect(rankOffer(offer({}), seeking()).band).toBe("match");
  });
});
