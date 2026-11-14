import { describe, expect, it } from "vitest";
import { usageCostUsd } from "./cost.js";

const HAIKU = {
  inputUsdPerMTok: 0.1,
  outputUsdPerMTok: 0.5,
  longPrompt: { aboveTokens: 100_000, inputUsdPerMTok: 0.5, outputUsdPerMTok: 2.5 },
};
const PLAIN = { inputUsdPerMTok: 2, outputUsdPerMTok: 10 };
const none = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe("what a model call costs from the tokens it used", () => {
  it("prices input and output at the table's rates per million tokens", () => {
    const usage = { ...none, inputTokens: 1_000_000, outputTokens: 500_000 };
    expect(usageCostUsd(usage, PLAIN)).toBeCloseTo(2 + 5, 10);
  });

  it("prices cache writes at 1.25 times and cache reads at 0.1 times the input rate", () => {
    const writes = { ...none, cacheWriteTokens: 1_000_000 };
    const reads = { ...none, cacheReadTokens: 1_000_000 };
    expect(usageCostUsd(writes, PLAIN)).toBeCloseTo(2.5, 10);
    expect(usageCostUsd(reads, PLAIN)).toBeCloseTo(0.2, 10);
  });

  it("bills thinking tokens as output: they are already inside the output count", () => {
    const usage = { ...none, outputTokens: 1_400, thinkingTokens: 1_000 };
    expect(usageCostUsd(usage, PLAIN)).toBeCloseTo((1_400 * 10) / 1e6, 12);
  });

  it("takes half off everything for a batch, cache tokens included", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    };
    const standard = usageCostUsd(usage, PLAIN);
    expect(standard).toBeCloseTo(2 + 10 + 0.2 + 2.5, 10);
    expect(usageCostUsd(usage, PLAIN, { batch: true })).toBeCloseTo(standard / 2, 10);
  });

  it("uses the long-prompt rate for the whole call, output included, above the threshold", () => {
    const atLimit = { ...none, inputTokens: 100_000, outputTokens: 1_000_000 };
    expect(usageCostUsd(atLimit, HAIKU)).toBeCloseTo(0.01 + 0.5, 10);
    const over = { ...none, inputTokens: 100_001, outputTokens: 1_000_000 };
    expect(usageCostUsd(over, HAIKU)).toBeCloseTo(0.0500005 + 2.5, 10);
  });

  it("counts cache reads and writes toward the long-prompt threshold, and prices them at the long rate", () => {
    const usage = {
      ...none,
      inputTokens: 10_000,
      cacheReadTokens: 60_000,
      cacheWriteTokens: 40_000,
    };
    const expected = (10_000 * 0.5 + 60_000 * 0.05 + 40_000 * 0.625) / 1e6;
    expect(usageCostUsd(usage, HAIKU)).toBeCloseTo(expected, 12);
  });

  it("stacks the batch discount on the long-prompt rate", () => {
    const usage = { ...none, inputTokens: 200_000, outputTokens: 100_000 };
    const standard = (200_000 * 0.5 + 100_000 * 2.5) / 1e6;
    expect(usageCostUsd(usage, HAIKU, { batch: true })).toBeCloseTo(standard / 2, 12);
  });

  it("costs nothing for no tokens", () => {
    expect(usageCostUsd(none, HAIKU)).toBe(0);
  });
});
