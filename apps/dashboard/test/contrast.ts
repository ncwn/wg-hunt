export type Theme = Record<string, string>;

const HEX = /--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g;
const ALIAS = /--([\w-]+):\s*var\(--([\w-]+)\)\s*;/g;

function colours(block: string): Theme {
  return Object.fromEntries(
    [...block.matchAll(HEX)].map((m) => [m[1], (m[2] as string).toLowerCase()]),
  );
}

function aliases(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(ALIAS)].map((m) => [m[1], m[2] as string]));
}

function resolve(theme: Theme, links: Record<string, string>): Theme {
  const out = { ...theme };
  for (const name of Object.keys(links)) {
    let target: string | undefined = links[name];
    for (let hops = 0; target && hops < 8 && !(target in theme); hops++) target = links[target];
    if (target && target in theme) out[name] = theme[target] as string;
  }
  return out;
}

export function readThemes(css: string): { light: Theme; dark: Theme } {
  const darkStart = css.indexOf("@media (prefers-color-scheme: dark)");
  if (darkStart < 0) throw new Error("tokens.css has no dark theme");
  const darkEnd = css.indexOf("\n}\n", darkStart) + 3;
  const lightCss = css.slice(0, darkStart) + css.slice(darkEnd);
  const darkCss = css.slice(darkStart, darkEnd);
  const links = aliases(css);
  const light = colours(lightCss);
  const dark = { ...light, ...colours(darkCss) };
  return { light: resolve(light, links), dark: resolve(dark, links) };
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const channel = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
