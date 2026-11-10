const ORIGIN = "https://www.wg-gesucht.de";
const HOSTS = new Set(["wg-gesucht.de", "www.wg-gesucht.de"]);

/** An Offer page ends in `.<Ad ID>.html`; a search page ends in `.8.0.1.0.html`. */
const OFFER_FILE = /(?:^|[./])(\d{4,})\.html$/;

export function offerUrl(path: string): string {
  return new URL(path, ORIGIN).href;
}

export function adIdFromUrl(text: string): string | null {
  const pasted = text.trim();
  if (pasted === "") return null;
  let url: URL;
  try {
    url = pasted.startsWith("/") ? new URL(pasted, ORIGIN) : new URL(withScheme(pasted));
  } catch {
    return null;
  }
  if (!HOSTS.has(url.hostname.toLowerCase())) return null;
  return OFFER_FILE.exec(url.pathname)?.[1] ?? null;
}

const withScheme = (text: string) =>
  /^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`;
