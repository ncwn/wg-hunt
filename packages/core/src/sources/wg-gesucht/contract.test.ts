import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import {
  applicableRuleFactKeys,
  offerFactsSchema,
  RULE_FACT_KEYS,
} from "../../offer-facts/index.js";
import { RULES_VERSION } from "./parse-offer.js";
import { fixture, offer, parseHtml } from "./testing.js";

const OFFER_FIXTURES = [
  "flatshare",
  "one-room-flat",
  "flat",
  "house",
  "per-night",
  "translated",
  "deactivated",
];

/** Ignores whitespace and the colon between a label and its value, which sit in separate tags. */
const squash = (text: string) => text.replace(/[\s:]+/g, "");

function pageHaystack(html: string): string {
  const $ = cheerio.load(html);
  const attributes = $("*")
    .toArray()
    .flatMap((element) => ("attribs" in element ? Object.values(element.attribs) : []));
  return squash([$("body").text(), $("script").text(), ...attributes].join(" "));
}

describe.each(OFFER_FIXTURES)("%s: the parsed facts honour the Offer Facts contract", (name) => {
  const html = fixture(name);
  const page = offer(name, html);
  const entries = Object.entries(page.facts);

  it("validates against the Offer Facts schema", () => {
    const result = offerFactsSchema.safeParse({ category: page.category, ...page.facts });
    expect(result.error?.issues).toBeUndefined();
  });

  it("has exactly the rule facts that apply to its category, unknown where the page is silent", () => {
    expect(Object.keys(page.facts).sort()).toEqual(
      [...applicableRuleFactKeys(page.category)].sort(),
    );
  });

  it("gives every fact origin field and a quote the page actually shows", () => {
    const haystack = pageHaystack(html);
    for (const [key, fact] of entries) {
      expect(fact?.origin, key).toBe("field");
      if (fact?.value !== "unknown") expect(fact?.quote, `${key} has no quote`).not.toBe("");
      for (const piece of (fact?.quote ?? "").split(" / ")) {
        expect(haystack.includes(squash(piece)), `${key} quotes "${piece}"`).toBe(true);
      }
    }
  });

  it("stamps the rules version", () => {
    expect(page.rulesVersion).toBe(RULES_VERSION);
  });
});

describe("across all the fixtures", () => {
  const facts = OFFER_FIXTURES.flatMap((name) =>
    Object.entries(offer(name).facts).map(([key, fact]) => ({ name, key, fact })),
  );

  it("reads every rule fact to a real, quoted value somewhere, so no section goes unchecked", () => {
    const read = new Set(facts.filter(({ fact }) => fact?.value !== "unknown").map((f) => f.key));
    const missing = RULE_FACT_KEYS.filter((key) => !read.has(key));
    expect(missing).toEqual([]);
  });

  it("quotes the absences it reports: false, none, zero and empty lists", () => {
    const absences = facts.filter(({ fact }) => {
      const value = fact?.value;
      return (
        value === false ||
        value === "none" ||
        value === 0 ||
        (Array.isArray(value) && value.length === 0)
      );
    });
    expect(absences.map((a) => a.key)).toEqual(
      expect.arrayContaining(["verified", "availableUntil"]),
    );
    for (const { name, key, fact } of absences) {
      expect(fact?.quote, `${name} ${key}`).not.toBe("");
    }
  });
});

describe("quotes and the Advertiser's own text", () => {
  it("never quote the machine translation", () => {
    const html = fixture("translated");
    const $ = cheerio.load(html);
    const translation = squash($(".translation_content").text());
    const original = squash($(".original_content").text());
    for (const [key, fact] of Object.entries(offer("translated", html).facts)) {
      const quote = squash(fact?.quote ?? "");
      if (quote.length < 8) continue;
      const fromTranslation = translation.includes(quote) && !original.includes(quote);
      expect(fromTranslation, key).toBe(false);
    }
  });

  it("returns free text that is an exact substring of the original content", () => {
    const html = fixture("translated");
    const $ = cheerio.load(html);
    const original = $("#freitext_0 .original_content").text().replace(/\s+/g, " ").trim();
    const parsed = offer("translated", html).text.sections[0]?.text ?? "";
    expect(original).toContain(parsed.replace(/\n/g, " "));
  });
});

describe("unexpected pages", () => {
  it("reports an empty document", () => {
    expect(parseHtml("")).toMatchObject({ outcome: "unexpected" });
  });

  it("reports a bot check page, which has no description block", () => {
    const html =
      '<html><head><title>Überprüfung</title></head><body><form name="checkform" action="/cuba.html"></form></body></html>';
    expect(parseHtml(html)).toMatchObject({ outcome: "unexpected", rulesVersion: RULES_VERSION });
  });

  it("does not put any page content in the reason, since pages hold location data", () => {
    const result = parseHtml(fixture("flatshare").replace('id="ad_description_text"', 'id="x"'));
    expect(result).toMatchObject({ outcome: "unexpected" });
    expect(JSON.stringify(result)).not.toContain("Teststraße");
  });
});
