import { describe, expect, it } from "vitest";
import { usageCostUsd } from "./cost.js";
import { DEFAULT_PRICES } from "./prices.js";

describe("the default price table", () => {
  it("lists each model once", () => {
    const models = DEFAULT_PRICES.map((price) => price.model);
    expect(new Set(models).size).toBe(models.length);
  });

  it("prices Haiku 5.5 at $0.10 / $0.50, and five times that above 100K input tokens", () => {
    const haiku = DEFAULT_PRICES.find((price) => price.model === "claude-haiku-5-5");
    if (haiku === undefined) throw new Error("no Haiku 5.5");
    const short = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    expect(usageCostUsd({ ...short, inputTokens: 100_000 }, haiku)).toBeCloseTo(0.01, 10);
    expect(usageCostUsd({ ...short, inputTokens: 100_001 }, haiku)).toBeCloseTo(0.0500005, 10);
  });

  it("says which efforts a model takes: none for Haiku 4.5", () => {
    expect(DEFAULT_PRICES.find((price) => price.model === "claude-haiku-4-5")?.efforts).toEqual([]);
  });
});
