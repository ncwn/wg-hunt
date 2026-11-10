import { describe, expect, it } from "vitest";
import { BOT_CHECK_MARKERS, type BotCheckMarker, detectBotCheck } from "../src/crawl/bot-check.js";
import type { SourceResponse } from "../src/crawl/fetcher.js";
import {
  cubaPage,
  offerPage,
  offerPageWithAltcha,
  searchPage,
  textMentioningPage,
  withCheckform,
  withHeading,
  withRecaptchaElement,
  withRecaptchaScript,
  withTitle,
} from "./fixtures/pages.js";

const ok = (body: string) => ({ status: 200, body });

describe("bot check detection: every marker fires", () => {
  it("a redirect to /cuba.html, absolute or relative, with or without a query", () => {
    for (const location of [
      "https://www.wg-gesucht.de/cuba.html?page=/wg-zimmer-in-Berlin.8.0.1.0.html",
      "/cuba.html",
      "cuba.html?page=/x.html",
    ]) {
      expect(detectBotCheck({ status: 302, body: "", location })?.marker, location).toBe(
        "redirect-cuba",
      );
    }
  });

  it("a checkform posting to /cuba.html", () => {
    expect(detectBotCheck(ok(withCheckform()))?.marker).toBe("checkform");
  });

  it("the title Überprüfung, also written with entities", () => {
    expect(detectBotCheck(ok(withTitle()))?.marker).toBe("title");
    expect(detectBotCheck(ok("<title>Überprüfung</title>"))?.marker).toBe("title");
  });

  it('the h1 "dass Sie ein Mensch sind", across inner tags and spacing', () => {
    expect(detectBotCheck(ok(withHeading()))?.marker).toBe("heading");
  });

  it("a g-recaptcha element", () => {
    expect(detectBotCheck(ok(withRecaptchaElement()))?.marker).toBe("g-recaptcha");
  });

  it("the google.com/recaptcha/api.js script", () => {
    expect(detectBotCheck(ok(withRecaptchaScript()))?.marker).toBe("recaptcha-script");
  });

  it("a link, a form action or a meta refresh pointing at /cuba.html", () => {
    const bodies = [
      `<a href="https://www.wg-gesucht.de/cuba.html?page=/x.html">weiter</a>`,
      `<a href='/cuba.html'>weiter</a>`,
      `<form method="post" action="cuba.html"><input name="step"></form>`,
      `<meta http-equiv="refresh" content="0; url=/cuba.html?page=/x.html">`,
      `<META CONTENT='3;URL=https://www.wg-gesucht.de/cuba.html' HTTP-EQUIV='Refresh'>`,
    ];
    for (const body of bodies) {
      expect(detectBotCheck(ok(`<html><body>${body}</body></html>`))?.marker, body).toBe(
        "cuba-link",
      );
    }
  });

  it("the title and the h1 written with combining characters", () => {
    expect(detectBotCheck(ok("<title>U\u0308berpru\u0308fung</title>"))?.marker).toBe("title");
    expect(
      detectBotCheck(ok("<h1>Bitte besta\u0308tigen Sie, dass Sie ein Mensch sind</h1>"))?.marker,
    ).toBe("heading");
  });

  it("HTTP 403 and 429, whatever the body", () => {
    expect(detectBotCheck({ status: 403, body: "" })?.marker).toBe("http-403");
    expect(detectBotCheck({ status: 429, body: searchPage() })?.marker).toBe("http-429");
  });

  it("the whole /cuba.html page, naming the first marker that fired", () => {
    expect(detectBotCheck(ok(cubaPage()))?.marker).toBe("checkform");
  });

  it("is not fooled by letter case or attribute order", () => {
    expect(detectBotCheck(ok(`<FORM ACTION="/CUBA.HTML" Name="checkform"></FORM>`))?.marker).toBe(
      "checkform",
    );
  });
});

describe("the marker list", () => {
  // Typed as a record so that a marker added to the list needs a response that fires it.
  const fires: Record<BotCheckMarker, SourceResponse> = {
    "redirect-cuba": { status: 302, body: "", location: "/cuba.html" },
    checkform: ok(withCheckform()),
    title: ok(withTitle()),
    heading: ok(withHeading()),
    "g-recaptcha": ok(withRecaptchaElement()),
    "recaptcha-script": ok(withRecaptchaScript()),
    "cuba-link": ok(`<a href="/cuba.html">weiter</a>`),
    "http-403": { status: 403, body: "" },
    "http-429": { status: 429, body: "" },
  };

  it("holds every marker the detector gives, and none it never gives", () => {
    expect(Object.keys(fires).sort()).toEqual([...BOT_CHECK_MARKERS].sort());
    for (const marker of BOT_CHECK_MARKERS) {
      expect(detectBotCheck(fires[marker])?.marker, marker).toBe(marker);
    }
  });
});

describe("bot check detection: normal pages are never flagged", () => {
  const normal = {
    "a search page with the consent banner and a registration captcha field": searchPage(),
    "a search page with no cards": searchPage(0),
    "an offer page": offerPage(),
    "an offer page with the altcha widget": offerPageWithAltcha(),
    "a page that mentions captcha, cmp, altcha and Überprüfung in its text": textMentioningPage(),
  };
  it.each(Object.entries(normal))("%s", (_name, body) => {
    expect(detectBotCheck(ok(body))).toBeUndefined();
  });

  it("other redirects and other error statuses", () => {
    expect(detectBotCheck({ status: 301, body: "", location: "/wg-zimmer.html" })).toBeUndefined();
    expect(detectBotCheck({ status: 404, body: "" })).toBeUndefined();
    expect(detectBotCheck({ status: 500, body: "" })).toBeUndefined();
  });

  it("links to other pages whose name merely resembles cuba.html", () => {
    for (const body of [
      `<a href="/reisen/cuba.html">Urlaub</a>`,
      `<a href="/cuba-reise.html">Urlaub</a>`,
      `<a href="https://example.org/cuba.html">extern</a>`,
      `<p>Siehe cuba.html im Text</p>`,
    ]) {
      expect(detectBotCheck(ok(body)), body).toBeUndefined();
    }
  });

  it("a bare recaptcha.net in the consent allow-list or a form posting elsewhere", () => {
    expect(
      detectBotCheck(
        ok(`<script>var a=["recaptcha.net"]</script><form name="search" action="/s.html"></form>`),
      ),
    ).toBeUndefined();
    expect(
      detectBotCheck(ok(`<form name="checkform" action="/other.html"></form>`)),
    ).toBeUndefined();
  });
});
