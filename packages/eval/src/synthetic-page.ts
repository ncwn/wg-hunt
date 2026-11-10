/**
 * Renders an Offer page in the Source's markup from invented content, so no real Offer text, name,
 * address, phone number or photo is ever in a page.
 */

export type PageSpec = {
  adId: string;
  title: string;
  category: "flatshare-room" | "one-room-flat" | "flat";
  /** 0 unlimited, 1 limited, 2 overnight. */
  rentType?: 0 | 1 | 2;
  /** Flatshare rooms: the flatmate code, such as `1w,2m,0d,0n`, and the size of the flatshare. */
  flatmates?: { code: string; size: number };
  roomSize?: number;
  flatSize?: number;
  totalRent?: { label?: string; euros: number };
  /** Cost rows, label then value as the page writes it (`375€`, `n.a.`). */
  costs?: [string, string][];
  street?: string;
  postalCode?: string;
  district?: string;
  /** `frei ab` and `frei bis`, as dates the page shows (`01.12.2026`) or `sofort`. */
  from?: string;
  until?: string;
  online?: string;
  /** A newline becomes a line break. */
  sections: [string, string][];
  /** WG-Details lines under "Die WG:" and the line under "Gesucht wird:". */
  wgDetails?: { lines: string[]; sought?: string };
  advertiser?: { since: string; name?: string; verified?: boolean; company?: boolean };
  /**
   * The photos: each one's upload digest (padded to 64 hex characters) and the original file name
   * it was uploaded under, without extension. A bare digest is uploaded as `bild-<n>`, a name too
   * generic to be a photo key. A re-post uploads its photos again: new digests, the same names.
   */
  images?: (string | { digest: string; name: string })[];
  documents?: string[];
};

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const lines = (text: string) => escapeHtml(text).replaceAll("\n", "<br />\n");

const hash = (n: string) => n.padEnd(64, "0").slice(0, 64);

export function renderPage(spec: PageSpec): string {
  const { category } = spec;
  const room = category === "flatshare-room";
  const keyFacts: string[] = [];
  if (room) {
    if (spec.roomSize !== undefined) keyFacts.push(["Zimmergröße", `${spec.roomSize}m²`].join("|"));
  } else if (spec.roomSize !== undefined) {
    keyFacts.push(`Größe|${spec.roomSize}m²`);
  }
  if (spec.totalRent) {
    keyFacts.push(`${spec.totalRent.label ?? "Gesamtmiete"}|${spec.totalRent.euros}€`);
  }
  const keyFactHtml = keyFacts
    .map((entry) => {
      const [label, value] = entry.split("|");
      return `    <span class="key_fact_detail">${label}</span><b class="key_fact_value">${value}</b>`;
    })
    .join("\n");

  const costRows = (spec.costs ?? [])
    .map(
      ([label, value]) =>
        `    <span class="section_panel_detail">${label}:</span><span class="section_panel_value">${value}</span>`,
    )
    .join("\n");

  const address = [
    spec.street ? `    <span class="section_panel_detail">${escapeHtml(spec.street)}</span>` : "",
    `    <span class="section_panel_detail">${spec.postalCode ?? "12345"} Teststadt ${escapeHtml(spec.district ?? "Testviertel")}</span>`,
  ]
    .filter((line) => line !== "")
    .join("\n");

  const availability = [
    spec.from
      ? `    <span class="section_panel_detail">frei ab:</span><span class="section_panel_value">${spec.from}</span>`
      : "",
    spec.until
      ? `    <span class="section_panel_detail">frei bis:</span><span class="section_panel_value">${spec.until}</span>`
      : "",
    `    <span class="section_panel_detail"><b class="noprint">Online:</b></span><span class="section_panel_value"><b class="noprint">${spec.online ?? "2 Stunden"}</b></span>`,
  ]
    .filter((line) => line !== "")
    .join("\n");

  const tabs = spec.sections
    .map(
      ([label], i) =>
        `  <div class="section_panel_tab" data-text="#freitext_${i}"><h2>${escapeHtml(label)}</h2></div>`,
    )
    .join("\n");
  const bodies = spec.sections
    .map(
      ([, text], i) =>
        `    <div id="freitext_${i}" class="section_freetext${i === 0 ? "" : " display-none"}">${lines(text)}</div>`,
    )
    .join("\n");

  const flatmates = spec.flatmates
    ? `    <span class="mr5" title="${spec.flatmates.size}er WG (${spec.flatmates.code})"><img src="/img/wgw.gif"></span>\n`
    : "";

  const details = spec.wgDetails
    ? `  <h2>WG-Details</h2>
  <h3 class="headline">Die WG:</h3>
  <ul>
${[
  ...(room && spec.roomSize !== undefined && spec.flatmates
    ? [`${spec.roomSize}m² Zimmer in ${spec.flatmates.size}er WG`]
    : []),
  ...(spec.flatSize !== undefined ? [`Wohnungsgröße: ${spec.flatSize}m²`] : []),
  ...spec.wgDetails.lines,
]
  .map((line) => `    <li><span class="section_panel_detail">${escapeHtml(line)}</span></li>`)
  .join("\n")}
  </ul>${
    spec.wgDetails.sought
      ? `
  <h3 class="headline">Gesucht wird:</h3>
  <ul>
    <li><span class="section_panel_detail">${escapeHtml(spec.wgDetails.sought)}</span></li>
  </ul>`
      : ""
  }`
    : "";

  const advertiser = spec.advertiser
    ? `  <div class="user_profile_info">
${spec.advertiser.name ? `    <p class="text-dark-gray text-bold">${escapeHtml(spec.advertiser.name)}</p>\n` : ""}    <p>Mitglied seit ${spec.advertiser.since}</p>${
        spec.advertiser.verified
          ? `\n    <a href="/fuer-immobilienprofis.html" data-campaign_type="wggpro_promotion">Verifiziert</a>`
          : ""
      }${
        spec.advertiser.company
          ? `\n    <a href="/profile/company/beispiel-verwaltung.55.html">Zum Profil</a>`
          : ""
      }
  </div>`
    : "";

  const documents = spec.documents?.length
    ? `  <h2>Benötigte Unterlagen</h2>
  <p>Der Anbieter hat die folgenden Unterlagen ausgewählt.</p>
${spec.documents
  .map((name) => `  <div class="required-document"><a href="/upsell">${escapeHtml(name)}</a></div>`)
  .join("\n")}`
    : "";

  const images = spec.images?.length
    ? `  <div id="gallery_slides">
${spec.images
  .map((image, i) => {
    const { digest, name } =
      typeof image === "string" ? { digest: image, name: `bild-${i + 1}` } : image;
    return `    <div class="sp-slide"><img class="sp-image" src="img/d.gif" data-large="https://img.wg-gesucht.de/media/up/2026/45/${hash(digest)}_${escapeHtml(name)}.large.jpg" alt="Bild ${i + 1}"></div>`;
  })
  .join("\n")}
  </div>
  <span id="gallery_images_label">${spec.images.length} Fotos</span>`
    : "";

  return `<!DOCTYPE html>
<!-- SYNTHETIC: invented content in the Source's markup. Not a real Offer; every name, address and number here is made up. -->
<html lang="de">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(spec.title)} - Teststadt-${escapeHtml(spec.district ?? "Testviertel")}</title>
  <script>
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({'ad_status': 'active'});
    var ad_id = ${spec.adId};
    googletag.pubads().setTargeting("wgg_rent_type", "${spec.rentType ?? 0}");
    googletag.pubads().setTargeting("wgg_pic", "${spec.images?.length ? 1 : 0}");
  </script>
</head>
<body>
  <div id="basic_ad_details"><span>Anzeigennummer: ${spec.adId}</span></div>

  <h1 class="detailed-view-title">
${flatmates}    <span>${escapeHtml(spec.title)}</span>
  </h1>

  <div class="section_footer_dark">
${keyFactHtml}
  </div>

  <h2>Kosten</h2>
  <div class="section_panel">
${costRows}
  </div>

  <h2>Adresse</h2>
  <a href="#map_container">
${address}
  </a>

  <h2>Verfügbarkeit</h2>
  <div class="section_panel">
${availability}
  </div>

${tabs}
  <div id="ad_description_text">
${bodies}
  </div>

${details}

${documents}

${advertiser}

${images}
</body>
</html>
`;
}
