import { SOURCE_ORIGIN } from "./constants.js";

export class ForbiddenPathError extends Error {
  constructor(reason: string) {
    super(`path not allowed: ${reason}`);
    this.name = "ForbiddenPathError";
  }
}

// Matched against the decoded, lower-cased pathname after dot segments are resolved.
const FORBIDDEN: { pattern: RegExp; reason: string }[] = [
  { pattern: /(^|\/)api(\/|$)/, reason: "nothing under /api/" },
  { pattern: /login|logout/, reason: "no login" },
  { pattern: /(^|\/)(nachricht|nachrichten|messages?)[^/]*(\/|$)/, reason: "no messaging" },
  { pattern: /(^|\/)(userdata|qs)\.php$/, reason: "account page" },
  {
    pattern: /(^|[/._-])(edit|delete|bearbeiten|loeschen|löschen)([/._-]|$)/,
    reason: "no edit or delete pages",
  },
  { pattern: /(^|\/)cuba\.html$/, reason: "the bot check page is never requested" },
  { pattern: /(^|\/)(security-information|agb)\.html$/, reason: "disallowed by robots.txt" },
];

/** Query keys that may appear in the request log; anything else could carry personal data. */
const LOGGED_QUERY_KEYS = new Set(["sin", "noDeact", "rent_types[]", "page"]);

export function checkSourcePath(path: string): { pathname: string; search: string } {
  if (!/^\/(?!\/)/.test(path) || path.includes("\\")) {
    throw new ForbiddenPathError("not a path on the Source");
  }
  const url = new URL(path, SOURCE_ORIGIN);
  if (url.origin !== SOURCE_ORIGIN) throw new ForbiddenPathError("not a path on the Source");
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname).toLowerCase();
  } catch {
    throw new ForbiddenPathError("malformed escape");
  }
  for (const { pattern, reason } of FORBIDDEN) {
    if (pattern.test(decoded)) throw new ForbiddenPathError(reason);
  }
  return { pathname: url.pathname, search: url.search };
}

export function loggedPath(path: string): string {
  const { pathname, search } = checkSourcePath(path);
  const kept = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(search)) {
    if (LOGGED_QUERY_KEYS.has(key) && /^[\w-]{1,12}$/.test(value)) kept.append(key, value);
  }
  const query = kept.toString();
  return query === "" ? pathname : `${pathname}?${query}`;
}
