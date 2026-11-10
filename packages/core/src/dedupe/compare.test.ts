import { describe, expect, it } from "vitest";
import {
  COMMON_PHOTO_OFFERS,
  commonPhotos,
  compareAds,
  DIFFERENT_TEXT,
  type Relation,
  SIMILAR_TEXT,
} from "./compare.js";
import { type AdProfile, photoKeyOf } from "./profile.js";
import { textSignature } from "./text.js";

const hash = (n: number) => String(n).padStart(64, "0");
const photo = (n: number) => `img 20261101 ${String(n).padStart(6, "0")}`;
const uploaded = (...photos: [number, string][]) =>
  photos.flatMap(([n, name]) => {
    const key = photoKeyOf(`https://img.example.test/media/up/2026/45/${hash(n)}_${name}`);
    return key === null ? [] : [key];
  });

const ROOM_TEXT =
  "Das Zimmer ist hell und möbliert, es hat einen großen Balkon zur Südseite und einen Parkettboden. " +
  "Die Küche teilen wir uns mit zwei Mitbewohnern, die Waschmaschine steht im Bad. " +
  "Fahrräder können im Keller abgestellt werden und das Internet ist im Preis enthalten.";
const ROOM_TEXT_EDITED = ROOM_TEXT.replace("hell und", "freundlich und").replace(
  "Internet ist im Preis enthalten",
  "Internet ist inklusive",
);
const OTHER_ROOM_TEXT =
  "Dieses Zimmer geht zum Hinterhof und ist deshalb sehr ruhig, es ist leer und hat einen Einbauschrank. " +
  "Ideal für alle, die früh aufstehen und abends gern ihre Ruhe haben, weil der Schreibtisch direkt am Fenster steht. " +
  "Ein Schlüssel für den Fahrradraum liegt bei der Übergabe bereit.";
const HALF_ALIKE_TEXT = `${ROOM_TEXT.split(" ").slice(0, 30).join(" ")} ${OTHER_ROOM_TEXT.split(" ").slice(20).join(" ")}`;
const TEMPLATE_TEXT =
  "Moderner Co-Living-Space mit allem Komfort für Berufstätige und Studierende: voll möblierte Zimmer, " +
  "Gemeinschaftsküche, Wäscheservice, wöchentliche Reinigung der Gemeinschaftsflächen und schnelles WLAN. " +
  "Die Miete enthält alle Nebenkosten, Strom und Internet; die Buchung ist flexibel ab einem Monat möglich.";

const anna = {
  name: "anna",
  avatar: null,
  memberSince: "2026-03",
  companyProfile: null,
  company: false,
};
const company = {
  name: "coliving gmbh",
  avatar: hash(900),
  memberSince: "2024-01",
  companyProfile: "/profile/company/coliving.7.html",
  company: true,
};

function ad(change: Partial<AdProfile> = {}): AdProfile {
  return {
    category: "flatshare-room",
    postalCode: "12345",
    street: "teststr12",
    flatSize: 80,
    roomSize: 18,
    flatshareSize: 6,
    flatmates: "1w2m0d0n",
    advertiser: anna,
    images: [photo(1), photo(2), photo(3)],
    text: textSignature(ROOM_TEXT),
    ...change,
  };
}

const relationOf = (a: AdProfile, b: AdProfile): Relation => compareAds(a, b).relation;

describe("telling two Ad IDs of the same Source, category and PLZ apart", () => {
  const cases: [string, AdProfile, AdProfile, Relation][] = [
    [
      "a re-post with a changed price and the same photos is a Duplicate",
      ad(),
      ad({ text: textSignature(ROOM_TEXT_EDITED) }),
      "duplicate",
    ],
    [
      "a re-post with new photos but near-identical text is a Duplicate",
      ad(),
      ad({ images: [photo(7)] }),
      "duplicate",
    ],
    [
      "a re-post with a slightly different room size is a Duplicate",
      ad(),
      ad({ roomSize: 17.5, images: [photo(1)], text: textSignature(OTHER_ROOM_TEXT) }),
      "duplicate",
    ],
    [
      "a re-post with rewritten text but the same photos is a Duplicate",
      ad(),
      ad({ text: textSignature(OTHER_ROOM_TEXT) }),
      "duplicate",
    ],
    [
      "a different room size in the same flat is a Sibling, photos shared or not",
      ad(),
      ad({ roomSize: 12, images: [photo(1), photo(2)] }),
      "sibling",
    ],
    [
      "a different room size is a Sibling even when the text is the same",
      ad(),
      ad({ roomSize: 25, images: [photo(40)] }),
      "sibling",
    ],
    [
      "a room of the same size with clearly different text and photos is a Sibling",
      ad(),
      ad({ images: [photo(40), photo(41)], text: textSignature(OTHER_ROOM_TEXT) }),
      "sibling",
    ],
    [
      "the same photos from a different Advertiser are a Cloned offer, not merged",
      ad(),
      ad({ advertiser: { ...anna, name: "marek", memberSince: "2026-11" } }),
      "cloned",
    ],
    [
      "near-identical text from a different Advertiser is a Cloned offer",
      ad(),
      ad({ advertiser: { ...anna, name: "marek" }, images: [photo(50)], flatSize: 45 }),
      "cloned",
    ],
    [
      "a different Advertiser's room with its own text and photos is unrelated",
      ad(),
      ad({
        advertiser: { ...anna, name: "marek" },
        images: [photo(50)],
        text: textSignature(OTHER_ROOM_TEXT),
      }),
      "apart",
    ],
    [
      "co-living template text without a shared photo stays apart from a company's other room",
      ad({ advertiser: company, images: [photo(60)], text: textSignature(TEMPLATE_TEXT) }),
      ad({ advertiser: company, images: [photo(61)], text: textSignature(TEMPLATE_TEXT) }),
      "sibling",
    ],
    [
      "a company's re-post with a shared photo is a Duplicate",
      ad({
        advertiser: company,
        images: [photo(60), photo(62)],
        text: textSignature(TEMPLATE_TEXT),
      }),
      ad({ advertiser: company, images: [photo(62)], text: textSignature(TEMPLATE_TEXT) }),
      "duplicate",
    ],
    [
      "a borderline pair (similar size, text half alike, no shared photo) stays apart",
      ad(),
      ad({ images: [photo(70)], text: textSignature(HALF_ALIKE_TEXT) }),
      "apart",
    ],
    [
      "rent never splits a pair: the profile has none, so a changed price changes nothing",
      ad(),
      ad(),
      "duplicate",
    ],
    [
      "a room size one side does not state cannot be a Duplicate",
      ad(),
      ad({ roomSize: null }),
      "apart",
    ],
    ["another flat size is another flat", ad(), ad({ flatSize: 64 }), "apart"],
    ["other flatmates are another flat", ad(), ad({ flatmates: "2w2m0d0n" }), "apart"],
    ["another flatshare size is another flat", ad(), ad({ flatshareSize: 4 }), "apart"],
    ["another street is another flat", ad(), ad({ street: "bahnhofstr3" }), "apart"],
    [
      "a street only one side gives is not enough to call it the same flat",
      ad(),
      ad({ street: null }),
      "apart",
    ],
    ["another PLZ is never a pair", ad(), ad({ postalCode: "54321" }), "apart"],
    ["an unknown PLZ is never a pair", ad({ postalCode: null }), ad({ postalCode: null }), "apart"],
    ["another category is never a pair", ad(), ad({ category: "flat" }), "apart"],
    [
      "a short text says nothing: without photos in common the pair stays apart",
      ad({ text: null }),
      ad({ text: null, images: [photo(80)] }),
      "apart",
    ],
  ];

  it.each(cases)("%s", (_name, a, b, expected) => {
    expect(relationOf(a, b)).toBe(expected);
    expect(relationOf(b, a)).toBe(expected);
  });
});

describe("the thresholds", () => {
  it("leave the borderline pair between clearly different and very similar", () => {
    const { textSimilarity } = compareAds(ad(), ad({ text: textSignature(HALF_ALIKE_TEXT) }));
    expect(textSimilarity).toBeGreaterThan(DIFFERENT_TEXT);
    expect(textSimilarity).toBeLessThan(SIMILAR_TEXT);
  });
});

describe("the Advertiser fingerprint", () => {
  it("counts two Advertisers who show nothing to tell them apart as the same", () => {
    const hidden = {
      name: null,
      avatar: null,
      memberSince: null,
      companyProfile: null,
      company: false,
    };
    expect(relationOf(ad({ advertiser: hidden }), ad({ advertiser: hidden }))).toBe("duplicate");
  });

  it.each([
    ["name", { name: "marek" }],
    ["avatar", { avatar: hash(300) }],
    ["member-since month", { memberSince: "2025-01" }],
    ["company profile", { companyProfile: "/profile/company/other.9.html", company: true }],
  ])("tells a different %s apart", (_field, change) => {
    expect(relationOf(ad(), ad({ advertiser: { ...anna, ...change } }))).toBe("cloned");
  });

  it("tells an Advertiser who shows a field from one who does not", () => {
    expect(relationOf(ad(), ad({ advertiser: { ...anna, avatar: hash(300) } }))).toBe("cloned");
  });
});

describe("what a pair shares", () => {
  it("reports the shared photos and the text similarity as the evidence", () => {
    const comparison = compareAds(ad(), ad({ images: [photo(2), photo(3), photo(9)] }));
    expect(comparison.sharedImages).toBe(2);
    expect(comparison.textSimilarity).toBe(1);
    expect(compareAds(ad(), ad({ text: null })).textSimilarity).toBeNull();
  });

  it("counts a photo the stoplist names as no photo at all", () => {
    const comparison = compareAds(ad(), ad(), new Set([photo(1)]));
    expect(comparison.sharedImages).toBe(2);
  });
});

describe("photos uploaded again", () => {
  const roomPhotos = (offset: number) =>
    uploaded(
      [offset + 1, "IMG_20260914_101112.large.jpg"],
      [offset + 2, "WhatsApp_Image_2026_09_16_at_08.15.42.large.jpeg"],
      [offset + 3, "PXL_20260915_120102030.large.jpg"],
    );
  const companyRoom = (images: string[]) =>
    ad({ advertiser: company, images, text: textSignature(TEMPLATE_TEXT) });

  it("still match by their original names under new hashes", () => {
    expect(roomPhotos(0)).toHaveLength(3);
    expect(roomPhotos(0)).toEqual(roomPhotos(100));
  });

  it("make a company's re-post of a room a Duplicate", () => {
    expect(relationOf(companyRoom(roomPhotos(0)), companyRoom(roomPhotos(100)))).toBe("duplicate");
  });

  it("make another Advertiser showing two of them a Cloned offer", () => {
    const copy = ad({
      advertiser: { ...anna, name: "marek" },
      images: roomPhotos(100).slice(0, 2),
      text: textSignature(OTHER_ROOM_TEXT),
    });
    expect(relationOf(ad({ images: roomPhotos(0) }), copy)).toBe("cloned");
  });
});

describe("how many photos a pair must share", () => {
  const marek = { ...anna, name: "marek" };
  const other = textSignature(OTHER_ROOM_TEXT);

  it("is two when both Ad IDs show more than one photo", () => {
    const copy = ad({ advertiser: marek, images: [photo(1), photo(50)], text: other });
    expect(compareAds(ad(), copy)).toMatchObject({ relation: "apart", sharedImages: 1 });
    const room = (images: string[]) =>
      ad({ advertiser: company, images, text: textSignature(TEMPLATE_TEXT) });
    expect(relationOf(room([photo(1), photo(2)]), room([photo(1), photo(3)]))).toBe("sibling");
  });

  it("is one when either Ad ID shows only one photo with a key", () => {
    const copy = ad({ advertiser: marek, images: [photo(1)], text: other });
    expect(relationOf(ad(), copy)).toBe("cloned");
  });

  it("leaves one shared photo out of several as no evidence either way", () => {
    const room = ad({ images: [photo(1), photo(40)], text: other });
    expect(relationOf(ad(), room)).toBe("apart");
  });
});

describe("photos with generic names", () => {
  const generic = uploaded([1, "image.large.jpg"], [2, "1.large.jpg"]);
  const otherRoom = (images: string[]) => ad({ images, text: textSignature(OTHER_ROOM_TEXT) });

  it("have no key", () => {
    expect(generic).toEqual([]);
  });

  it("are not shared photos: another Advertiser showing them is not a Cloned offer", () => {
    const copy = ad({
      advertiser: { ...anna, name: "marek" },
      images: generic,
      text: textSignature(OTHER_ROOM_TEXT),
    });
    expect(relationOf(ad({ images: generic }), copy)).toBe("apart");
  });

  it("are not different photos: clearly different text alone does not make a Sibling", () => {
    expect(relationOf(ad({ images: generic }), otherRoom(generic))).toBe("apart");
    expect(relationOf(ad(), otherRoom(generic))).toBe("apart");
    expect(relationOf(ad(), otherRoom([photo(40)]))).toBe("sibling");
  });
});

describe("a photo name many unrelated Offers show", () => {
  it("is ignored once the caller names it common", () => {
    const stock = [photo(1), photo(2)];
    const copy = ad({
      advertiser: { ...anna, name: "marek" },
      images: stock,
      text: textSignature(OTHER_ROOM_TEXT),
    });
    expect(relationOf(ad({ images: stock }), copy)).toBe("cloned");
    expect(compareAds(ad({ images: stock }), copy, new Set(stock))).toMatchObject({
      relation: "apart",
      sharedImages: 0,
    });
  });
});

describe("which photo names are common", () => {
  const index = new Map([
    [photo(1), new Set([1, 2])],
    [photo(2), new Set([1, 3])],
    [photo(3), new Set([1, 3, 4])],
    [photo(4), new Set([3, 4, 5])],
  ]);
  const keys = [photo(1), photo(2), photo(3), photo(4), photo(9)];

  it("are the names Ad IDs of several Offers other than the two compared show", () => {
    expect(COMMON_PHOTO_OFFERS).toBe(2);
    expect(commonPhotos(keys, index, [1, 2])).toEqual(new Set([photo(3), photo(4)]));
  });

  it("do not count the Offers of the pair itself, so a room's own re-posts stay evidence", () => {
    expect(commonPhotos([photo(3)], index, [3, 4])).toEqual(new Set());
    expect(commonPhotos([photo(3)], index, [3, undefined])).toEqual(new Set([photo(3)]));
  });
});
