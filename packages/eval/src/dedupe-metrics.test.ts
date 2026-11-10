import { describe, expect, it } from "vitest";
import { dedupeMetrics } from "./dedupe-metrics.js";

const pair = (id: string, expected: string, actual: string) => ({
  id,
  expected: expected as never,
  actual: actual as never,
});

describe("precision and recall of the dedupe rules", () => {
  it("counts per relation what the rules got right, wrongly added and missed", () => {
    const metrics = dedupeMetrics([
      pair("a", "duplicate", "duplicate"),
      pair("b", "duplicate", "apart"),
      pair("c", "apart", "duplicate"),
      pair("d", "sibling", "sibling"),
      pair("e", "cloned", "sibling"),
    ]);
    expect(metrics.relations.duplicate).toEqual({
      truePositives: 1,
      falsePositives: 1,
      falseNegatives: 1,
      precision: 0.5,
      recall: 0.5,
    });
    expect(metrics.relations.sibling).toMatchObject({
      truePositives: 1,
      falsePositives: 1,
      falseNegatives: 0,
      precision: 0.5,
      recall: 1,
    });
    expect(metrics.relations.cloned).toMatchObject({
      truePositives: 0,
      falseNegatives: 1,
      recall: 0,
    });
    expect(metrics.pairs).toBe(5);
    expect(metrics.accuracy).toBe(0.4);
  });

  it("reports a ratio as null when nothing could have been right or wrong", () => {
    const metrics = dedupeMetrics([pair("a", "duplicate", "duplicate")]);
    expect(metrics.relations.sibling.precision).toBeNull();
    expect(metrics.relations.sibling.recall).toBeNull();
    expect(metrics.relations.duplicate.precision).toBe(1);
  });

  it("lists the pairs it got wrong", () => {
    const metrics = dedupeMetrics([pair("a", "duplicate", "apart"), pair("b", "apart", "apart")]);
    expect(metrics.misses).toEqual([{ id: "a", expected: "duplicate", actual: "apart" }]);
  });
});
