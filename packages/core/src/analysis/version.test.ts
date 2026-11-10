import { describe, expect, it } from "vitest";
import { ANALYSIS_PREFIX } from "./prompt.js";
import { analysisVersion, analysisVersionMaterial } from "./version.js";

const haiku = { model: "claude-haiku-5-5", effort: "medium" as const };

describe("what the analysis version is made of", () => {
  it("is the same text every time for the same prompt, schema, model and effort", () => {
    expect(analysisVersionMaterial(haiku)).toBe(analysisVersionMaterial({ ...haiku }));
  });

  it("changes with the model id", () => {
    expect(analysisVersionMaterial({ ...haiku, model: "claude-sonnet-5-5" })).not.toBe(
      analysisVersionMaterial(haiku),
    );
  });

  it("changes with the effort, and with having none", () => {
    const material = new Set([
      analysisVersionMaterial(haiku),
      analysisVersionMaterial({ ...haiku, effort: "high" }),
      analysisVersionMaterial({ ...haiku, effort: null }),
    ]);
    expect(material.size).toBe(3);
  });

  it("contains the prompt and the output schema, so editing either changes it", () => {
    const material = analysisVersionMaterial(haiku);
    expect(material).toContain(JSON.stringify(ANALYSIS_PREFIX));
    expect(material).toContain("genderSoughtFromText");
  });
});

describe("the analysis version", () => {
  it("is a short hash of the material: the same for the same settings", () => {
    expect(analysisVersion(haiku)).toMatch(/^[0-9a-f]{16}$/);
    expect(analysisVersion(haiku)).toBe(analysisVersion({ ...haiku }));
  });

  it("changes with the model and with the effort", () => {
    const versions = new Set([
      analysisVersion(haiku),
      analysisVersion({ ...haiku, model: "claude-sonnet-5-5" }),
      analysisVersion({ ...haiku, effort: "high" }),
      analysisVersion({ ...haiku, effort: null }),
    ]);
    expect(versions.size).toBe(4);
  });
});
