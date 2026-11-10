import { SOURCE_ORIGIN } from "./constants.js";
import type { SourceResponse } from "./fetcher.js";

/** In the order `detectBotCheck` looks. */
export const BOT_CHECK_MARKERS = [
  "redirect-cuba",
  "checkform",
  "title",
  "heading",
  "g-recaptcha",
  "recaptcha-script",
  "cuba-link",
  "http-403",
  "http-429",
] as const;

/** Stored in the request log and hit history; the page itself never is. */
export type BotCheckMarker = (typeof BOT_CHECK_MARKERS)[number];

export type BotCheck = { marker: BotCheckMarker };

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  Uuml: "Ü",
  uuml: "ü",
  Ouml: "Ö",
  ouml: "ö",
  Auml: "Ä",
  auml: "ä",
  szlig: "ß",
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,6})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (whole, dec, hex, name) => {
    if (name !== undefined) return ENTITIES[name] ?? whole;
    const code = dec !== undefined ? Number(dec) : Number.parseInt(hex, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

// Composed (NFC), so "U" plus a combining diaeresis compares equal to "Ü".
const textOf = (html: string) =>
  decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFC");

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(
    tag,
  );
  return match === null ? undefined : (match[1] ?? match[2] ?? match[3]);
}

function isCubaUrl(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url.trim(), `${SOURCE_ORIGIN}/`);
    const own = new URL(SOURCE_ORIGIN).hostname;
    return (
      pathname.toLowerCase() === "/cuba.html" &&
      (hostname === own || hostname === "wg-gesucht.de" || hostname.endsWith(".wg-gesucht.de"))
    );
  } catch {
    return false;
  }
}

function isCubaPath(location: string): boolean {
  try {
    return new URL(location, `${SOURCE_ORIGIN}/`).pathname.toLowerCase().endsWith("/cuba.html");
  } catch {
    return false;
  }
}

/**
 * Never matches the bare strings `captcha`, `recaptcha`, `cmp` or `altcha`: they are on every
 * normal page (consent banner, registration form), so each marker looks at an element, not at text.
 */
export function detectBotCheck(response: SourceResponse): BotCheck | undefined {
  const { status, body, location } = response;
  if (location !== undefined && isCubaPath(location)) return { marker: "redirect-cuba" };

  for (const [tag] of body.matchAll(/<form\b[^>]*>/gi)) {
    if (
      attribute(tag, "name")?.toLowerCase() === "checkform" &&
      attribute(tag, "action")?.toLowerCase().includes("cuba.html")
    ) {
      return { marker: "checkform" };
    }
  }

  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1];
  if (title !== undefined && textOf(title).toLowerCase() === "überprüfung".normalize("NFC")) {
    return { marker: "title" };
  }

  for (const [, inner] of body.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)) {
    if (/dass sie ein mensch sind/i.test(textOf(inner ?? ""))) return { marker: "heading" };
  }

  for (const [tag] of body.matchAll(/<[a-z][^>]*>/gi)) {
    if (attribute(tag, "class")?.split(/\s+/).includes("g-recaptcha")) {
      return { marker: "g-recaptcha" };
    }
  }

  for (const [tag] of body.matchAll(/<script\b[^>]*>/gi)) {
    if (/\/\/(?:www\.)?google\.com\/recaptcha\/api\.js/i.test(attribute(tag, "src") ?? "")) {
      return { marker: "recaptcha-script" };
    }
  }

  for (const [tag] of body.matchAll(/<(?:a|area|form|meta|link)\b[^>]*>/gi)) {
    const refresh = /^\s*refresh\s*$/i.test(attribute(tag, "http-equiv") ?? "")
      ? /url\s*=\s*["']?([^"';\s]+)/i.exec(attribute(tag, "content") ?? "")?.[1]
      : undefined;
    const targets = [attribute(tag, "href"), attribute(tag, "action"), refresh];
    if (targets.some((url) => url !== undefined && isCubaUrl(url))) {
      return { marker: "cuba-link" };
    }
  }

  if (status === 403) return { marker: "http-403" };
  if (status === 429) return { marker: "http-429" };
  return undefined;
}
