import { describe, expect, it } from "vitest";
import { RULES_VERSION } from "./parse-offer.js";
import { fixture, parseHtml } from "./testing.js";

describe("page status", () => {
  it("reports a deleted page as deleted, with no facts", () => {
    expect(parseHtml(fixture("deleted"))).toEqual({
      outcome: "parsed",
      status: "deleted",
      rulesVersion: RULES_VERSION,
    });
  });

  it("reports a page with no description block as unexpected", () => {
    const result = parseHtml(
      "<html><head><title>Irgendwas Neues</title></head><body><div>Hallo</div></body></html>",
    );
    expect(result).toMatchObject({ outcome: "unexpected", rulesVersion: RULES_VERSION });
  });

  it("reports an Offer page without ad_status as unexpected", () => {
    const result = parseHtml(fixture("flatshare").replace(/.*ad_status.*\n/, ""));
    expect(result).toMatchObject({ outcome: "unexpected", rulesVersion: RULES_VERSION });
    expect(result.outcome === "unexpected" && result.reason).toMatch(/ad_status/);
  });

  it.each(["paused", "Active", "", "in-active"])(
    "reports ad_status '%s' as unexpected, naming the value",
    (value) => {
      const result = parseHtml(
        fixture("flatshare").replace("'ad_status': 'active'", `'ad_status': '${value}'`),
      );
      expect(result).toMatchObject({ outcome: "unexpected", rulesVersion: RULES_VERSION });
      const reason = result.outcome === "unexpected" ? result.reason : "";
      expect(reason).toContain("ad_status");
      expect(reason).toContain(`'${value}'`);
    },
  );

  it("keeps page content out of an ad_status reason", () => {
    const long = parseHtml(
      fixture("flatshare").replace("'ad_status': 'active'", `'ad_status': '${"x".repeat(200)}'`),
    );
    expect(long.outcome === "unexpected" && long.reason.length).toBeLessThan(100);
    const missing = parseHtml(fixture("flatshare").replace(/.*ad_status.*\n/, ""));
    expect(missing.outcome === "unexpected" && missing.reason).not.toContain("Teststraße");
  });
});
