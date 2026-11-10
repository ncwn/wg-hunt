import { DEFAULT_PRICES } from "@wg-hunt/core";
import { describe, expect, it } from "vitest";
import { costOf } from "./cost.js";

const usage = (
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
});

describe("what a run cost", () => {
  it("prices input, output, cache reads (a tenth) and cache writes (a quarter more)", () => {
    const cost = costOf(
      [{ model: "claude-haiku-5-5", usage: usage(10_000, 10_000, 10_000, 10_000) }],
      DEFAULT_PRICES,
    );
    expect(cost.usd).toBeCloseTo(0.00735, 9);
    expect(cost.unpriced).toEqual([]);
  });

  it("prices a long prompt as production does: Haiku 5.5 above 100K input tokens costs five times as much", () => {
    const cost = costOf([{ model: "claude-haiku-5-5", usage: usage(200_000, 0) }], DEFAULT_PRICES);
    expect(cost.usd).toBeCloseTo(0.1, 9);
  });

  it("adds up calls to different models", () => {
    const cost = costOf(
      [
        { model: "claude-haiku-5-5", usage: usage(50_000, 0) },
        { model: "claude-sonnet-5-5", usage: usage(0, 1e6) },
      ],
      DEFAULT_PRICES,
    );
    expect(cost.usd).toBeCloseTo(10.005, 9);
  });

  it("says so, and gives no total, when a model is not in the price table", () => {
    const cost = costOf([{ model: "some-new-model", usage: usage(10, 10) }], DEFAULT_PRICES);
    expect(cost.usd).toBeNull();
    expect(cost.unpriced).toEqual(["some-new-model"]);
  });

  it("takes a price given for a model the table lacks", () => {
    const cost = costOf(
      [{ model: "some-new-model", usage: usage(1e6, 1e6) }],
      [...DEFAULT_PRICES, { model: "some-new-model", inputUsdPerMTok: 1, outputUsdPerMTok: 2 }],
    );
    expect(cost.usd).toBeCloseTo(3, 6);
  });
});
