import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrastRatio, readThemes } from "./contrast.js";

const css = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
const themes = readThemes(css);

type Themed = string | { light: string; dark?: string };
type TokensJson = {
  color: { tokens: { name: string; value: Themed }[] };
  type: {
    families: Record<string, string>;
    groups: {
      family: string;
      styles: {
        name: string;
        fontSize: string;
        lineHeight: string;
        fontWeight: number;
        letterSpacing?: string;
      }[];
    }[];
  };
  spacing: { tokens: { name: string; value: string }[] };
  radius: { tokens: { name: string; value: string }[] };
  shadow: { tokens: { name: string; value: Themed }[] };
};
const json = JSON.parse(
  readFileSync(new URL("../../../docs/design-system/tokens.json", import.meta.url), "utf8"),
) as TokensJson;

const PASTELS = ["lavender", "mint", "butter", "sky-soft", "rose"] as const;
// Not canvas: it is the dark frame around the sheet, and no text or control sits straight on it.
const GROUNDS = ["surface", "surface-sunken"] as const;

const textPairs: [string, string][] = [
  ...[...GROUNDS, ...PASTELS].map((g): [string, string] => ["ink", g]),
  ...GROUNDS.map((g): [string, string] => ["ink-muted", g]),
  ...PASTELS.map((p): [string, string] => ["ink-soft", p]),
  ["surface", "ink"],
  ["rail-ink", "rail"],
  ["rail-ink", "rail-raised"],
  ["rail-ink-strong", "rail"],
  ["rail-ink-strong", "rail-raised"],
  ["brand-ink", "brand"],
  ["on-sky-bright", "sky-bright"],
  ["sky", "surface"],
  ["sky", "surface-sunken"],
  ["sky", "sky-soft"],
  ["link", "surface"],
  ["match", "surface"],
  ["match", "mint"],
  ["near", "surface"],
  ["near", "butter"],
  ["warned", "surface"],
  ["warned", "rose"],
  ["hidden", "surface"],
  ["hidden", "surface-sunken"],
];

const shapePairs: [string, string][] = [
  ["line-strong", "surface"],
  ["line-strong", "surface-sunken"],
  ...GROUNDS.map((g): [string, string] => ["focus-ring", g]),
  ["focus-ring", "sky-soft"],
  ["rail-focus-ring", "rail"],
  ["rail-focus-ring", "rail-raised"],
  ["go", "rail"],
  ["go", "surface"],
  ["warned-solid", "surface"],
  ["sky", "sky-soft"],
  ["sky-bright", "rail"],
];

describe("contrast helper", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    // #767676 on white is the well-known smallest grey that still passes 4.5:1.
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.5);
  });
});

describe.each(["light", "dark"] as const)("%s theme", (name) => {
  const theme = themes[name];

  it("defines every token the checks below use", () => {
    const used = new Set([...textPairs, ...shapePairs].flat());
    expect([...used].filter((token) => !(token in theme))).toEqual([]);
  });

  it.each(textPairs)("text %s on %s has at least 4.5:1", (fg, bg) => {
    expect(contrastRatio(theme[fg] as string, theme[bg] as string)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(shapePairs)("%s against %s has at least 3:1", (fg, bg) => {
    expect(contrastRatio(theme[fg] as string, theme[bg] as string)).toBeGreaterThanOrEqual(3);
  });
});

describe("token scales", () => {
  // The scales are the same in both themes, so they are only declared in the first block.
  const baseCss = css.slice(0, css.indexOf("prefers-color-scheme: dark"));
  const declared = (prefix: string) =>
    [...baseCss.matchAll(new RegExp(`--${prefix}[\\w-]*:\\s*([^;]+);`, "g"))].map((m) => m[1]);

  it("sets Manrope in the design system's type styles", () => {
    expect(css).toMatch(/--font-sans:\s*"Manrope Variable"/);
    expect(declared("type-")).toEqual([
      "800 28px / 34px var(--font-sans)",
      "700 20px / 26px var(--font-sans)",
      "700 16px / 22px var(--font-sans)",
      "800 30px / 36px var(--font-sans)",
      "700 18px / 24px var(--font-sans)",
      "500 14px / 20px var(--font-sans)",
      "700 14px / 20px var(--font-sans)",
      "600 12px / 16px var(--font-sans)",
      "500 12px / 16px var(--font-sans)",
    ]);
  });

  it("spaces on a 4px base from 4 to 40", () => {
    expect(declared("space-")).toEqual([
      "4px",
      "8px",
      "12px",
      "16px",
      "20px",
      "24px",
      "32px",
      "40px",
    ]);
  });

  it("rounds at 8 / 12 / 20 / 32 plus a pill", () => {
    expect(declared("radius-")).toEqual(["8px", "12px", "20px", "32px", "999px"]);
  });

  it("matches tokens.json's colours in both themes", () => {
    for (const token of json.color.tokens) {
      const value = typeof token.value === "string" ? { light: token.value } : token.value;
      for (const theme of ["light", "dark"] as const) {
        const raw = value[theme] ?? value.light;
        if (!/^[#{]/.test(raw)) continue;
        const expected = raw.startsWith("{") ? themes[theme][raw.slice(1, -1)] : raw.toLowerCase();
        expect(themes[theme][token.name], `${token.name} (${theme})`).toBe(expected);
      }
    }
  });
});

describe("tokens.css and tokens.json", () => {
  const darkStart = css.indexOf("@media (prefers-color-scheme: dark)");
  const squash = (value: string) => value.replace(/\s+/g, "").toLowerCase();
  const declared = (block: string) =>
    Object.fromEntries(
      [...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], squash(m[2] as string)]),
    );
  const inCss = { light: declared(css.slice(0, darkStart)), dark: declared(css.slice(darkStart)) };

  const themed = (value: Themed) => {
    const both = typeof value === "string" ? { light: value } : value;
    const read = (raw: string) => squash(raw.replace(/^\{(.+)\}$/, "var(--$1)"));
    return { light: read(both.light), dark: read(both.dark ?? both.light) };
  };
  const inJson: Record<string, { light: string; dark: string }> = {};
  for (const token of [...json.color.tokens, ...json.shadow.tokens]) {
    inJson[token.name] = themed(token.value);
  }
  for (const token of [...json.spacing.tokens, ...json.radius.tokens]) {
    inJson[token.name] = themed(token.value);
  }
  for (const [key, family] of Object.entries(json.type.families)) {
    inJson[`font-${key}`] = themed(family);
  }
  for (const group of json.type.groups) {
    for (const style of group.styles) {
      inJson[`type-${style.name}`] = themed(
        `${style.fontWeight} ${style.fontSize} / ${style.lineHeight} var(--font-${group.family})`,
      );
      if (style.letterSpacing) inJson[`tracking-${style.name}`] = themed(style.letterSpacing);
    }
  }

  it("name the same tokens: add a token to both files", () => {
    const css = [...new Set([...Object.keys(inCss.light), ...Object.keys(inCss.dark)])];
    const json = Object.keys(inJson);
    expect(
      css.filter((name) => !json.includes(name)),
      "in tokens.css only",
    ).toEqual([]);
    expect(
      json.filter((name) => !css.includes(name)),
      "in tokens.json only",
    ).toEqual([]);
  });

  it("give each token the same value in both themes", () => {
    for (const [name, value] of Object.entries(inJson)) {
      expect(inCss.light[name], `${name} (light)`).toBe(value.light);
      expect(inCss.dark[name] ?? inCss.light[name], `${name} (dark)`).toBe(value.dark);
    }
  });
});
