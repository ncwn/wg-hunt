import { CookieJar } from "tough-cookie";
import { describe, expect, it } from "vitest";
import { SOURCE_ORIGIN, USER_AGENT } from "../src/crawl/constants.js";
import { createSourceFetcher, type Transport } from "../src/crawl/fetcher.js";
import { ForbiddenPathError } from "../src/crawl/source-paths.js";

type Sent = { url: string; headers: Record<string, string> };

function fakeTransport(respond: (sent: Sent) => ReturnType<Transport>) {
  const sent: Sent[] = [];
  const transport: Transport = async (req) => {
    sent.push(req);
    return respond(req);
  };
  return { transport, sent };
}

const ok = (body = "<html></html>", headers: Record<string, string | string[]> = {}) =>
  Promise.resolve({ status: 200, headers, body });

describe("source fetcher", () => {
  it("requests the path on the Source with the one fixed desktop User-Agent", async () => {
    const { transport, sent } = fakeTransport(() => ok("hello"));
    const fetcher = createSourceFetcher({ transport, jar: new CookieJar() });

    const res = await fetcher.fetch("/wg-zimmer-in-Berlin.8.0.1.0.html?sin=2");
    await fetcher.fetch("/1234567.html");

    expect(res).toMatchObject({ status: 200, body: "hello" });
    expect(sent.map((s) => s.url)).toEqual([
      `${SOURCE_ORIGIN}/wg-zimmer-in-Berlin.8.0.1.0.html?sin=2`,
      `${SOURCE_ORIGIN}/1234567.html`,
    ]);
    expect(new Set(sent.map((s) => s.headers["user-agent"]))).toEqual(new Set([USER_AGENT]));
  });

  it("keeps the Source's own cookies in one jar and sends them back", async () => {
    let n = 0;
    const { transport, sent } = fakeTransport(() =>
      ok("", n++ === 0 ? { "set-cookie": ["PHPSESSID=abc123; Path=/"] } : {}),
    );
    const fetcher = createSourceFetcher({ transport, jar: new CookieJar() });

    await fetcher.fetch("/a.html");
    await fetcher.fetch("/b.html");

    expect(sent[0]?.headers.cookie).toBeUndefined();
    expect(sent[1]?.headers.cookie).toBe("PHPSESSID=abc123");
  });

  it("reports the jar to the caller after a response so it can be persisted", async () => {
    const { transport } = fakeTransport(() => ok("", { "set-cookie": "X-Client-Id=wg; Path=/" }));
    const saved: CookieJar[] = [];
    const jar = new CookieJar();
    const fetcher = createSourceFetcher({ transport, jar, onCookies: (j) => saved.push(j) });
    await fetcher.fetch("/a.html");
    expect(saved).toEqual([jar]);
  });

  it("does not follow redirects; it returns the Location for the caller to judge", async () => {
    const { transport, sent } = fakeTransport(() =>
      Promise.resolve({ status: 302, headers: { location: "/cuba.html?page=/x.html" }, body: "" }),
    );
    const res = await createSourceFetcher({ transport, jar: new CookieJar() }).fetch("/x.html");
    expect(res.status).toBe(302);
    expect(res.location).toBe("/cuba.html?page=/x.html");
    expect(sent).toHaveLength(1);
  });

  it("returns Retry-After as seconds, from a number or an HTTP date, and ignores nonsense", async () => {
    const answer = (retryAfter: string) => {
      const { transport } = fakeTransport(() =>
        Promise.resolve({ status: 429, headers: { "retry-after": retryAfter }, body: "" }),
      );
      return createSourceFetcher({
        transport,
        jar: new CookieJar(),
        clock: () => Date.parse("2026-06-10T06:00:00Z"),
      }).fetch("/x.html");
    };
    expect((await answer("120")).retryAfterSeconds).toBe(120);
    expect((await answer("Wed, 10 Jun 2026 06:10:00 GMT")).retryAfterSeconds).toBe(600);
    expect((await answer("Wed, 10 Jun 2026 05:00:00 GMT")).retryAfterSeconds).toBe(0);
    expect(await answer("soon")).not.toHaveProperty("retryAfterSeconds");
  });

  it.each([
    "/api/v1/offers",
    "/API/anything",
    "/api",
    "/x/../api/foo",
    "/%61pi/foo",
    "/en/login.html",
    "/login",
    "//evil.example/x.html",
    "https://evil.example/x.html",
    "relative.html",
    "/nachricht-senden/123.html",
    "/userdata.php",
    "/cuba.html",
    "/cuba.html?page=/x.html",
    "/edit/123.html",
    "/angebot-bearbeiten.123.html",
    "/anzeige-loeschen.html",
    "/delete.php",
  ])("refuses %s without sending anything", async (path) => {
    const { transport, sent } = fakeTransport(() => ok());
    const fetcher = createSourceFetcher({ transport, jar: new CookieJar() });
    await expect(fetcher.fetch(path)).rejects.toBeInstanceOf(ForbiddenPathError);
    expect(sent).toHaveLength(0);
  });
});
