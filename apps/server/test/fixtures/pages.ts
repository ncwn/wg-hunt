/**
 * Synthetic stand-ins for the Source's pages. They copy only the shapes the detector cares about,
 * never real page content.
 */

const CHROME = `
<header><nav>Menü</nav></header>
<div class="modal" id="register"><input data-input="captcha" placeholder="Captcha"></div>`;

/** The consentmanager.net banner: JS-only, but its script, attributes and allow-list are in the HTML. */
const CONSENT_BANNER = `
<script>window.cmp_block_ignoredomains = ["google.com","apple.com","recaptcha.net","schufa.de"];</script>
<script src="https://cdn.consentmanager.net/delivery/autoblock/15144.js" data-cmp-ab="1"></script>
<div data-cmp-host="1" data-cmp-vendor="s26" class="cmp-banner"></div>`;

/** A proof-of-work widget some pages embed; not a Bot check. */
const ALTCHA_WIDGET = `
<script async defer src="/js/altcha.min.js" type="module"></script>
<altcha-widget challengeurl="/altcha/challenge" class="altcha"></altcha-widget>`;

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><title>${title}</title></head><body>${CHROME}${CONSENT_BANNER}${body}</body></html>`;
}

export const searchPage = (cards = 3) =>
  page(
    "WG-Zimmer mieten in Berlin – Beispiel",
    Array.from(
      { length: cards },
      (_, i) =>
        `<a class="offer_list_item" id="liste-details-ad-${1000 + i}" href="/${1000 + i}.html">Zimmer ${i}</a>`,
    ).join(""),
  );

export const offerPage = () =>
  page(
    "Helles Zimmer in Beispielstadt",
    `<h1>Helles Zimmer</h1><div id="freitext_0">Wir suchen eine Mitbewohnerin. Bitte keine Überprüfung der Schufa nötig.</div>`,
  );

export const offerPageWithAltcha = () =>
  page("Zimmer mit Widget", `${ALTCHA_WIDGET}<div id="freitext_0">Text</div>`);

/** Normal pages that mention verification words in their text or other markup. */
export const textMentioningPage = () =>
  page(
    "Ratgeber",
    `<h1>Überprüfung Ihrer Unterlagen</h1><p>Im Captcha-Feld bestätigen Sie das. Mehr zu cmp und captcha und altcha.</p>
<script>var recaptchaEnabled = false; /* recaptcha is off */</script>`,
  );

const CUBA_FORM = `<form name="checkform" method="post" action="https://www.wg-gesucht.de/cuba.html"><input type="hidden" name="step" value="2"><input type="hidden" name="page" value="/wg-zimmer-in-Berlin.8.0.1.0.html"><div class="g-recaptcha" data-sitekey="synthetic"></div><button>Absenden</button></form>`;

/** The whole verification page. */
export const cubaPage = () =>
  `<!DOCTYPE html><html><head><title>Überprüfung</title><script src="https://www.google.com/recaptcha/api.js" async defer></script></head><body><h1>Bitte bestätigen Sie, dass Sie ein Mensch sind</h1>${CUBA_FORM}</body></html>`;

/** Normal pages with exactly one marker in them. */
export const withCheckform = () =>
  page(
    "Zimmer",
    `<form action='/cuba.html' method="post" name='checkform'><input name="step" value="2"></form>`,
  );
export const withTitle = () =>
  `<html><head><title>
    &Uuml;berpr&uuml;fung </title></head><body>${CHROME}</body></html>`;
export const withHeading = () =>
  page(
    "Zimmer",
    `<h1 class="x"><span>Bitte bestätigen Sie,</span> dass Sie ein   Mensch sind</h1>`,
  );
export const withRecaptchaElement = () =>
  page("Zimmer", `<div class="foo  g-recaptcha bar" data-sitekey="x"></div>`);
export const withRecaptchaScript = () =>
  page("Zimmer", `<script src='https://www.google.com/recaptcha/api.js?hl=de'></script>`);
