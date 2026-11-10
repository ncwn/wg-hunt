import { describe, expect, it } from "vitest";
import { ERROR_KINDS, isPageFailure, PAGE_FAILURE_KINDS } from "./error-kinds.js";
import { PROVIDER_ERROR_KINDS } from "./provider.js";

describe("page failures", () => {
  it("are the kinds no provider reports, and nothing else", () => {
    expect([...PAGE_FAILURE_KINDS].sort()).toEqual(
      Object.keys(ERROR_KINDS)
        .filter((kind) => !(PROVIDER_ERROR_KINDS as readonly string[]).includes(kind))
        .sort(),
    );
    for (const kind of PAGE_FAILURE_KINDS) expect(isPageFailure(kind)).toBe(true);
    for (const kind of PROVIDER_ERROR_KINDS) expect(isPageFailure(kind)).toBe(false);
    expect(isPageFailure("something_old")).toBe(false);
  });

  it("cost nothing and are no attempt, so a page stored again leaves nothing to wait out", () => {
    for (const kind of PAGE_FAILURE_KINDS) {
      expect(ERROR_KINDS[kind]).toMatchObject({
        billed: "no",
        perOffer: "free",
        countsAsAttempt: false,
        stopsQueue: false,
      });
    }
  });
});
