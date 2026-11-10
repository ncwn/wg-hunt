import { describe, expect, it } from "vitest";
import { defaultFilters } from "./filters.js";
import { defaultSeekerProfile } from "./profile.js";
import { hiddenCausesOf, rankOffer } from "./rank.js";
import { doubtful, fact, offer, rank, reasonFor, seeking } from "./test-helpers.js";

const likelyScam = { likelyScam: true, cautions: [] };

describe("neutral defaults", () => {
  it("carry no personal values", () => {
    expect(defaultSeekerProfile()).toEqual({
      gender: null,
      age: null,
      anmeldungNeeded: false,
      moveIn: { earliest: null, latest: null },
      stay: { minMonths: null, maxMonths: null },
      diet: null,
      occupation: null,
      smoker: null,
      hasPets: null,
      languages: [],
      places: [],
    });
  });

  it("ship max rent and min size present but unset", () => {
    const filters = defaultFilters();
    expect(filters.maxRent).toMatchObject({ enabled: true, strength: "dealbreaker", limit: null });
    expect(filters.maxRent.margin).toEqual({ value: 10, unit: "percent" });
    expect(filters.minSize).toMatchObject({ enabled: true, strength: "want", limit: null });
  });

  it("ship the default Dealbreakers and Wants on, and the rest off", () => {
    const f = defaultFilters();
    const on = (key: keyof typeof f, strength: string) =>
      expect([f[key].enabled, f[key].strength]).toEqual([true, strength]);
    on("anmeldung", "dealbreaker");
    on("genderSought", "dealbreaker");
    on("requirements", "dealbreaker");
    on("ageSought", "want");
    on("moveIn", "want");
    on("stayAvailable", "want");
    on("stayMinimum", "want");
    for (const key of [
      "maxRentPerSqm",
      "furnished",
      "smoking",
      "pets",
      "flatshareTypes",
      "area",
      "distance",
      "languages",
      "flatmateAges",
    ] as const) {
      expect(f[key].enabled).toBe(false);
    }
  });

  it("put an Offer with nothing to judge in Match, with no reasons", () => {
    const result = rank({});
    expect(result).toMatchObject({ band: "match", reasons: [], misses: 0 });
  });
});

describe("bands", () => {
  const profile = { gender: "woman" as const, anmeldungNeeded: true, age: 30 };
  const filters = { maxRent: { limit: 700 } };
  const passing = {
    anmeldung: fact("possible"),
    genderSought: fact("any"),
    ageSought: fact({ min: 20, max: 40 }),
    warmRent: fact({ amount: 600, converted: false }),
    costsComplete: fact(true),
  };

  it("Match: passes every Filter on evidence that checked out, one ✓ reason per Filter", () => {
    const result = rank(passing, profile, filters);
    expect(result.band).toBe("match");
    expect(result.reasons.map((r) => [r.filter, r.outcome])).toEqual([
      ["anmeldung", "pass"],
      ["genderSought", "pass"],
      ["ageSought", "pass"],
      ["maxRent", "pass"],
    ]);
    expect(result.misses).toBe(0);
  });

  it("Near match: misses only a Want", () => {
    const result = rank({ ...passing, ageSought: fact({ min: 40 }) }, profile, filters);
    expect(result.band).toBe("near-match");
    expect(result.misses).toBe(1);
  });

  it("Hidden: fails a Dealbreaker on a known, non-Doubtful value", () => {
    expect(rank({ ...passing, anmeldung: fact("not_possible") }, profile, filters).band).toBe(
      "hidden",
    );
  });

  it("Hidden beats Near match when both occur", () => {
    const facts = { ...passing, ageSought: fact({ min: 40 }), anmeldung: fact("not_possible") };
    expect(rank(facts, profile, filters).band).toBe("hidden");
  });

  it("counts every Filter that is not a clean ✓ as a miss", () => {
    const facts = {
      ...passing,
      ageSought: fact({ min: 40 }),
      anmeldung: fact("conditional"),
      warmRent: doubtful({ amount: 600, converted: false }),
    };
    expect(rank(facts, profile, filters).misses).toBe(3);
  });

  describe("weak evidence never hides an Offer", () => {
    it.each([
      ["an unknown deciding fact", { anmeldung: fact("unknown") }],
      ["a Doubtful deciding fact that fails", { anmeldung: doubtful("not_possible") }],
      ["a missing model fact", { anmeldung: undefined }],
    ])("%s", (_name, override) => {
      const facts = { ...passing, ...override };
      expect(rank(facts, profile, filters).band).toBe("near-match");
    });
  });

  it("Warned: a Likely scam, whatever its Filter results", () => {
    const failing = { ...passing, anmeldung: fact("not_possible") };
    expect(rank(passing, profile, filters, { scam: likelyScam }).band).toBe("warned");
    expect(rank(failing, profile, filters, { scam: likelyScam }).band).toBe("warned");
  });

  describe("hide likely scams", () => {
    const hide = { hideLikelyScams: { enabled: true } };

    it("ships off", () => {
      expect(defaultFilters().hideLikelyScams).toEqual({ enabled: false, strength: "dealbreaker" });
    });

    it("moves a Likely scam from Warned to Hidden when on, with a reason", () => {
      const result = rank(passing, profile, { ...filters, ...hide }, { scam: likelyScam });
      expect(result.band).toBe("hidden");
      expect(reasonFor(result, "hideLikelyScams")).toMatchObject({
        outcome: "fail",
        effect: "hidden",
      });
    });

    it("leaves an Offer that is not a Likely scam alone", () => {
      const result = rank(passing, profile, { ...filters, ...hide });
      expect(result.band).toBe("match");
      expect(reasonFor(result, "hideLikelyScams")).toBeUndefined();
    });
  });

  describe("always Hidden", () => {
    it.each(["stale", "untracked", "dismissed"] as const)("%s", (flag) => {
      const result = rank(passing, profile, filters, { [flag]: true });
      expect(result.band).toBe("hidden");
      expect(result.hiddenBecause).toBe(flag);
      expect(result.reasons).toHaveLength(4);
    });

    it("names the first cause and keeps the others, in precedence order", () => {
      const flags = { stale: true, untracked: true, dismissed: true };
      expect(rank(passing, profile, filters, flags).hiddenBecause).toBe("stale");
      expect(hiddenCausesOf(flags)).toEqual(["stale", "untracked", "dismissed"]);
      expect(hiddenCausesOf({ dismissed: true, stale: true })).toEqual(["stale", "dismissed"]);
      expect(hiddenCausesOf({})).toEqual([]);
    });

    it("even a Likely scam", () => {
      expect(rank(passing, profile, filters, { stale: true, scam: likelyScam }).band).toBe(
        "hidden",
      );
    });

    it("whatever the Filters are", () => {
      const ranked = rankOffer(offer(passing, { dismissed: true }), seeking({}, {}));
      expect(ranked.band).toBe("hidden");
    });
  });

  describe("an Offer no model has read yet", () => {
    it("ranks on its rule facts, and Filters on still-missing model facts count as unknown", () => {
      const ruleOnly = {
        genderSought: fact("any"),
        warmRent: fact({ amount: 600, converted: false }),
        costsComplete: fact(true),
      };
      const result = rank(ruleOnly, profile, filters);
      expect(result.band).toBe("near-match");
      expect(reasonFor(result, "anmeldung")?.cause).toBe("unknown");
      expect(reasonFor(result, "maxRent")?.outcome).toBe("pass");
    });

    it("can still be Hidden by a rule fact", () => {
      const ruleOnly = { warmRent: fact({ amount: 900, converted: false }) };
      expect(rank(ruleOnly, {}, filters).band).toBe("hidden");
    });
  });

  describe("facts left out for a category neither match nor penalize", () => {
    it("a 1-room flat has no gender sought, age sought or Requirements to judge", () => {
      const result = rank(
        {},
        { gender: "woman", age: 30, diet: "omnivore" },
        {},
        { category: "one-room-flat" },
      );
      expect(result.band).toBe("match");
      expect(result.reasons).toEqual([]);
    });

    it("room size applies to every category", () => {
      const filters = { minSize: { limit: 20, margin: null } };
      const small = { roomSize: fact(12) };
      for (const category of ["flatshare-room", "one-room-flat", "flat", "house"] as const) {
        expect(rank(small, {}, filters, { category }).band).toBe("near-match");
      }
    });
  });
});
