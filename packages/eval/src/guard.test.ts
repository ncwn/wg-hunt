import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkSyntheticSet, findProjectRoot, findStrayEvalData, SYNTHETIC_DIR } from "./guard.js";
import { localSetDir } from "./overrides.js";
import { renderPage } from "./synthetic-page.js";

const root = findProjectRoot(import.meta.dirname);

describe("keeping real Offers out of the repository", () => {
  it("finds no evaluation data in the repository outside the synthetic folder", () => {
    expect(findStrayEvalData(root)).toEqual([]);
  });

  it("flags labels or pairs anywhere else, committed or merely not ignored", () => {
    const files = [
      `${SYNTHETIC_DIR}/offers/a.offer.json`,
      `${SYNTHETIC_DIR}/pairs/p.pair.json`,
      "apps/server/test/x.offer.json",
      "notes/y.pair.json",
      "docs/readme.md",
    ];
    expect(findStrayEvalData(root, () => files)).toEqual([
      "apps/server/test/x.offer.json",
      "notes/y.pair.json",
    ]);
  });

  it("puts the local set in the data folder, which git ignores", () => {
    expect(localSetDir(join(root, ".data"))).toBe(join(root, ".data", "eval"));
  });
});

describe("what the synthetic set may contain", () => {
  it("passes for the committed set", () => {
    expect(checkSyntheticSet(join(root, SYNTHETIC_DIR))).toEqual([]);
  });

  function folderWith(files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "wg-hunt-synthetic-"));
    mkdirSync(join(dir, "offers"));
    for (const [name, content] of Object.entries(files))
      writeFileSync(join(dir, "offers", name), content);
    return dir;
  }
  const page = renderPage({
    adId: "9400001",
    title: "Zimmer",
    category: "flatshare-room",
    sections: [["Zimmer", "Ein Zimmer."]],
  });

  it("accepts a page and labels that say they are synthetic and hold nothing real-looking", () => {
    const dir = folderWith({
      "a.html": page,
      "a.offer.json": JSON.stringify({ synthetic: true, category: "flatshare-room", expected: {} }),
    });
    expect(checkSyntheticSet(dir)).toEqual([]);
  });

  it("flags a page without the synthetic marker, and labels without synthetic: true", () => {
    const dir = folderWith({
      "a.html": page.replace("SYNTHETIC", "x"),
      "a.offer.json": JSON.stringify({ category: "flatshare-room", expected: {} }),
    });
    expect(checkSyntheticSet(dir).join("\n")).toMatch(/a\.html.*synthetic/i);
    expect(checkSyntheticSet(dir).join("\n")).toMatch(/a\.offer\.json.*synthetic/i);
  });

  it.each([
    ["an email address", "Schreib an anna.muster@vermietung.test bitte."],
    ["a phone number", "Ruf mich an unter 0170 1234567."],
    ["an international phone number", "WhatsApp +49 170 1234567."],
    ["a web address", "Mehr unter https://www.example-vermietung.de/zimmer."],
    ["coordinates", 'var m = {"lat":52.123456,"lng":13.123456};'],
  ])("flags %s", (_what, content) => {
    const dir = folderWith({
      "a.html": page.replace("Ein Zimmer.", content),
      "a.offer.json": JSON.stringify({ synthetic: true, category: "flatshare-room", expected: {} }),
    });
    expect(checkSyntheticSet(dir).join("\n")).toMatch(/a\.html/);
  });

  it("lets an invented contact on example.invalid through", () => {
    const dir = folderWith({
      "a.html": page.replace("Ein Zimmer.", "Mail an max.beispiel@example.invalid."),
      "a.offer.json": JSON.stringify({ synthetic: true, category: "flatshare-room", expected: {} }),
    });
    expect(checkSyntheticSet(dir)).toEqual([]);
  });
});
