import { describe, expect, it } from "vitest";
import type { RuleFacts } from "../offer-facts/index.js";
import type { SearchCard } from "../source/source.js";
import { photoKeyOf, profileOf } from "./profile.js";

const HASH_A = `${"a".repeat(63)}1`;
const HASH_B = `${"b".repeat(63)}2`;
const upload = (hash: string, name: string) =>
  `https://img.example.test/media/up/2026/45/${hash}_${name}`;
const cdn = (hash: string, variant = "large") => upload(hash, `IMG_20261101_120000.${variant}.jpg`);

const stated = <V>(value: V) => ({ value, origin: "field" as const, quote: "q" });
const unknown = { value: "unknown" as const, origin: "field" as const, quote: "" };

const CARD: SearchCard = {
  adId: "1",
  path: "/x.1.html",
  title: "Zimmer",
  advertiser: { name: "  Anna ", avatarUrl: cdn(HASH_B, "thumb"), kind: "private" },
};

const FACTS: RuleFacts = {
  postalCode: stated("12345"),
  street: stated("Teststraße 12"),
  flatSize: stated(80),
  roomSize: stated(18),
  flatshareSize: stated(6),
  flatmates: stated({ women: 1, men: 2, diverse: 0, unspecified: 0 }),
  memberSince: stated("2026-10"),
  companyProfile: unknown,
  imageUrls: stated([cdn(HASH_A), cdn(HASH_A, "sized"), "https://elsewhere.test/pic.jpg"]),
};

const TEXT = {
  title: "Zimmer",
  sections: [
    {
      label: "Zimmer",
      text: "Das Zimmer ist hell und möbliert, es hat einen großen Balkon zur Südseite und Parkett.",
    },
  ],
};

describe("a photo key", () => {
  it("is the original file name after the upload's hash, the same for each size variant", () => {
    const key = "img 20261101 120000";
    expect(photoKeyOf(cdn(HASH_A, "large"))).toBe(key);
    expect(photoKeyOf(cdn(HASH_A, "sized"))).toBe(key);
    expect(photoKeyOf(`${cdn(HASH_A, "small")}?v=2`)).toBe(key);
  });

  it("is the same when the photo is uploaded again under a new hash", () => {
    const name = "WhatsApp_Image_2026_09_16_at_08.15.42.large.jpeg";
    expect(photoKeyOf(upload(HASH_A, name))).toBe(photoKeyOf(upload(HASH_B, name)));
    expect(photoKeyOf(upload(HASH_A, name))).toBe("whatsapp image 2026 09 16 at 08 15 42");
  });

  it("drops a size suffix the name repeats, and the extension whatever its case", () => {
    expect(photoKeyOf(upload(HASH_A, "Wohnung_2025_005.large.large.png"))).toBe("wohnung 2025 005");
    expect(photoKeyOf(upload(HASH_A, "IMG_20260914_101112.large.JPG"))).toBe("img 20260914 101112");
  });

  it.each([
    "image.large.jpg",
    "1.large.jpg",
    "foto.large.jpg",
    "unnamed.large.png",
    "WhatsApp_Image.large.jpeg",
    "Gemuetliches_Zimmer_mit_Morgensonne.large.png",
    "IMG_2044.large.jpg",
    "Kueche2.large.jpg",
  ])("is absent for a generic name that many photos could carry: %s", (name) => {
    expect(photoKeyOf(upload(HASH_A, name))).toBeNull();
  });

  it("is absent from an address that carries no upload hash", () => {
    expect(
      photoKeyOf("https://img.example.test/media/up/2026/45/a1_IMG_20261101_120000.small.jpg"),
    ).toBeNull();
    expect(photoKeyOf("https://elsewhere.test/IMG_20261101_120000.jpg")).toBeNull();
  });
});

describe("an Ad ID's profile", () => {
  const profile = profileOf({ category: "flatshare-room", facts: FACTS, card: CARD, text: TEXT });

  it("keeps the flat's identity and the room size", () => {
    expect(profile).toMatchObject({
      category: "flatshare-room",
      postalCode: "12345",
      street: "teststr12",
      flatSize: 80,
      roomSize: 18,
      flatshareSize: 6,
      flatmates: "1w2m0d0n",
    });
  });

  it("lists each photo's key once, and none for a photo without one", () => {
    expect(profile.images).toEqual(["img 20261101 120000"]);
  });

  it("fingerprints the Advertiser by card name and avatar, member-since month and company profile", () => {
    expect(profile.advertiser).toEqual({
      name: "anna",
      avatar: HASH_B,
      memberSince: "2026-10",
      companyProfile: null,
      company: false,
    });
  });

  it("calls an Advertiser a company by its badge or its company profile", () => {
    const badge = profileOf({
      category: "flatshare-room",
      facts: FACTS,
      card: { ...CARD, advertiser: { name: "Verwaltung", kind: "company" } },
      text: TEXT,
    });
    expect(badge.advertiser.company).toBe(true);
    const linked = profileOf({
      category: "flatshare-room",
      facts: { ...FACTS, companyProfile: stated("/profile/company/x.1.html") },
      card: CARD,
      text: TEXT,
    });
    expect(linked.advertiser).toMatchObject({
      company: true,
      companyProfile: "/profile/company/x.1.html",
    });
  });

  it("records what the page does not say as null, never as a value", () => {
    const bare = profileOf({
      category: "flatshare-room",
      facts: { postalCode: stated("12345") },
      card: { adId: "2", path: "/y", title: "t", advertiser: {} },
      text: { title: "", sections: [] },
    });
    expect(bare).toEqual({
      category: "flatshare-room",
      postalCode: "12345",
      street: null,
      flatSize: null,
      roomSize: null,
      flatshareSize: null,
      flatmates: null,
      advertiser: {
        name: null,
        avatar: null,
        memberSince: null,
        companyProfile: null,
        company: false,
      },
      images: [],
      text: null,
    });
  });

  it("reads zero flatmates as not stated", () => {
    const none = profileOf({
      category: "flatshare-room",
      facts: { flatmates: stated({ women: 0, men: 0, diverse: 0, unspecified: 0 }) },
      card: CARD,
      text: TEXT,
    });
    expect(none.flatmates).toBeNull();
  });

  it("compares the first free-text section, which describes the room", () => {
    const two = profileOf({
      category: "flatshare-room",
      facts: FACTS,
      card: CARD,
      text: {
        title: "t",
        sections: [
          { label: "Zimmer", text: "kurz" },
          { label: "Lage", text: TEXT.sections[0]?.text ?? "" },
        ],
      },
    });
    expect(two.text).toBeNull();
    expect(profile.text).not.toBeNull();
  });
});
