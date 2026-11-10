import { createHash } from "node:crypto";
import type { OfferText } from "./source.js";

/**
 * Fingerprint of the Advertiser's own words (`.original_content`, never the machine translation).
 * Equal hashes let a re-post reuse its facts instead of paying for them again.
 */
export function contentHash(text: OfferText): string {
  return createHash("sha256")
    .update(JSON.stringify([text.title, text.sections.map((s) => [s.label, s.text])]))
    .digest("hex");
}
