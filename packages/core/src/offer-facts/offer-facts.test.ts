import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CATEGORIES } from "../searches.js";
import { isApplicable, modelFactsOutputSchema, offerFactsSchema } from "./index.js";
import { structuredOutputUsage } from "./model-output.js";
import { applicableFactKeys } from "./schema.js";

const field = (value: unknown, quote: string) => ({ value, origin: "field", quote });

describe("category applicability", () => {
  it("applies flatmate and WG-Details facts to flatshares only", () => {
    for (const key of [
      "flatmates",
      "flatshareSize",
      "flatmateAges",
      "ageSought",
      "flatshareTypes",
      "languages",
      "smoking",
      "petsPresent",
    ]) {
      expect(isApplicable(key, "flatshare-room")).toBe(true);
      for (const other of ["one-room-flat", "flat", "house"] as const) {
        expect(isApplicable(key, other), `${key} on ${other}`).toBe(false);
      }
    }
  });

  it("applies room size to every category, so a room-size Filter sees them all", () => {
    for (const category of CATEGORIES) {
      expect(isApplicable("roomSize", category)).toBe(true);
      expect(isApplicable("flatSize", category)).toBe(true);
      expect(isApplicable("kitchen", category)).toBe(true);
    }
  });

  it("applies rooms to flats and houses but not to 1-room flats", () => {
    expect(applicableFactKeys("flat")).toContain("rooms");
    expect(applicableFactKeys("house")).toContain("rooms");
    expect(applicableFactKeys("one-room-flat")).not.toContain("rooms");
    expect(applicableFactKeys("flatshare-room")).not.toContain("rooms");
  });

  it("applies costs, availability, location and the advertiser box to every category", () => {
    for (const category of CATEGORIES) {
      for (const key of ["warmRent", "availableFrom", "postalCode", "verified", "anmeldung"]) {
        expect(isApplicable(key, category)).toBe(true);
      }
    }
  });

  describe("gender sought and Requirements", () => {
    const keys = ["genderSought", "requirements"];

    it("apply to every flatshare room", () => {
      for (const key of keys) expect(isApplicable(key, "flatshare-room")).toBe(true);
    });

    it("apply to a flat or house only when it is offered as a WG", () => {
      for (const key of keys) {
        for (const category of ["flat", "house"] as const) {
          expect(isApplicable(key, category), `${key} on ${category}`).toBe(false);
          expect(isApplicable(key, category, { offeredAsWg: false })).toBe(false);
          expect(isApplicable(key, category, { offeredAsWg: true })).toBe(true);
        }
      }
      expect(applicableFactKeys("house", { offeredAsWg: true })).toContain("requirements");
      expect(applicableFactKeys("house")).not.toContain("requirements");
    });

    it("never apply to a 1-room flat", () => {
      for (const key of keys) {
        expect(isApplicable(key, "one-room-flat", { offeredAsWg: true })).toBe(false);
      }
    });

    it("have one gender sought fact: the text reading is not a second fact", () => {
      expect(applicableFactKeys("flatshare-room")).not.toContain("genderSoughtFromText");
    });
  });
});

describe("offerFactsSchema", () => {
  const flatFacts = {
    category: "flat",
    rooms: field(2.5, "Zimmer: 2,5"),
    warmRent: field({ amount: 900, converted: false }, "Gesamtmiete: 900€"),
  };

  it("accepts facts that apply to the category and leaves model facts absent until analysed", () => {
    expect(offerFactsSchema.safeParse(flatFacts).success).toBe(true);
  });

  it("rejects a fact that does not apply to the category, rather than allowing unknown", () => {
    const result = offerFactsSchema.safeParse({
      ...flatFacts,
      flatshareTypes: field("unknown", ""),
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("flatshareTypes");
  });

  it("accepts gender sought and Requirements on a flat only when it is offered as a WG", () => {
    const text = {
      genderSought: { value: ["woman"], origin: "text", quote: "nur Frauen" },
      requirements: [
        {
          value: { kind: "diet", strictness: "required", value: "vegan" },
          origin: "text",
          quote: "vegan kochen",
        },
      ],
    };
    expect(offerFactsSchema.safeParse({ ...flatFacts, ...text }).success).toBe(false);
    const offered = { ...flatFacts, offeredAsWg: field(true, "WG geeignet"), ...text };
    expect(offerFactsSchema.safeParse(offered).success).toBe(true);
    const notOffered = { ...offered, offeredAsWg: field("unknown", "") };
    expect(offerFactsSchema.safeParse(notOffered).success).toBe(false);
  });

  it("allows unknown, which only means the Offer does not say", () => {
    const result = offerFactsSchema.safeParse({
      ...flatFacts,
      rooms: field("unknown", ""),
    });
    expect(result.success).toBe(true);
  });

  it("requires a quote for every fact that is not unknown, absences included", () => {
    for (const [key, value] of [
      ["rooms", 2.5],
      ["petsAllowed", false],
      ["availableUntil", "none"],
      ["imageUrls", []],
      ["photoCount", 0],
    ] as const) {
      const result = offerFactsSchema.safeParse({ ...flatFacts, [key]: field(value, "") });
      expect(result.success, key).toBe(false);
      const quoted = offerFactsSchema.safeParse({
        ...flatFacts,
        [key]: field(value, "the section that shows it"),
      });
      expect(quoted.success, key).toBe(true);
    }
  });

  it("lets a seeker's manual correction stand without a quote", () => {
    const manual = { value: 3, origin: "manual", quote: "" };
    expect(offerFactsSchema.safeParse({ ...flatFacts, rooms: manual }).success).toBe(true);
  });

  it("carries alternatives, with their origin, and a Doubtful confidence on a model fact", () => {
    const anmeldung = {
      value: "conditional",
      origin: "text",
      quote: "Anmeldung nur mit Vertrag",
      alternatives: [{ value: "possible", origin: "text", quote: "Anmeldung möglich" }],
      confidence: { status: "doubtful", reasons: ["tiers_disagree"] },
    };
    expect(offerFactsSchema.safeParse({ ...flatFacts, anmeldung }).success).toBe(true);
    const noOrigin = {
      ...anmeldung,
      alternatives: [{ value: "possible", quote: "Anmeldung möglich" }],
    };
    expect(offerFactsSchema.safeParse({ ...flatFacts, anmeldung: noOrigin }).success).toBe(false);
  });

  it("limits Doubtful reasons to the known kinds", () => {
    const withReason = (reason: string) => ({
      ...flatFacts,
      anmeldung: {
        value: "possible",
        origin: "text",
        quote: "Anmeldung möglich",
        confidence: { status: "doubtful", reasons: [reason] },
      },
    });
    for (const reason of [
      "quote_not_found",
      "contradicts_field",
      "keyword_tripwire",
      "model_ambiguous",
      "tiers_disagree",
    ]) {
      expect(offerFactsSchema.safeParse(withReason(reason)).success, reason).toBe(true);
    }
    expect(offerFactsSchema.safeParse(withReason("felt wrong")).success).toBe(false);
  });

  it("names the structured fact a text conflict is about, from the rule fact keys", () => {
    const conflict = (factKey: string) => ({
      ...flatFacts,
      conflicts: [
        {
          value: { factKey, textValue: "850€" },
          origin: "text",
          quote: "Miete 850 Euro",
        },
      ],
    });
    expect(offerFactsSchema.safeParse(conflict("warmRent")).success).toBe(true);
    expect(offerFactsSchema.safeParse(conflict("not_a_fact")).success).toBe(false);
  });

  it("rejects an unknown origin", () => {
    const bad = { ...flatFacts, rooms: { value: 2, origin: "guess", quote: "Zimmer: 2" } };
    expect(offerFactsSchema.safeParse(bad).success).toBe(false);
  });
});

describe("model output schema", () => {
  it("stays within the structured-output limits of 24 optional and 16 union-typed fields", () => {
    const usage = structuredOutputUsage(modelFactsOutputSchema);
    expect(usage.optional).toBeLessThanOrEqual(24);
    expect(usage.unions).toBeLessThanOrEqual(16);
  });

  it("uses required fields and unknown enum values instead of nullables", () => {
    const json = JSON.stringify(z.toJSONSchema(modelFactsOutputSchema));
    expect(json).not.toContain('"null"');
    expect(json).toContain('"unknown"');
  });

  it("counts optional and union-typed fields so the limit test means something", () => {
    const schema = z.object({
      a: z.string().optional(),
      b: z.number().nullable(),
      c: z.object({ d: z.union([z.string(), z.number()]).optional() }),
    });
    expect(structuredOutputUsage(schema)).toEqual({ optional: 2, unions: 2 });
  });
});
