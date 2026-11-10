import { describe, expect, it } from "vitest";
import { scrubPaths } from "../src/api/problem.js";

describe("scrubPaths", () => {
  it("rewrites absolute paths under the project and hides others", () => {
    expect(scrubPaths("open /proj/.data/a.sqlite failed", "/proj")).toBe(
      "open .data/a.sqlite failed",
    );
    expect(scrubPaths("open /Users/me/x/a.sqlite failed", "/proj")).toBe(
      "open <outside project>/a.sqlite failed",
    );
  });
});
