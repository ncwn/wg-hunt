import type { RequiredDocument, RuleFacts } from "../../offer-facts/index.js";
import { field, unknown } from "./build.js";
import { clean, parseMonth } from "./german.js";
import { DOCUMENT_KEYS } from "./lexicon.js";
import type { Page } from "./page.js";

/** The advertiser box appears twice (desktop and mobile copies), so only the first is read. */
export function advertiserFacts(page: Page): Partial<RuleFacts> {
  const box = page.$(".user_profile_info").first();
  if (box.length === 0) {
    return {
      verified: unknown(),
      memberSince: unknown(),
      companyProfile: unknown(),
      phoneGiven: unknown(),
    };
  }
  const facts: Partial<RuleFacts> = {};

  const since = clean(box.text()).match(/Mitglied seit\s+(\p{L}+\s+\d{4})/u);
  const month = since?.[1] ? parseMonth(since[1]) : undefined;
  facts.memberSince = since && month ? field(month, since[0]) : unknown();

  // The box is shown without the badge or the phone button for an Advertiser who has neither, so
  // that is a no. The "Mitglied seit" line is what shows the box was read: it is the quote.
  const boxQuote = since?.[0] ?? "";
  const verified = box
    .find("a")
    .toArray()
    .some((link) => clean(page.$(link).text()) === "Verifiziert");
  facts.verified = verified
    ? field(true, "Verifiziert")
    : boxQuote
      ? field(false, boxQuote)
      : unknown();

  const profile = box.find('a[href^="/profile/company/"]').first().attr("href");
  facts.companyProfile = profile ? field(profile, profile) : unknown();

  const phone = box
    .find("button, a")
    .toArray()
    .some((element) => /Telefonnummer anzeigen/i.test(clean(page.$(element).text())));
  facts.phoneGiven = phone
    ? field(true, "Telefonnummer anzeigen")
    : boxQuote
      ? field(false, boxQuote)
      : unknown();
  return facts;
}

/** The SCHUFA request is not a Scam signal. */
export function documentFacts(page: Page): Partial<RuleFacts> {
  const { $ } = page;
  const documents: RequiredDocument[] = [];
  const names: string[] = [];
  $(".required-document").each((_, element) => {
    const copy = $(element).clone();
    copy.find(".badge, .material-symbols-outlined").remove();
    const name = clean(copy.text());
    const key = $(element).attr("data-campaign_click_position") ?? "";
    const document: RequiredDocument | undefined =
      DOCUMENT_KEYS[key] ??
      (/immatrikulation/i.test(name)
        ? "enrolment_certificate"
        : /schufa|itsmydata/i.test(name)
          ? "credit_check"
          : undefined);
    if (!document || documents.includes(document)) return;
    documents.push(document);
    names.push(name);
  });

  const facts: Partial<RuleFacts> = {
    requiredDocuments: documents.length > 0 ? field(documents, names.join(" / ")) : unknown(),
  };

  // The cost block's SCHUFA label is the structured flag: "erwünscht" asks for a report, the plain
  // label does not. Nothing else (Kaution, the documents) is read as a SCHUFA request.
  const requested = page.rows.get("SCHUFA-Auskunft erwünscht");
  const notRequested = page.rows.get("SCHUFA-Auskunft");
  if (requested) facts.schufaRequested = field(true, requested.label);
  else if (notRequested) facts.schufaRequested = field(false, notRequested.label);
  else facts.schufaRequested = unknown();
  return facts;
}
