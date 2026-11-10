import { wgGesuchtSource } from "@wg-hunt/core/sources/wg-gesucht";
import { describe, expect, it } from "vitest";
import { type PageSpec, renderPage } from "./synthetic-page.js";

const room: PageSpec = {
  adId: "9000001",
  title: "Zimmer in Beispiel-WG",
  category: "flatshare-room",
  flatmates: { code: "1w,2m,0d,0n", size: 4 },
  roomSize: 16,
  flatSize: 70,
  totalRent: { euros: 480 },
  costs: [
    ["Miete", "400€"],
    ["Nebenkosten", "80€"],
  ],
  street: "Beispielweg 3",
  postalCode: "54321",
  from: "01.12.2026",
  sections: [["Zimmer", "Hell und ruhig.\nAnmeldung ist möglich."]],
  wgDetails: { lines: ["Rauchen nicht erwünscht"], sought: "Frau ab 25 Jahren" },
  advertiser: { since: "Oktober 2026" },
  images: ["a1", { digest: "a2", name: "IMG_20261020_101504" }],
};

describe("the synthetic page builder", () => {
  const parsed = wgGesuchtSource.parseOffer(renderPage(room), {
    firstSeen: new Date("2026-11-04T09:00:00Z"),
    category: "flatshare-room",
  });

  it("makes a page the adapter reads", () => {
    if (parsed.outcome !== "parsed" || parsed.status === "deleted") throw new Error("not an Offer");
    expect(parsed.adId).toBe("9000001");
    expect(parsed.facts.warmRent?.value).toEqual({ amount: 480, converted: false });
    expect(parsed.facts.roomSize?.value).toBe(16);
    expect(parsed.facts.postalCode?.value).toBe("54321");
    expect(parsed.facts.ageSought?.value).toEqual({ min: 25 });
    expect(parsed.facts.flatmates?.value).toEqual({ women: 1, men: 2, diverse: 0, unspecified: 0 });
    expect(parsed.text.sections).toEqual([
      { label: "Zimmer", text: "Hell und ruhig.\nAnmeldung ist möglich." },
    ]);
  });

  it("uploads each photo under its original name, or a generic one when it has none", () => {
    if (parsed.outcome !== "parsed" || parsed.status === "deleted") throw new Error("not an Offer");
    expect(parsed.facts.imageUrls?.value).toEqual([
      `https://img.wg-gesucht.de/media/up/2026/45/${"a1".padEnd(64, "0")}_bild-1.large.jpg`,
      `https://img.wg-gesucht.de/media/up/2026/45/${"a2".padEnd(64, "0")}_IMG_20261020_101504.large.jpg`,
    ]);
  });

  it("says in the page itself that it is synthetic", () => {
    expect(renderPage(room)).toContain("SYNTHETIC");
  });
});
