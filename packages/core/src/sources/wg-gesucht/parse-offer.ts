import {
  applicableRuleFactKeys,
  type RuleFacts,
  ruleFactsSchema,
} from "../../offer-facts/index.js";
import type { Category } from "../../searches.js";
import type { OfferText, ParseContext, ParseResult } from "../../source/source.js";
import { advertiserFacts, documentFacts } from "./advertiser-facts.js";
import { unknown } from "./build.js";
import { flatmateFacts, readWgDetails, wgFlatSize } from "./flatshare-facts.js";
import { clean } from "./german.js";
import { languageFacts, mediaFacts } from "./media-facts.js";
import { objectFacts } from "./object-facts.js";
import { adStatus, loadPage, ownText, type Page } from "./page.js";
import { availabilityFacts, locationFacts, onlineAge } from "./place-and-time-facts.js";
import { costFacts, sizeFacts } from "./size-and-cost-facts.js";
import { wgDetailFacts } from "./wg-detail-facts.js";

/** Bump when parsing changes in a way that should re-parse every stored page. */
export const RULES_VERSION = 2;

const unexpected = (reason: string): ParseResult => ({
  outcome: "unexpected",
  reason,
  rulesVersion: RULES_VERSION,
});

export function parseOffer(html: string, ctx: ParseContext): ParseResult {
  const page = loadPage(html);
  const { $ } = page;

  if (clean($("title").first().text()).startsWith("Anzeige nicht vorhanden")) {
    return { outcome: "parsed", status: "deleted", rulesVersion: RULES_VERSION };
  }
  if ($("#ad_description_text").length === 0) return unexpected("no description block");
  const status = pageStatus(adStatus(page));
  if (typeof status !== "string") return status;

  const category = ctx.category ?? detectCategory(page);
  const wgDetails = readWgDetails(page);
  const adId = readAdId(page);
  const text = readText(page);

  const sizes = sizeFacts(page, category, wgFlatSize(wgDetails));
  const candidates: Partial<RuleFacts> = {
    ...flatmateFacts(page),
    ...wgDetailFacts(wgDetails),
    ...sizes,
    ...costFacts(page, sizes.roomSize),
    ...availabilityFacts(page, ctx),
    ...locationFacts(page, adId),
    ...objectFacts(page),
    ...advertiserFacts(page),
    ...documentFacts(page),
    ...mediaFacts(page),
    ...languageFacts(page, text.title),
  };

  const facts: Record<string, unknown> = {};
  for (const key of applicableRuleFactKeys(category)) facts[key] = candidates[key] ?? unknown();
  const checked = ruleFactsSchema.safeParse(facts);
  if (!checked.success) {
    const paths = checked.error.issues.map((issue) => issue.path.join("."));
    return unexpected(`parsed facts failed validation: ${paths.join(", ")}`);
  }

  return {
    outcome: "parsed",
    status,
    rulesVersion: RULES_VERSION,
    adId,
    category,
    text,
    online: onlineAge(page),
    facts: checked.data,
  };
}

function pageStatus(adStatus: string | undefined): "active" | "deactivated" | ParseResult {
  if (adStatus === "active") return "active";
  if (adStatus === "inactive") return "deactivated";
  if (adStatus === undefined) return unexpected("no ad_status");
  // A reason must not carry page content; 40 characters are enough to name a status.
  return unexpected(`unknown ad_status '${adStatus.slice(0, 40)}'`);
}

function readAdId(page: Page): string | undefined {
  const fromScript = page.scripts.match(/\bvar\s+ad_id\s*=\s*(\d+)/);
  if (fromScript?.[1]) return fromScript[1];
  return clean(page.$("#basic_ad_details").text()).match(/Anzeigennummer:\s*(\d+)/)?.[1];
}

function readText(page: Page): OfferText {
  const { $ } = page;
  const h1 = $("h1.detailed-view-title").first();
  // The Advertiser's own title when the page shows a translation, else the title span.
  const original = h1.find(".original_content").first();
  const title =
    original.length > 0
      ? ownText(original)
      : h1.length > 0
        ? ownText(h1.children("span").last())
        : "";

  const labels = new Map<string, string>();
  $('.section_panel_tab[data-text^="#freitext_"]').each((_, tab) => {
    const id = $(tab).attr("data-text")?.slice(1);
    if (id) labels.set(id, clean($(tab).find("h2").first().text()));
  });
  const sections: OfferText["sections"] = [];
  $('#ad_description_text [id^="freitext_"]').each((_, body) => {
    const id = $(body).attr("id") ?? "";
    sections.push({ label: labels.get(id) ?? id, text: ownText($(body)) });
  });
  return { title, sections };
}

/** Only flatshare pages have a "Zimmergröße", and only flats and houses state a number of rooms. */
function detectCategory(page: Page): Category {
  if (page.keyFacts.has("Zimmergröße") || page.$("h1.detailed-view-title > span.mr5").length > 0) {
    return "flatshare-room";
  }
  if (!page.keyFacts.has("Zimmer")) return "one-room-flat";
  const canonical = page.$('link[rel="canonical"]').attr("href") ?? "";
  const suffix = clean(page.$("title").first().text()).split(" - ").at(-1) ?? "";
  return /\/(?:haus|haeuser)-in-/i.test(canonical) || /\bHaus in\b/.test(suffix) ? "house" : "flat";
}
