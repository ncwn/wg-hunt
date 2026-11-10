import type { SourceAdapter } from "../../source/source.js";
import { adIdFromUrl, offerUrl } from "./offer-urls.js";
import { parseOffer, RULES_VERSION } from "./parse-offer.js";
import { parseSearchPage } from "./search-page.js";
import { searchPages } from "./search-urls.js";

export const wgGesuchtSource: SourceAdapter = {
  id: "wg-gesucht",
  rulesVersion: RULES_VERSION,
  parseOffer,
  searchPages,
  parseSearchPage,
  offerUrl,
  adIdFromUrl,
};
