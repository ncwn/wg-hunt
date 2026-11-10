import { wgGesuchtSource } from "@wg-hunt/core/sources/wg-gesucht";
import { describe, expect, it } from "vitest";
import { createSnapshotStore } from "../src/crawl/snapshots.js";
import { readStoredPage } from "../src/offers/stored-page.js";
import { adapterFixture, offerHtml } from "./fixtures/search-pages.js";
import { tempDataDir } from "./helpers.js";

const NOVEMBER = new Date("2026-11-01T10:00:00Z");

function storing(html?: string) {
  const snapshots = createSnapshotStore(tempDataDir());
  if (html !== undefined) snapshots.write("wg-gesucht", "9000001", html);
  return { adapters: { "wg-gesucht": wgGesuchtSource }, snapshots };
}

const ad = { source: "wg-gesucht" as const, adId: "9000001", firstSeenAt: NOVEMBER };

describe("reading a stored page", () => {
  it('reads "frei ab: sofort" as the day the Ad ID was first seen', () => {
    const read = readStoredPage(storing(offerHtml().replace("01.12.2026", "sofort")), ad);
    expect(read.state).toBe("readable");
    expect(read.state === "readable" && read.parsed.facts.availableFrom?.value).toBe("2026-11-01");
  });

  it("takes the Ad ID's category over the Offer's, and the Offer's when the Ad ID has none", () => {
    const deps = storing(offerHtml());
    const categoryOf = (category: "flat" | null) => {
      const read = readStoredPage(deps, { ...ad, category }, "flatshare-room");
      return read.state === "readable" ? read.parsed.category : undefined;
    };
    expect(categoryOf("flat")).toBe("flat");
    expect(categoryOf(null)).toBe("flatshare-room");
  });

  it("tells a page gone from the data folder from one the rules can't read", () => {
    expect(readStoredPage(storing(), ad)).toEqual({ state: "missing" });
    const html = "<html><body><p>Wartung</p></body></html>";
    expect(readStoredPage(storing(html), ad)).toEqual({ state: "unreadable", html });
  });

  it("hands a deleted page on with what the rules made of it", () => {
    const read = readStoredPage(storing(adapterFixture("deleted")), ad);
    expect(read).toMatchObject({ state: "deleted", parsed: { status: "deleted" } });
  });
});
