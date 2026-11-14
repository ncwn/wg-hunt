import type { CheerioAPI } from "cheerio";
import * as cheerio from "cheerio";
import { clean } from "./german.js";

type Selection = ReturnType<CheerioAPI>;

export type Page = {
  $: CheerioAPI;
  /** Inline scripts hold the dataLayer, ad targeting and map config. */
  scripts: string;
  /** Label/value rows of the Kosten and Verfügbarkeit blocks, keyed by label without the colon. */
  rows: Map<string, Row>;
  keyFacts: Map<string, Row>;
};

export type Row = {
  label: string;
  value: string;
  quote: string;
};

export function loadPage(html: string): Page {
  const $ = cheerio.load(html);
  const scripts = $("script")
    .toArray()
    .map((script) => $(script).text())
    .join("\n");

  const rows = new Map<string, Row>();
  $(".section_panel_detail").each((_, element) => {
    const value = rowValue($(element));
    if (value === undefined) return;
    const label = clean($(element).text());
    const text = clean(value.text());
    if (text === "") return;
    const key = label.replace(/:$/, "");
    if (!rows.has(key)) rows.set(key, { label, value: text, quote: `${label} ${text}` });
  });

  const keyFacts = new Map<string, Row>();
  $(".key_fact_detail").each((_, element) => {
    // A hidden colon and a line break may sit between the label and its value.
    const value = $(element).nextAll(".key_fact_value").first();
    if (value.length === 0) return;
    const label = clean($(element).text());
    const text = clean(value.text());
    if (!keyFacts.has(label))
      keyFacts.set(label, { label, value: text, quote: `${label}: ${text}` });
  });

  return { $, scripts, rows, keyFacts };
}

/**
 * The value beside a label: the next `.section_panel_value`, or, where the label and the value sit
 * in two columns of one `.row`, the column after the label's. A row that holds more than one label
 * is a list (WG-Details), not a label/value pair.
 */
function rowValue(label: Selection): Selection | undefined {
  const sibling = label.nextAll(".section_panel_value").first();
  if (sibling.length > 0) return sibling;
  const column = label.closest('[class*="col-"]');
  const row = column.parent(".row");
  if (row.length === 0 || row.find(".section_panel_detail").length !== 1) return undefined;
  const value = column.nextAll('[class*="col-"]').first();
  return value.length > 0 ? value : undefined;
}

/**
 * The text of an element the way a browser shows it: a `<br>` is a line break, source newlines are
 * not. When the page shows a machine translation, `.original_content` is the Advertiser's own text.
 */
export function ownText(element: Selection): string {
  const original = element.find(".original_content").first();
  const source = original.length > 0 ? original : element;
  const html = (source.html() ?? "").replace(/\s+/g, " ").replace(/\s*<br\s*\/?>\s*/gi, "\n");
  return cheerio
    .load(`<div>${html}</div>`)("div")
    .text()
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

export function adStatus(page: Page): string | undefined {
  return page.scripts.match(/['"]ad_status['"]\s*:\s*['"]([^'"]*)['"]/)?.[1];
}
