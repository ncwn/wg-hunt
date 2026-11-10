import { describe, expect, it } from "vitest";
import { wgGesuchtSource } from "./index.js";
import { fixture } from "./testing.js";

function results(name: string) {
  const result = wgGesuchtSource.parseSearchPage(fixture(name));
  if (result.outcome !== "results") throw new Error(`${name}: ${result.reason}`);
  return result;
}

describe("search page: card-only fields", () => {
  const [private1, pro, company, old] = results("search-page").cards;

  it("keeps the Advertiser's display name, avatar and Private / PRO / Company badge", () => {
    expect(private1?.advertiser).toEqual({
      name: "Anna",
      avatarUrl: "https://img.example.test/media/up/2026/40/b1_anna.thumb.jpg",
      kind: "private",
    });
    expect(pro?.advertiser).toEqual({ name: "Max K.", kind: "pro" });
    expect(company?.advertiser).toMatchObject({
      name: "Beispiel Immobilien GmbH",
      kind: "company",
    });
    expect(old?.advertiser).toEqual({ name: "Lea", kind: "private" });
  });

  it("keeps title, rent, size and the Offer page path", () => {
    expect(private1).toMatchObject({
      title: "Helles Zimmer am Park",
      rent: { amount: 489, unit: "month" },
      size: 18,
      path: "/wg-zimmer-in-Teststadt-Testviertel.9000001.html",
    });
    expect(pro).toMatchObject({ rent: { amount: 1020, unit: "month" }, size: 14.5 });
    expect(company).toMatchObject({ rent: { amount: 70, unit: "night" }, size: 35 });
    expect(old).not.toHaveProperty("size");
  });

  it("keeps the 'Online' age with the unit it was shown in", () => {
    expect(private1?.online).toEqual({ age: { kind: "relative", minutes: 15 }, unitMinutes: 1 });
    expect(pro?.online).toEqual({ age: { kind: "relative", minutes: 480 }, unitMinutes: 60 });
    expect(company?.online).toEqual({
      age: { kind: "relative", minutes: 3 * 1440 },
      unitMinutes: 1440,
    });
    expect(old?.online).toEqual({ age: { kind: "date", date: "2026-10-29" }, unitMinutes: 1440 });
  });

  it("never keeps the street from the card's details line", () => {
    expect(JSON.stringify(private1)).not.toContain("Beispielweg");
  });
});

describe("search page: which pages are results", () => {
  it("reads a page past the last one as results with no organic cards: the normal end", () => {
    const end = results("search-page-end");
    expect(end.cards).toEqual([]);
    expect(end.promoted).toBe(2);
  });

  it("reads a search with no hits and no placements as an empty list of results", () => {
    const empty = wgGesuchtSource.parseSearchPage(
      `<html><body><form id="offer_filter_form"></form><h2 class="mb10">0 WG-Zimmer</h2></body></html>`,
    );
    expect(empty).toEqual({ outcome: "results", cards: [], promoted: 0 });
  });

  it("calls a page with no filter form and no cards unexpected", () => {
    const result = wgGesuchtSource.parseSearchPage(fixture("search-page-not-results"));
    expect(result.outcome).toBe("unexpected");
  });

  it("calls an Offer page unexpected: it is not a page of results", () => {
    expect(wgGesuchtSource.parseSearchPage(fixture("flatshare")).outcome).toBe("unexpected");
  });

  it("calls an empty body unexpected", () => {
    expect(wgGesuchtSource.parseSearchPage("").outcome).toBe("unexpected");
  });
});

describe("search page: Promoted placements", () => {
  const page = results("search-page");

  it("keeps only the organic cards, in page order", () => {
    expect(page.cards.map((card) => card.adId)).toEqual([
      "9000001",
      "9000002",
      "9000003",
      "9000004",
    ]);
  });

  it("counts the Promoted placements it skipped: sticky, verified providers and nothing else", () => {
    // The sticky "Sofortbuchung" card and the two cards of the "verified providers" list. The
    // partner ad and the Plus teaser are not Offers at all.
    expect(page.promoted).toBe(3);
  });

  it("lists an Ad ID once when drift repeats it on the same page", () => {
    expect(page.cards.filter((card) => card.adId === "9000001")).toHaveLength(1);
    expect(page.cards[0]?.online?.age).toEqual({ kind: "relative", minutes: 15 });
  });
});
