import { describe, expect, it } from "vitest";
import { wgGesuchtSource } from "./index.js";
import { RULES_VERSION } from "./parse-offer.js";

describe("Offer URLs", () => {
  it("reads the Ad ID from a pasted Offer URL, whatever the slug or language prefix", () => {
    const read = wgGesuchtSource.adIdFromUrl;
    expect(read("https://www.wg-gesucht.de/wg-zimmer-in-Berlin-Mitte.1234567.html")).toBe(
      "1234567",
    );
    expect(read("https://wg-gesucht.de/en/wohnungen-in-Hamburg.9876543.html?cid=1#top")).toBe(
      "9876543",
    );
    expect(read("  https://www.wg-gesucht.de/1234567.html  ")).toBe("1234567");
    expect(read("www.wg-gesucht.de/wg-zimmer-in-Berlin.1234567.html")).toBe("1234567");
    expect(read("/wg-zimmer-in-Berlin.1234567.html")).toBe("1234567");
  });

  it("does not take a page that is not an Offer, or another site, for an Offer URL", () => {
    const read = wgGesuchtSource.adIdFromUrl;
    expect(read("https://www.wg-gesucht.de/wg-zimmer-in-Berlin.8.0.1.0.html")).toBeNull();
    expect(read("https://www.wg-gesucht.de/")).toBeNull();
    expect(read("https://example.com/wg-zimmer-in-Berlin.1234567.html")).toBeNull();
    expect(read("https://www.wg-gesucht.de.evil.test/wg-zimmer-in-Berlin.1234567.html")).toBeNull();
    expect(read("1234567")).toBeNull();
    expect(read("")).toBeNull();
  });

  it("builds the address of an Offer page from its path on the Source", () => {
    expect(wgGesuchtSource.offerUrl("/wg-zimmer-in-Berlin-Mitte.1234567.html")).toBe(
      "https://www.wg-gesucht.de/wg-zimmer-in-Berlin-Mitte.1234567.html",
    );
  });

  it("states the rules version its parse results carry", () => {
    expect(wgGesuchtSource.rulesVersion).toBe(RULES_VERSION);
  });
});
