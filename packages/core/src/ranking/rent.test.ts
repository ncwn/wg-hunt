import { describe, expect, it } from "vitest";
import { doubtful, fact, rank, reasonFor } from "./test-helpers.js";

const rent = (amount: number, converted = false) => fact({ amount, converted });
const complete = { costsComplete: fact(true) };
const maxRent = (limit: number | null, extra = {}) => ({
  maxRent: { limit, margin: { value: 50, unit: "absolute" as const }, ...extra },
});

describe("maximum warm rent", () => {
  it("is not evaluated while no limit is set", () => {
    const result = rank({ ...complete, warmRent: rent(5000) });
    expect(result.band).toBe("match");
    expect(reasonFor(result, "maxRent")).toBeUndefined();
  });

  it.each([
    [600, "match", "pass", "none"],
    [650, "match", "pass", "none"],
    [680, "near-match", "warn", "near-match"],
    [700, "near-match", "warn", "near-match"],
    [720, "hidden", "fail", "hidden"],
  ] as const)("EUR 650 with a EUR 50 margin: %i is %s", (amount, band, outcome, effect) => {
    const result = rank({ ...complete, warmRent: rent(amount) }, {}, maxRent(650));
    expect(result.band).toBe(band);
    expect(reasonFor(result, "maxRent")).toMatchObject({ outcome, effect });
  });

  it("reads a percent margin against the limit", () => {
    const filters = { maxRent: { limit: 700, margin: { value: 10, unit: "percent" as const } } };
    expect(rank({ ...complete, warmRent: rent(770) }, {}, filters).band).toBe("near-match");
    expect(rank({ ...complete, warmRent: rent(771) }, {}, filters).band).toBe("hidden");
  });

  it("hides nothing inside no margin at all", () => {
    expect(
      rank({ ...complete, warmRent: rent(651) }, {}, maxRent(650, { margin: null })).band,
    ).toBe("hidden");
  });

  it("only moves an Offer to Near match when the filter is a Want", () => {
    const result = rank(
      { ...complete, warmRent: rent(900) },
      {},
      maxRent(650, { strength: "want" }),
    );
    expect(result.band).toBe("near-match");
    expect(reasonFor(result, "maxRent")).toMatchObject({ outcome: "fail", effect: "near-match" });
  });

  it("does not evaluate a Filter switched off", () => {
    expect(
      rank({ ...complete, warmRent: rent(900) }, {}, maxRent(650, { enabled: false })).band,
    ).toBe("match");
  });

  it("makes an unknown rent a Near match, never Hidden", () => {
    const result = rank({ ...complete, warmRent: fact("unknown") }, {}, maxRent(650));
    expect(result.band).toBe("near-match");
    expect(reasonFor(result, "maxRent")).toMatchObject({ outcome: "warn", cause: "unknown" });
  });

  it("makes a Doubtful rent that is over budget a Near match, and one that passes too", () => {
    const over = rank(
      { ...complete, warmRent: doubtful({ amount: 900, converted: false }) },
      {},
      maxRent(650),
    );
    expect(over.band).toBe("near-match");
    expect(reasonFor(over, "maxRent")?.cause).toBe("doubtful");
    const under = rank(
      { ...complete, warmRent: doubtful({ amount: 500, converted: false }) },
      {},
      maxRent(650),
    );
    expect(under.band).toBe("near-match");
  });

  it("makes a rent without Nebenkosten that is under budget a Near match", () => {
    const result = rank(
      { ...complete, warmRent: rent(600), costsComplete: fact(false) },
      {},
      maxRent(650),
    );
    expect(result.band).toBe("near-match");
    expect(reasonFor(result, "maxRent")?.cause).toBe("incomplete-costs");
  });

  it("makes a rent whose Nebenkosten row is missing or unknown a Near match, never a Match", () => {
    for (const costsComplete of [fact("unknown"), undefined]) {
      const result = rank({ warmRent: rent(600), costsComplete }, {}, maxRent(650));
      expect(result.band).toBe("near-match");
      expect(reasonFor(result, "maxRent")?.cause).toBe("incomplete-costs");
    }
  });

  it("still hides a rent without Nebenkosten that is already over budget", () => {
    const result = rank(
      { ...complete, warmRent: rent(800), costsComplete: fact(false) },
      {},
      maxRent(650),
    );
    expect(result.band).toBe("hidden");
  });

  it("ranks a converted rent normally and adds a chip", () => {
    const result = rank({ ...complete, warmRent: rent(600, true) }, {}, maxRent(650));
    expect(result.band).toBe("match");
    expect(result.chips).toContainEqual(expect.objectContaining({ kind: "converted-rent" }));
  });

  it("adds a chip for missing Nebenkosten even with no rent limit", () => {
    const result = rank({ ...complete, warmRent: rent(600), costsComplete: fact(false) });
    expect(result.chips).toContainEqual(expect.objectContaining({ kind: "costs-incomplete" }));
  });

  it("quotes the rent fact in the reason", () => {
    const result = rank(
      { warmRent: fact({ amount: 720, converted: false }, { quote: "Miete: 720 EUR" }) },
      {},
      maxRent(650),
    );
    expect(reasonFor(result, "maxRent")?.quote).toBe("Miete: 720 EUR");
  });
});
