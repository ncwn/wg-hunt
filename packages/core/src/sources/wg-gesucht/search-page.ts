import type { CheerioAPI } from "cheerio";
import * as cheerio from "cheerio";
import type { AdvertiserKind, SearchCard, SearchPageResult } from "../../source/source.js";
import { clean, parseEuros, parseNumber, parseOnlineWithUnit } from "./german.js";

type Selection = ReturnType<CheerioAPI>;

const CARD = "a.offer_list_item[id^='liste-details-ad-']";
const AD_ID = /^liste-details-ad-(\d+)$/;

const BADGES: Record<string, AdvertiserKind> = {
  privat: "private",
  "privat pro": "pro",
  "unternehmen pro": "company",
};

/**
 * The Offer page path: the card's own link when it is a plain `/slug.<Ad ID>.html`, otherwise the
 * short form `/<Ad ID>.html`, which serves the same page. Never anything with a query or a host.
 */
function offerPath(href: string | undefined, adId: string): string {
  return href && new RegExp(`^/[\\p{L}\\p{N}._%-]+\\.${adId}\\.html$`, "u").test(href)
    ? href
    : `/${adId}.html`;
}

function readCard(card: Selection, adId: string): SearchCard {
  const text = (selector: string) => clean(card.find(selector).first().text());

  const icon = card.find(".online-since-icon").first();
  const ageText =
    icon.nextAll(".card-subtitle").first().text() ||
    icon.parent().find(".card-subtitle").last().text();
  const online = parseOnlineWithUnit(ageText);

  const price = text(".price-row .card-main-text");
  const amount = price === "" ? undefined : parseEuros(price);
  const night = /nacht/i.test(text(".price-row .card-subtitle"));
  const size = text(".size-value");
  const sizeValue = size === "" ? undefined : parseNumber(size);

  const name = text(".user-name");
  const avatar = card.find("img.avatar").first().attr("src");
  const kind = BADGES[text(".user-badge").toLowerCase()];

  return {
    adId,
    path: offerPath(card.attr("href"), adId),
    title: clean(card.attr("aria-label") ?? "") || text(".card-title-text"),
    ...(amount !== undefined && { rent: { amount, unit: night ? "night" : "month" } }),
    ...(sizeValue !== undefined && { size: sizeValue }),
    advertiser: {
      ...(name !== "" && { name }),
      ...(avatar && { avatarUrl: avatar }),
      ...(kind && { kind }),
    },
    ...(online && { online }),
  };
}

/**
 * Every card with `campaign_click` is a Promoted placement: the sticky "Sofortbuchung" cards, the
 * "verified providers" list repeated on every page, partner cards, the Plus teaser.
 *
 * A results page has the filter form or at least one card. A page past the last one still has the
 * form and the repeated Promoted placements, and no organic card: the normal end of results.
 */
export function parseSearchPage(html: string): SearchPageResult {
  const $ = cheerio.load(html);
  if ($("form#offer_filter_form").length === 0 && $(CARD).length === 0) {
    return { outcome: "unexpected", reason: "no filter form and no cards: not a page of results" };
  }

  const cards: SearchCard[] = [];
  const seen = new Set<string>();
  let promoted = 0;
  $(CARD).each((_, element) => {
    const card = $(element);
    const adId = AD_ID.exec(card.attr("id") ?? "")?.[1];
    if (!adId) return;
    if (card.hasClass("campaign_click")) {
      promoted++;
      return;
    }
    if (seen.has(adId)) return;
    seen.add(adId);
    cards.push(readCard(card, adId));
  });
  return { outcome: "results", cards, promoted };
}
