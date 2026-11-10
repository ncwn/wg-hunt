import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesDir = new URL("../src/styles/", import.meta.url);
const sheets = readdirSync(stylesDir)
  .filter((name) => name.endsWith(".css"))
  .map((name) => ({ name, css: readFileSync(new URL(name, stylesDir), "utf8") }));
const all = sheets.map((s) => s.css).join("\n");

describe("focus ring", () => {
  it("is defined once, from one token, for every control", () => {
    expect(all.match(/:focus-visible\s*[,{]/g)).toHaveLength(1);
    expect(all).toMatch(/:focus-visible\s*{[^}]*outline:\s*2px solid var\(--focus-ring\)/);
  });

  it("is never switched off", () => {
    expect(all).not.toMatch(/outline:\s*(none|0)\b/);
  });
});

describe("text field", () => {
  const ui = sheets.find((sheet) => sheet.name === "ui.css")?.css ?? "";
  it("rings the whole box on focus, not the bare input inside it", () => {
    expect(ui).toMatch(
      /\.wh-field-box:has\(\.wh-field-input:focus-visible\)\s*{[^}]*outline:\s*2px solid var\(--focus-ring\)/,
    );
    expect(ui).toMatch(/\.wh-field-input\s*{[^}]*--focus-ring:\s*transparent/);
  });
});

describe("colour", () => {
  it("lives in tokens.css only: no other sheet hard-codes a colour", () => {
    for (const { name, css } of sheets.filter((s) => s.name !== "tokens.css")) {
      const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
      expect(withoutComments, name).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    }
  });
});

describe("Offer card", () => {
  it("keeps solid red out of the offer sheets: the scam alarm is the Notice's border", () => {
    for (const name of ["offers.css", "offer-detail.css"]) {
      const css = sheets.find((sheet) => sheet.name === name)?.css ?? "";
      expect(css, name).not.toMatch(/--warned-solid/);
    }
  });
});

describe("custom properties", () => {
  it("are all defined: no sheet reads a token that tokens.css or the sheet itself doesn't set", () => {
    const defined = new Set([...all.matchAll(/--([\w-]+)\s*:/g)].map((m) => m[1]));
    const used = new Set([...all.matchAll(/var\(--([\w-]+)/g)].map((m) => m[1]));
    expect([...used].filter((name) => !defined.has(name))).toEqual([]);
  });
});
