import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SOURCE_ORIGIN } from "../src/crawl/constants.js";
import { loadCookieJar, saveCookieJar } from "../src/crawl/cookie-jar.js";
import { createSourceFetcher } from "../src/crawl/fetcher.js";
import { openDatabase } from "../src/db/index.js";
import { tempDataDir } from "./helpers.js";

describe("persistent cookie jar", () => {
  it("keeps the Source's cookies across a restart and sets none of its own", async () => {
    const file = join(tempDataDir(), "jar.sqlite");
    const first = openDatabase(file);
    const fetcher = createSourceFetcher({
      transport: async () => ({
        status: 200,
        headers: { "set-cookie": ["PHPSESSID=abc123; Path=/", "last_city=8; Path=/"] },
        body: "",
      }),
      jar: loadCookieJar(first),
      onCookies: (jar) => saveCookieJar(first, jar, Date.now()),
    });
    await fetcher.fetch("/a.html");
    first.$client.close();

    const jar = loadCookieJar(openDatabase(file));
    const cookies = await jar.getCookies(SOURCE_ORIGIN);
    expect(cookies.map((c) => c.key).sort()).toEqual(["PHPSESSID", "last_city"]);
  });

  it("starts with an empty jar, and with one if the stored jar is damaged", async () => {
    const db = openDatabase(join(tempDataDir(), "empty.sqlite"));
    expect(await loadCookieJar(db).getCookies(SOURCE_ORIGIN)).toEqual([]);
    saveCookieJar(db, { toJSON: () => "garbage" } as never, Date.now());
    expect(await loadCookieJar(db).getCookies(SOURCE_ORIGIN)).toEqual([]);
  });
});
