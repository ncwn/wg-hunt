import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOfferCases, loadPairCases } from "./cases.js";

function folder() {
  const dir = mkdtempSync(join(tmpdir(), "wg-hunt-cases-"));
  mkdirSync(join(dir, "offers"));
  mkdirSync(join(dir, "pairs"));
  return dir;
}

describe("loading a set of cases from a folder", () => {
  it("pairs each labels file with the page of the same name", () => {
    const dir = folder();
    writeFileSync(join(dir, "offers", "a.html"), "<html></html>");
    writeFileSync(
      join(dir, "offers", "a.offer.json"),
      JSON.stringify({ category: "flatshare-room", expected: { anmeldung: "possible" } }),
    );
    const [only] = loadOfferCases(join(dir, "offers"));
    expect(only).toMatchObject({ id: "a", html: "<html></html>" });
    expect(only?.expected).toEqual({ anmeldung: "possible" });
  });

  it("loads what a run reads; a file's note, language and synthetic mark are for its reader", () => {
    const dir = folder();
    writeFileSync(join(dir, "offers", "a.html"), "<html></html>");
    writeFileSync(
      join(dir, "offers", "a.offer.json"),
      JSON.stringify({
        synthetic: true,
        note: "an invented room",
        language: "en",
        category: "flat",
        expected: {},
      }),
    );
    expect(loadOfferCases(join(dir, "offers"))).toEqual([
      { id: "a", category: "flat", html: "<html></html>", expected: {} },
    ]);
  });

  it("still refuses a language the set is not written in", () => {
    const dir = folder();
    writeFileSync(join(dir, "offers", "a.html"), "x");
    writeFileSync(
      join(dir, "offers", "a.offer.json"),
      JSON.stringify({ language: "fr", category: "flat", expected: {} }),
    );
    expect(() => loadOfferCases(join(dir, "offers"))).toThrow(/a\.offer\.json.*language/s);
  });

  it("returns no cases for a folder that does not exist", () => {
    expect(loadOfferCases(join(folder(), "missing"))).toEqual([]);
  });

  it("refuses a label for a fact that does not exist, naming the case", () => {
    const dir = folder();
    writeFileSync(join(dir, "offers", "a.html"), "x");
    writeFileSync(
      join(dir, "offers", "a.offer.json"),
      JSON.stringify({ category: "flatshare-room", expected: { anmeldng: "possible" } }),
    );
    expect(() => loadOfferCases(join(dir, "offers"))).toThrow(/a\.offer\.json.*anmeldng/s);
  });

  it("refuses a labels file without its page", () => {
    const dir = folder();
    writeFileSync(
      join(dir, "offers", "a.offer.json"),
      JSON.stringify({ category: "flatshare-room", expected: {} }),
    );
    expect(() => loadOfferCases(join(dir, "offers"))).toThrow(/a\.html/);
  });

  it("loads a pair with the pages of both sides", () => {
    const dir = folder();
    writeFileSync(join(dir, "pairs", "p-a.html"), "A");
    writeFileSync(join(dir, "pairs", "p-b.html"), "B");
    writeFileSync(
      join(dir, "pairs", "p.pair.json"),
      JSON.stringify({
        note: "the same room posted twice",
        category: "flatshare-room",
        expected: "duplicate",
        a: { page: "p-a.html", advertiser: { name: "Anna" } },
        b: { page: "p-b.html", advertiser: { name: "Anna" } },
      }),
    );
    const [pair] = loadPairCases(join(dir, "pairs"));
    expect(pair).toMatchObject({ id: "p", expected: "duplicate" });
    expect(Object.keys(pair ?? {}).sort()).toEqual(["a", "b", "category", "expected", "id"]);
    expect(pair?.a.html).toBe("A");
    expect(pair?.b.html).toBe("B");
  });
});
