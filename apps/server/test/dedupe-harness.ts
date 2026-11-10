import type { Category } from "@wg-hunt/core";
import { wgGesuchtSource } from "@wg-hunt/core/sources/wg-gesucht";
import type { FetchedOffer } from "../src/crawl/search-polls.js";
import { offerHtml } from "./fixtures/search-pages.js";
import { type bootOffers, MINUTE } from "./offers-harness.js";

export const hash = (n: number) => String(n).padStart(64, "0");
/** Distinctive enough to be a photo key. */
export const photo = (n: number) => `IMG_20261101_${String(n).padStart(6, "0")}`;

export const ROOM_TEXT =
  "Das Zimmer ist hell und möbliert, es hat einen großen Balkon zur Südseite und einen Parkettboden. " +
  "Die Küche teilen wir uns mit zwei Mitbewohnern, die Waschmaschine steht im Bad. " +
  "Fahrräder können im Keller abgestellt werden und das Internet ist im Preis enthalten.";
export const ROOM_TEXT_EDITED = ROOM_TEXT.replace("hell und", "freundlich und");
export const OTHER_ROOM_TEXT =
  "Dieses Zimmer geht zum Hinterhof und ist deshalb sehr ruhig, es ist leer und hat einen Einbauschrank. " +
  "Ideal für alle, die früh aufstehen und abends gern ihre Ruhe haben, weil der Schreibtisch direkt am Fenster steht. " +
  "Ein Schlüssel für den Fahrradraum liegt bei der Übergabe bereit.";
/** Neither alike nor clearly different. */
export const HALF_ALIKE_TEXT = `${ROOM_TEXT.split(" ").slice(0, 30).join(" ")} ${OTHER_ROOM_TEXT.split(" ").slice(20).join(" ")}`;
export const TEMPLATE_TEXT =
  "Moderner Co-Living-Space mit allem Komfort für Berufstätige und Studierende: voll möblierte Zimmer, " +
  "Gemeinschaftsküche, Wäscheservice, wöchentliche Reinigung der Gemeinschaftsflächen und schnelles WLAN. " +
  "Die Miete enthält alle Nebenkosten, Strom und Internet; die Buchung ist flexibel ab einem Monat möglich.";

export type AdSpec = {
  adId: number;
  title?: string;
  warmRent?: number;
  /** Square metres. */
  roomSize?: number;
  flatSize?: number;
  street?: string;
  /** The Zimmer free text. */
  text?: string;
  /**
   * The original file names of the photos, without extension. Each Ad ID uploads its photos
   * afresh, so the same name never comes with the same hash twice, as on the live site.
   */
  images?: string[];
  advertiser?: {
    name: string;
    avatar?: string;
    /** `"Mai 2020"`: how the page writes "Mitglied seit". */
    memberSince?: string;
    company?: boolean;
    /** Whether the page shows the Verifiziert badge. The fixture does by default. */
    verified?: boolean;
  };
  minutesOld?: number;
  /** What the page shows after "frei ab:", such as `"sofort"`. */
  availableFrom?: string;
};

const ANNA: NonNullable<AdSpec["advertiser"]> = {
  name: "Anna",
  memberSince: "Oktober 2026",
};

export function adPage(spec: AdSpec): string {
  const advertiser = spec.advertiser ?? ANNA;
  let html = offerHtml()
    .replaceAll("Helles Zimmer in ruhiger Studenten-WG", spec.title ?? `Zimmer ${spec.adId}`)
    .replace("489€", `${spec.warmRent ?? 489}€`)
    .replace("01.12.2026", spec.availableFrom ?? "01.12.2026")
    .replaceAll("18m²", `${spec.roomSize ?? 18}m²`)
    .replace("Wohnungsgröße: 80m²", `Wohnungsgröße: ${spec.flatSize ?? 80}m²`)
    .replaceAll("Teststraße 12", spec.street ?? "Teststraße 12")
    .replace(
      "Das Zimmer ist hell und möbliert.<br />\nAnmeldung ist möglich.",
      spec.text ?? ROOM_TEXT,
    )
    .replace(
      /Mitglied seit (Oktober 2026|Mai 2020)/g,
      `Mitglied seit ${advertiser.memberSince ?? "Oktober 2026"}`,
    );
  if (advertiser.verified === false) {
    html = html.replace(
      '<a href="/fuer-immobilienprofis.html" data-campaign_type="wggpro_promotion">Verifiziert</a>',
      "",
    );
  }
  // The fixture shows three photos; those the spec does not name are this Ad ID's own.
  const images = spec.images ?? [photo(1), photo(2), photo(3)];
  for (const index of [0, 1, 2]) {
    const name = images[index] ?? `IMG_${spec.adId}_${index}`;
    html = html.replaceAll(
      `bbbb${"0".repeat(59)}${index + 1}_zimmer-${index + 1}`,
      `${hash(spec.adId * 10 + index)}_${name}`,
    );
  }
  if (!("company" in advertiser) || advertiser.company !== true) {
    html = html.replace(
      '<a href="/profile/company/beispiel-verwaltung.55.html">Zum Profil</a>',
      "",
    );
  }
  return html;
}

type Harness = ReturnType<typeof bootOffers>;

export type FetchedAd = FetchedOffer & { category: Category; html: string };

/** `after`: ms from now. */
export function fetchedAd(h: Harness, spec: AdSpec, after = 0): FetchedAd {
  const html = adPage(spec);
  const parsed = wgGesuchtSource.parseOffer(html, {
    firstSeen: new Date(h.clock.now),
    category: "flatshare-room",
  });
  if (parsed.outcome !== "parsed" || parsed.status === "deleted") throw new Error("unreadable");
  const advertiser = spec.advertiser ?? ANNA;
  return {
    source: "wg-gesucht",
    adId: String(spec.adId),
    category: "flatshare-room",
    fetchedAt: h.clock.now + after,
    card: {
      adId: String(spec.adId),
      path: `/wg-zimmer-in-Teststadt-Mitte.${spec.adId}.html`,
      title: spec.title ?? `Zimmer ${spec.adId}`,
      advertiser: {
        name: advertiser.name,
        ...("avatar" in advertiser &&
          advertiser.avatar !== undefined && { avatarUrl: advertiser.avatar }),
        kind: "company" in advertiser && advertiser.company === true ? "company" : "private",
      },
    },
    html,
    parsed,
  };
}

export function ingestAds(h: Harness, ...specs: AdSpec[]) {
  return specs.map((spec, index) =>
    h.runtime.offers.ingest(fetchedAd(h, spec, index * 10 * MINUTE)),
  );
}
