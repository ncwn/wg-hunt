import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Invented search pages in the shape the adapter reads (see the adapter's own fixtures), built
 * from a list of cards so a test can say which Ad IDs a page holds and how old each one is.
 */

export type CardSpec = {
  id: number;
  /** The card's "Online" text. */
  age?: string;
  /** A Promoted placement: `campaign_click`. */
  promoted?: boolean;
  title?: string;
  /** The card's price text. */
  price?: string;
  /** What the price is for: "pro Monat" or "pro Nacht". */
  per?: string;
};

const card = ({
  id,
  age = "5 Min.",
  promoted = false,
  title = `Zimmer ${id}`,
  price = "500 €",
  per = "pro Monat",
}: CardSpec) =>
  `<a class="wgg-list-card offer_list_item${promoted ? " campaign_click" : ""}" id="liste-details-ad-${id}" data-id="${id}" href="/wg-zimmer-in-Teststadt-Mitte.${id}.html" aria-label="${title}">
  <span class="card-title-text">${title}</span>
  <div class="price-row"><span class="card-main-text">${price}</span><span class="card-subtitle">${per}</span></div>
  <div class="user-row"><span class="user-name">Anna</span><span class="user-badge">Privat</span></div>
  <div class="online-row"><span class="online-since-icon">update</span><span class="card-subtitle">${age}</span></div>
</a>`;

export const resultsPage = (cards: CardSpec[]) =>
  `<!DOCTYPE html><html lang="de"><head><title>WG-Zimmer in Berlin</title></head><body>
<form id="offer_filter_form"></form><h2 class="mb10">${cards.length} WG-Zimmer</h2>
${cards.map(card).join("\n")}
</body></html>`;

/**
 * Any of the adapter's own Offer-page fixtures by name: `flatshare`, `flat`, `deactivated`,
 * `deleted`, ... The path comes from a string, not a URL object, so it also works under jsdom.
 */
export const adapterFixture = (name: string) =>
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../packages/core/src/sources/wg-gesucht/fixtures",
      `${name}.html`,
    ),
    "utf8",
  );

/** A real-shaped Offer page (the adapter's own flatshare fixture). */
export const offerHtml = () => adapterFixture("flatshare");

/** A real-shaped page of a flat (the adapter's own fixture). */
export const flatHtml = () => adapterFixture("flat");

/** The flatshare Offer page with its own title and warm rent, so a test can tell Offers apart. */
export const offerPageWith = ({ title, warmRent }: { title: string; warmRent: number }) =>
  offerHtml()
    .replaceAll("Helles Zimmer in ruhiger Studenten-WG", title)
    .replace("489€", `${warmRent}€`);

/**
 * The page with photos of its own. Every page built from the adapter's fixture shows the same
 * three photos, under names too generic to be photo keys; a crawl test that wants separate Offers
 * gives each Ad ID photos of its own, with distinctive names no other Ad ID shows.
 */
export const withOwnPhotos = (html: string, adId: number) =>
  [1, 2, 3].reduce(
    (page, n) =>
      page.replaceAll(
        `bbbb${"0".repeat(59)}${n}_zimmer-${n}`,
        `${String(900_000_000 + (adId % 1_000_000) * 10 + n).padStart(64, "0")}_IMG_${adId}_${n}`,
      ),
    html,
  );
