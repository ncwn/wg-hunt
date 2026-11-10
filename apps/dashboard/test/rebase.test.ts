import { describe, expect, it } from "vitest";
import { rebase } from "../src/rebase.js";

describe("rebase: a draft laid over a newer saved copy", () => {
  type Doc = {
    diet: string | null;
    maxRent: { enabled: boolean; limit: number | null };
    places: { name: string }[];
  };
  const base: Doc = {
    diet: null,
    maxRent: { enabled: false, limit: null },
    places: [{ name: "work" }],
  };

  it("keeps what the draft changed and takes the rest from the newer copy", () => {
    const draft = { ...base, maxRent: { enabled: true, limit: 480 } };
    const fresh = { ...base, diet: "vegan", maxRent: { enabled: false, limit: null } };
    expect(rebase(base, draft, fresh)).toEqual({
      diet: "vegan",
      maxRent: { enabled: true, limit: 480 },
      places: [{ name: "work" }],
    });
  });

  it("merges inside an object, value by value", () => {
    const draft = { ...base, maxRent: { enabled: false, limit: 480 } };
    const fresh = { ...base, maxRent: { enabled: true, limit: null } };
    expect(rebase(base, draft, fresh).maxRent).toEqual({ enabled: true, limit: 480 });
  });

  it("takes a list whole: the draft's if it changed it, else the newer copy's", () => {
    const fresh = { ...base, places: [{ name: "uni" }] };
    expect(rebase(base, base, fresh).places).toEqual([{ name: "uni" }]);
    const draft = { ...base, places: [{ name: "work" }, { name: "gym" }] };
    expect(rebase(base, draft, fresh).places).toEqual([{ name: "work" }, { name: "gym" }]);
  });

  it("lets the draft win where both changed the same value", () => {
    const draft = { ...base, diet: "vegetarian" };
    const fresh = { ...base, diet: "vegan" };
    expect(rebase(base, draft, fresh).diet).toBe("vegetarian");
  });

  it("is the newer copy when the draft changed nothing", () => {
    const fresh = { ...base, diet: "vegan" };
    expect(rebase(base, { ...base }, fresh)).toBe(fresh);
  });
});
