import type { RuleFacts } from "../../offer-facts/index.js";
import { field, unknown } from "./build.js";
import { clean } from "./german.js";
import type { Page } from "./page.js";

/** Image URLs sometimes carry a stray "/./" path segment. */
const normalizeUrl = (url: string): string => url.replace("/./", "/");

/** The ad targeting says whether the Offer has pictures at all: `wgg_pic` is "1" or "0". */
const NO_PICTURES = /setTargeting\(\s*["']wgg_pic["']\s*,\s*["']0["']\s*\)/;

export function mediaFacts(page: Page): Partial<RuleFacts> {
  const { $ } = page;
  const label = clean($("#gallery_images_label").first().text());
  const slides = $("#gallery_slides img.sp-image");

  const urls = slides
    .toArray()
    .map(
      (image) =>
        $(image).attr("data-large") ??
        $(image).attr("data-src") ??
        $(image).attr("data-medium") ??
        $(image).attr("data-small") ??
        "",
    )
    .filter((url) => url !== "")
    .map(normalizeUrl);

  const labelled = label.match(/^(\d+)\b/)?.[1];
  const noPictures = page.scripts.match(NO_PICTURES)?.[0];
  const firstUrl = urls[0];

  const facts: Partial<RuleFacts> = {};
  if (labelled !== undefined) {
    facts.photoCount = field(Number(labelled), label);
  } else if (firstUrl) {
    facts.photoCount = field(urls.length, firstUrl);
  } else {
    // No gallery at all: only the ad targeting can say that there are no pictures.
    facts.photoCount = noPictures ? field(0, noPictures) : unknown();
  }
  facts.imageUrls = firstUrl
    ? field(urls, label || firstUrl)
    : noPictures
      ? field([], noPictures)
      : unknown();
  return facts;
}

/**
 * Whenever the page language differs from the language the Advertiser wrote in, the page shows a
 * machine translation next to the original. Without one, the title the page shows is the original.
 */
export function languageFacts(page: Page, title: string): Partial<RuleFacts> {
  const { $ } = page;
  if ($(".translation_content").length > 0) {
    const notice = $("a, span, small, p")
      .toArray()
      .map((element) => clean($(element).text()))
      .find((text) => /automatisch übersetzt/i.test(text) && text.length < 80);
    return { offerLanguage: field("other", notice ?? "Text automatisch übersetzt") };
  }
  return { offerLanguage: title ? field("german", title) : unknown() };
}
