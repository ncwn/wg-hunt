import type { RuleFacts } from "../../offer-facts/index.js";
import { field, unknown } from "./build.js";
import { clean } from "./german.js";
import type { Page, Row } from "./page.js";

/** The flatshare-details lines carry no keys, so facts match by pattern. */
export type WgDetails = {
  /** Lines under "Die WG:". */
  flat: string[];
  /** Lines under "Gesucht wird:". */
  sought: string[];
};

export function readWgDetails(page: Page): WgDetails {
  const details: WgDetails = { flat: [], sought: [] };
  page.$("h3.headline").each((_, heading) => {
    const title = clean(page.$(heading).text());
    const target = /^Die WG/i.test(title)
      ? details.flat
      : /^Gesucht wird/i.test(title)
        ? details.sought
        : undefined;
    if (!target) return;
    page
      .$(heading)
      .nextAll("ul")
      .first()
      .find(".section_panel_detail")
      .each((__, line) => {
        target.push(clean(page.$(line).text()));
      });
  });
  return details;
}

/** "Wohnungsgröße: 80m²" is the size of the whole flat. */
export function wgFlatSize(details: WgDetails): Row | undefined {
  for (const line of details.flat) {
    const match = line.match(/^Wohnungsgröße:\s*(.+)$/);
    if (match?.[1]) return { label: "Wohnungsgröße:", value: match[1], quote: line };
  }
  return undefined;
}

const FLATMATES = /^(\d+)er WG \((\d+)w,(\d+)m,(\d+)d,(\d+)n\)$/;

/** The h1 carries the flatshare size and the current flatmates by gender. */
export function flatmateFacts(page: Page) {
  const title = clean(page.$("h1.detailed-view-title > span.mr5").first().attr("title") ?? "");
  const facts: Partial<RuleFacts> = {};
  const match = title.match(FLATMATES);
  if (!match) {
    facts.flatmates = unknown(title);
    facts.flatshareSize = unknown(title);
    return facts;
  }
  const [, size = "0", women = "0", men = "0", diverse = "0", unspecified = "0"] =
    match.map(String);
  facts.flatshareSize = field(Number(size), title);
  // (0w,0m,0d,0n) is what the page shows when it has no flatmate information at all.
  facts.flatmates =
    women === "0" && men === "0" && diverse === "0" && unspecified === "0"
      ? unknown(title)
      : field(
          {
            women: Number(women),
            men: Number(men),
            diverse: Number(diverse),
            unspecified: Number(unspecified),
          },
          title,
        );
  return facts;
}
