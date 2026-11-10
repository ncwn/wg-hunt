import { describe, expect, it } from "vitest";
import { doubtful, fact, rank, reasonFor } from "./test-helpers.js";

const on = { enabled: true };

describe("minimum size", () => {
  const filters = { minSize: { limit: 12, margin: { value: 2, unit: "absolute" as const } } };

  it.each([
    [14, "match"],
    [12, "match"],
    [11, "near-match"],
    [10, "near-match"],
    [9, "near-match"],
  ])("a %i m² room is a %s (a Want never hides)", (size, band) => {
    expect(rank({ roomSize: fact(size) }, {}, filters).band).toBe(band);
  });

  it("hides below the margin when raised to a Dealbreaker", () => {
    const strict = { minSize: { ...filters.minSize, strength: "dealbreaker" as const } };
    expect(rank({ roomSize: fact(10) }, {}, strict).band).toBe("near-match");
    expect(rank({ roomSize: fact(9) }, {}, strict).band).toBe("hidden");
  });

  it("is a Near match when the size is unknown", () => {
    expect(rank({ roomSize: fact("unknown") }, {}, filters).band).toBe("near-match");
  });
});

describe("maximum rent per m²", () => {
  const filters = { maxRentPerSqm: { ...on, limit: 30, margin: null } };

  it("is off by default", () => {
    expect(rank({ rentPerSqm: fact(99) }).band).toBe("match");
  });

  it("hides above the limit and passes at it", () => {
    const complete = { costsComplete: fact(true) };
    expect(rank({ rentPerSqm: fact(30), ...complete }, {}, filters).band).toBe("match");
    expect(rank({ rentPerSqm: fact(30.5), ...complete }, {}, filters).band).toBe("hidden");
  });

  it("is a Near match when Nebenkosten is missing and the rent per m² passes", () => {
    const result = rank({ rentPerSqm: fact(20), costsComplete: fact(false) }, {}, filters);
    expect(result.band).toBe("near-match");
  });
});

describe("furnished", () => {
  const filters = { furnished: { ...on, accept: ["furnished" as const] } };

  it("matches an accepted value and misses another", () => {
    expect(rank({ furnished: fact("furnished") }, {}, filters).band).toBe("match");
    expect(rank({ furnished: fact("unfurnished") }, {}, filters).band).toBe("near-match");
  });

  it("is a Near match when unknown", () => {
    expect(rank({ furnished: fact("unknown") }, {}, filters).band).toBe("near-match");
  });
});

describe("smoking", () => {
  const filters = { smoking: { ...on, strength: "dealbreaker" as const } };

  it("is not evaluated for a seeker who does not smoke", () => {
    expect(rank({ smoking: fact("not_wanted") }, { smoker: false }, filters).reasons).toEqual([]);
  });

  it("hides a flat where smoking is not wanted, for a smoker", () => {
    expect(rank({ smoking: fact("not_wanted") }, { smoker: true }, filters).band).toBe("hidden");
    expect(
      rank({ smoking: fact("balcony"), requirements: [] }, { smoker: true }, filters).band,
    ).toBe("match");
  });
});

describe("pets", () => {
  const filters = { pets: { ...on, strength: "dealbreaker" as const } };

  it("is not evaluated for a seeker without pets", () => {
    expect(rank({ petsAllowed: fact(false) }, { hasPets: false }, filters).reasons).toEqual([]);
  });

  it("hides an Offer that does not allow pets, for a seeker with pets", () => {
    expect(rank({ petsAllowed: fact(false) }, { hasPets: true }, filters).band).toBe("hidden");
    expect(
      rank({ petsAllowed: fact(true), requirements: [] }, { hasPets: true }, filters).band,
    ).toBe("match");
    expect(rank({ petsAllowed: fact("unknown") }, { hasPets: true }, filters).band).toBe(
      "near-match",
    );
  });
});

describe("flatshare types", () => {
  const filters = { flatshareTypes: { ...on, anyOf: ["students" as const, "business" as const] } };

  it("is not evaluated with none chosen", () => {
    const none = { flatshareTypes: { ...on, anyOf: [] } };
    expect(rank({ flatshareTypes: fact(["seniors"]) }, {}, none).reasons).toEqual([]);
  });

  it("matches when the flatshare has one of the types", () => {
    expect(rank({ flatshareTypes: fact(["students", "seniors"]) }, {}, filters).band).toBe("match");
    expect(rank({ flatshareTypes: fact(["seniors"]) }, {}, filters).band).toBe("near-match");
  });

  it("does not apply to a flat", () => {
    expect(rank({}, {}, filters, { category: "flat" }).reasons).toEqual([]);
  });
});

describe("district or PLZ", () => {
  const filters = { area: { ...on, anyOf: ["Friedrichshain", "104"] } };

  it("matches a district, ignoring case, or a postal-code prefix", () => {
    expect(rank({ district: fact("Berlin Friedrichshain") }, {}, filters).band).toBe("match");
    expect(rank({ district: fact("Mitte"), postalCode: fact("10435") }, {}, filters).band).toBe(
      "match",
    );
  });

  it("misses a different area", () => {
    const facts = { district: fact("Mitte"), postalCode: fact("10115") };
    expect(rank(facts, {}, filters).band).toBe("near-match");
    expect(reasonFor(rank(facts, {}, filters), "area")?.outcome).toBe("fail");
  });

  it("is a Near match when neither is known", () => {
    expect(rank({ district: fact("unknown"), postalCode: fact("unknown") }, {}, filters).band).toBe(
      "near-match",
    );
  });
});

describe("languages", () => {
  const filters = { languages: { ...on } };

  it("is not evaluated until the profile has languages", () => {
    expect(rank({ languages: fact(["fr"]) }, {}, filters).reasons).toEqual([]);
  });

  it("matches when the flat shares a language with the seeker", () => {
    expect(
      rank({ languages: fact(["de", "en"]), requirements: [] }, { languages: ["en"] }, filters)
        .band,
    ).toBe("match");
    expect(rank({ languages: fact(["fr"]) }, { languages: ["en"] }, filters).band).toBe(
      "near-match",
    );
  });

  it("is a Near match when Doubtful", () => {
    expect(rank({ languages: doubtful(["en"]) }, { languages: ["en"] }, filters).band).toBe(
      "near-match",
    );
  });
});

describe("flatmate ages", () => {
  const filters = { flatmateAges: { ...on, min: 22, max: 35 } };

  it("matches when the flatmates' ages sit inside the range", () => {
    expect(rank({ flatmateAges: fact({ min: 24, max: 30 }) }, {}, filters).band).toBe("match");
  });

  it("misses when a flatmate is outside it", () => {
    expect(rank({ flatmateAges: fact({ min: 19, max: 30 }) }, {}, filters).band).toBe("near-match");
    expect(rank({ flatmateAges: fact({ min: 24, max: 41 }) }, {}, filters).band).toBe("near-match");
  });

  it("is a Near match when unknown", () => {
    expect(rank({ flatmateAges: fact("unknown") }, {}, filters).band).toBe("near-match");
  });
});
