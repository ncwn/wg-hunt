import { readFileSync } from "node:fs";
import type { ParseContext } from "../../source/source.js";
import { wgGesuchtSource } from "./index.js";

export const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), "utf8");

export const ctx: ParseContext = { firstSeen: new Date("2026-11-04T09:00:00Z") };

export const parseHtml = (html: string, context: ParseContext = ctx) =>
  wgGesuchtSource.parseOffer(html, context);

export function offer(name: string, html = fixture(name), context: ParseContext = ctx) {
  const result = parseHtml(html, context);
  if (result.outcome !== "parsed" || result.status === "deleted") {
    throw new Error(`${name} did not parse as an Offer: ${JSON.stringify(result)}`);
  }
  return result;
}

export const fact = (value: unknown, quote: string) => ({ value, origin: "field", quote });
