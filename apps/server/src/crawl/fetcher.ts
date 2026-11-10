import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type { CookieJar } from "tough-cookie";
import { Agent, request } from "undici";
import { MAX_BODY_BYTES, SOURCE_ORIGIN, USER_AGENT } from "./constants.js";
import { checkSourcePath } from "./source-paths.js";

type HeaderValue = string | string[] | undefined;

export type Transport = (req: {
  url: string;
  headers: Record<string, string>;
}) => Promise<{ status: number; headers: Record<string, HeaderValue>; body: string }>;

export type SourceResponse = {
  status: number;
  body: string;
  /** Redirects are not followed. */
  location?: string;
  /** The `Retry-After` header as a number of seconds from now, when it was sent and made sense. */
  retryAfterSeconds?: number;
};

/** The only way to reach the Source. Refuses paths under `/api/` and anything behind a login. */
export type SourceFetcher = { fetch(path: string): Promise<SourceResponse> };

export function createSourceFetcher(deps: {
  transport: Transport;
  jar: CookieJar;
  onCookies?: (jar: CookieJar) => void;
  /** Epoch milliseconds. */
  clock?: () => number;
}): SourceFetcher {
  const clock = deps.clock ?? Date.now;
  return {
    async fetch(path) {
      const { pathname, search } = checkSourcePath(path);
      const url = `${SOURCE_ORIGIN}${pathname}${search}`;
      const headers: Record<string, string> = {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "accept-language": "de-DE,de;q=0.9,en;q=0.5",
      };
      const cookie = await deps.jar.getCookieString(url);
      if (cookie !== "") headers.cookie = cookie;

      const res = await deps.transport({ url, headers });

      const setCookie = res.headers["set-cookie"];
      for (const line of Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []) {
        await deps.jar.setCookie(line, url, { ignoreError: true });
      }
      deps.onCookies?.(deps.jar);

      const location = res.headers.location;
      const retryAfter = parseRetryAfter(res.headers["retry-after"], clock());
      return {
        status: res.status,
        body: res.body,
        ...(typeof location === "string" && { location }),
        ...(retryAfter !== undefined && { retryAfterSeconds: retryAfter }),
      };
    },
  };
}

function parseRetryAfter(value: HeaderValue, now: number): number | undefined {
  const text = (Array.isArray(value) ? value[0] : value)?.trim();
  if (text === undefined || text === "") return undefined;
  if (/^\d{1,9}$/.test(text)) return Number(text);
  const date = Date.parse(text);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.round((date - now) / 1000));
}

const decoders: Record<string, (body: Buffer, options: { maxOutputLength: number }) => Buffer> = {
  gzip: gunzipSync,
  deflate: inflateSync,
  br: brotliDecompressSync,
};

export function createUndiciTransport(): Transport {
  let dispatcher: Agent | undefined;
  return async ({ url, headers }) => {
    dispatcher ??= new Agent({ connections: 1, headersTimeout: 30_000, bodyTimeout: 30_000 });
    const res = await request(url, {
      method: "GET",
      headers: { ...headers, "accept-encoding": "gzip, deflate, br" },
      dispatcher,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.body.destroy();
        throw new Error("response body too large");
      }
      chunks.push(chunk);
    }
    let bytes: Buffer = Buffer.concat(chunks);
    const encoding = res.headers["content-encoding"];
    const decode =
      typeof encoding === "string" ? decoders[encoding.trim().toLowerCase()] : undefined;
    if (decode) bytes = decode(bytes, { maxOutputLength: MAX_BODY_BYTES });
    return { status: res.statusCode, headers: res.headers, body: bytes.toString("utf8") };
  };
}
