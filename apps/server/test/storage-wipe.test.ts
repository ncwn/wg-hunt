import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJson, writeJson } from "../src/crawl/kv.js";
import {
  crawlRequests,
  offerFactOverrides,
  offerPairOverrides,
  seenAds,
} from "../src/db/schema.js";
import { WIPE_CONFIRMATION } from "../src/retention/constants.js";
import { ingestAds } from "./dedupe-harness.js";
import { bootOffers, HOUR } from "./offers-harness.js";
import { oneOffer, recordExists, snapshotExists } from "./retention-harness.js";

const CONFIRM = { confirm: WIPE_CONFIRMATION };
const KEY = "sk-ant-api03-WIPEKEEPSTHISSECRET0123456789-a1b2";

async function populated() {
  const { h, id, adId } = await oneOffer();
  const profile = { ...(await h.json("GET", "/profile")).body, gender: "woman", age: 27 };
  await h.json("PUT", "/profile", profile);
  const filters = (await h.json("GET", "/filters")).body;
  filters.maxRent = { ...filters.maxRent, limit: 650 };
  await h.json("PUT", "/filters", filters);
  await h.json("PUT", "/secrets/anthropic", { value: KEY });
  await h.json("PUT", "/settings/analysis", {
    ...(await h.json("GET", "/settings/analysis")).body,
    monthlySpendCapUsd: 12.5,
  });
  await h.json("PATCH", `/offers/${id}/marks`, { shortlisted: true, contacted: true });
  await h.json("PUT", `/offers/${id}/facts/anmeldung`, { value: "possible" });
  h.runtime.db
    .insert(offerPairOverrides)
    .values({
      source: "wg-gesucht",
      adIdA: "9000001",
      adIdB: "9000099",
      verdict: "different",
      createdAt: new Date(h.clock.now),
    })
    .run();
  mkdirSync(join(h.dataDir, "unexpected-pages"), { recursive: true });
  writeFileSync(join(h.dataDir, "unexpected-pages", "page.html.gz"), "page");
  const searches = (await h.json("GET", "/searches")).body;
  return { h, id, adId, profile, filters, searches };
}

describe("POST /storage/wipe: the typed confirmation", () => {
  it("needs the access token", async () => {
    const { h } = await populated();
    const res = await h.runtime.app.request("/api/v1/storage/wipe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(CONFIRM),
    });
    expect(res.status).toBe(401);
    expect(await h.json("GET", "/offers").then((r) => r.body.items.length)).toBe(1);
  });

  for (const [name, body] of [
    ["no body", undefined],
    ["an empty body", {}],
    ["a wrong phrase", { confirm: "yes" }],
    ["the phrase in other letters", { confirm: WIPE_CONFIRMATION.toUpperCase() }],
    ["a boolean", { confirm: true }],
  ] as const) {
    it(`deletes nothing with ${name}`, async () => {
      const { h, id, adId } = await populated();
      const res = await h.call("POST", "/storage/wipe", body);
      expect(res.status).toBe(400);
      expect((await res.json()).type).toBe("validation-error");
      expect(recordExists(h, id)).toBe(true);
      expect(existsSync(join(h.dataDir, "offer-pages", "wg-gesucht", `${adId}.html.gz`))).toBe(
        true,
      );
      expect((await h.json("GET", "/crawl")).body.state).not.toBe("paused");
    });
  }
});

describe("POST /storage/wipe", () => {
  it("deletes Offers, marks, overrides, snapshots, saved pages and the request log", async () => {
    const { h, id, adId } = await populated();
    // Days later, so the request log has nothing the caps still count.
    h.clock.now += 3 * 24 * HOUR;

    const res = await h.json("POST", "/storage/wipe", CONFIRM);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toMatchObject({ offers: 1, snapshots: 1, unexpectedPages: 1 });

    expect(recordExists(h, id)).toBe(false);
    expect((await h.json("GET", "/offers?includeHidden=true")).body.items).toEqual([]);
    expect((await h.json("GET", `/offers/${id}`)).status).toBe(404);
    expect(h.runtime.db.select().from(offerPairOverrides).all()).toEqual([]);
    expect(h.runtime.db.select().from(offerFactOverrides).all()).toEqual([]);
    expect(h.runtime.db.select().from(seenAds).all()).toEqual([]);
    expect(h.runtime.db.select().from(crawlRequests).all()).toEqual([]);
    expect(readdirSync(join(h.dataDir, "offer-pages", "wg-gesucht"))).toEqual([]);
    expect(existsSync(join(h.dataDir, "offer-pages", "wg-gesucht", `${adId}.html.gz`))).toBe(false);
    expect(existsSync(join(h.dataDir, "unexpected-pages", "page.html.gz"))).toBe(false);
    expect(res.body.storage.offers.total).toBe(0);
    expect(res.body.storage.snapshots).toEqual({ files: 0, bytes: 0 });
  });

  it("keeps the Profile, Filters, Searches, settings and secrets, and the access token", async () => {
    const { h, profile, filters, searches } = await populated();
    const crawlSettings = (await h.json("GET", "/settings/crawl")).body;
    const token = h.runtime.token;
    await h.json("POST", "/storage/wipe", CONFIRM);

    expect((await h.json("GET", "/profile")).body).toEqual(profile);
    expect((await h.json("GET", "/filters")).body).toEqual(filters);
    const after = (await h.json("GET", "/searches")).body;
    const withoutCrawl = (list: { items: object[] }) =>
      list.items.map(
        ({ poll: _poll, sweep: _sweep, ...rest }: { poll?: unknown; sweep?: unknown }) => rest,
      );
    expect(withoutCrawl(after)).toEqual(withoutCrawl(searches));
    for (const search of after.items) {
      expect(search.sweep).toMatchObject({
        status: "scheduled",
        mode: "backfill",
        lastFinishedAt: null,
      });
    }
    expect((await h.json("GET", "/settings/crawl")).body).toEqual(crawlSettings);
    expect((await h.json("GET", "/settings/analysis")).body.monthlySpendCapUsd).toBe(12.5);
    const secrets = (await h.json("GET", "/secrets")).body;
    expect(secrets.find((s: { name: string }) => s.name === "anthropic")).toMatchObject({
      set: true,
    });
    expect(h.runtime.token).toBe(token);
    expect(existsSync(join(h.dataDir, "access-token"))).toBe(true);
  });

  it("pauses crawling, and the next Resume runs a fresh backfill of every Search", async () => {
    const { h, adId } = await populated();
    const fetchedBefore = h.sent.filter((path) => path.includes(adId)).length;
    expect(fetchedBefore).toBeGreaterThan(0);

    await h.json("POST", "/storage/wipe", CONFIRM);
    expect((await h.json("GET", "/crawl")).body).toMatchObject({
      state: "wiped",
      paused: { reason: "wiped" },
    });
    const sentBefore = h.sent.length;
    await h.crawl(6 * HOUR);
    expect(h.sent.length).toBe(sentBefore);

    expect((await h.json("POST", "/crawl/resume")).status).toBe(200);
    await h.crawl(6 * HOUR);

    expect(h.sent.filter((path) => path.includes(adId)).length).toBeGreaterThan(fetchedBefore);
    const { items } = (await h.json("GET", "/offers")).body;
    expect(items).toHaveLength(1);
    expect(items[0].marks).toEqual({ dismissed: false, shortlisted: false, contacted: false });
  });

  it("keeps the request log rows the daily and hourly caps still count", async () => {
    const { h } = await populated();
    const before = h.runtime.db.select().from(crawlRequests).all().length;
    expect(before).toBeGreaterThan(0);
    // The requests were sent this Berlin morning, within the day's cap count.
    await h.json("POST", "/storage/wipe", CONFIRM);
    expect(h.runtime.db.select().from(crawlRequests).all().length).toBe(before);
    expect((await h.json("GET", "/crawl")).body.counts.day.used).toBe(before);
  });

  it("works on an empty instance, and twice", async () => {
    const { h } = await oneOffer();
    expect((await h.json("POST", "/storage/wipe", CONFIRM)).status).toBe(200);
    const again = await h.json("POST", "/storage/wipe", CONFIRM);
    expect(again.status).toBe(200);
    expect(again.body.deleted.offers).toBe(0);
  });

  it("leaves the instance working: new Offers can be made after a wipe", async () => {
    const { h } = await populated();
    await h.json("POST", "/storage/wipe", CONFIRM);
    const [fresh] = ingestAds(h, { adId: 9000050 });
    expect(recordExists(h, fresh?.offerId as number)).toBe(true);
  });
});

describe("POST /storage/wipe: its own state", () => {
  function gateNextFetch(h: Awaited<ReturnType<typeof populated>>["h"]) {
    const original = h.fetcher.fetch;
    let release!: () => void;
    const opened = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      started = resolve;
    });
    h.fetcher.fetch = async (path) => {
      h.fetcher.fetch = original;
      started();
      await opened;
      return original(path);
    };
    return { inFlight, release };
  }

  it("refuses a Resume while the wipe waits for the request in flight, and stays paused", async () => {
    const { h } = await populated();
    h.clock.now += 6 * HOUR;
    const gate = gateNextFetch(h);
    const step = h.runtime.crawl.step();
    await gate.inFlight;

    const wipe = h.json("POST", "/storage/wipe", CONFIRM);
    // The wipe has paused and now waits for the request in flight.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const storage = (await h.json("GET", "/storage")).body;
    expect(storage.wipe.running).toMatchObject({ since: new Date(h.clock.now).toISOString() });
    expect(storage.wipe.last).toBeNull();
    const during = (await h.json("GET", "/crawl")).body;
    expect(during).toMatchObject({
      state: "wiped",
      paused: { reason: "wiped" },
      holds: ["wiped"],
      actions: { pause: false, resume: false },
    });
    const resume = await h.call("POST", "/crawl/resume");
    expect(resume.status).toBe(409);
    expect((await resume.json()).type).toBe("wipe-running");

    gate.release();
    await step;
    expect((await wipe).status).toBe(200);

    const after = (await h.json("GET", "/crawl")).body;
    expect(after).toMatchObject({
      state: "wiped",
      paused: { reason: "wiped" },
      holds: ["wiped"],
      actions: { pause: false, resume: true },
    });
    const sentBefore = h.sent.length;
    await h.crawl(6 * HOUR);
    expect(h.sent.length).toBe(sentBefore);

    const done = (await h.json("GET", "/storage")).body.wipe;
    expect(done.running).toBeNull();
    expect(done.last).toMatchObject({ deleted: { offers: 1 } });
    expect(typeof done.last.at).toBe("string");

    expect((await h.json("POST", "/crawl/resume")).status).toBe(200);
    await h.crawl(6 * HOUR);
    expect(h.sent.length).toBeGreaterThan(sentBefore);
  });

  it.each([
    ["finds an unexpected page", () => ({ unexpectedPage: true })],
    [
      "throws",
      () => {
        throw new Error("parser exploded");
      },
    ],
  ])("keeps the wipe as the cause when the request in flight %s", async (_, handler) => {
    const { h } = await populated();
    h.runtime.crawl.on("poll", handler);
    h.clock.now += 6 * HOUR;
    const gate = gateNextFetch(h);
    const step = h.runtime.crawl.step();
    await gate.inFlight;
    const wipe = h.json("POST", "/storage/wipe", CONFIRM);
    await new Promise((resolve) => setTimeout(resolve, 10));
    gate.release();
    await step;
    expect((await wipe).status).toBe(200);

    expect((await h.json("GET", "/crawl")).body).toMatchObject({
      state: "wiped",
      paused: { reason: "wiped", cause: null, path: null, savedAs: null },
      holds: ["wiped"],
      actions: { pause: false, resume: true },
    });
  });

  it("replaces a Pause: the cause that shows is the wipe", async () => {
    const { h } = await populated();
    await h.json("POST", "/crawl/pause");
    await h.json("POST", "/storage/wipe", CONFIRM);
    expect((await h.json("GET", "/crawl")).body.paused.reason).toBe("wiped");
  });

  it("a Pause after the wipe keeps the wipe as the cause", async () => {
    const { h } = await populated();
    await h.json("POST", "/storage/wipe", CONFIRM);
    await h.json("POST", "/crawl/pause");
    expect((await h.json("GET", "/crawl")).body.paused.reason).toBe("wiped");
  });

  it("GET /storage shows no wipe on a fresh instance", async () => {
    const { h } = await oneOffer();
    expect((await h.json("GET", "/storage")).body.wipe).toEqual({ running: null, last: null });
  });

  it("a second wipe while one runs joins it", async () => {
    const { h } = await populated();
    h.clock.now += 6 * HOUR;
    const gate = gateNextFetch(h);
    const step = h.runtime.crawl.step();
    await gate.inFlight;
    const first = h.json("POST", "/storage/wipe", CONFIRM);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = h.json("POST", "/storage/wipe", CONFIRM);
    gate.release();
    await step;
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.deleted).toEqual(a.body.deleted);
    expect(a.body.deleted.offers).toBe(1);
  });

  it("a wipe whose delete fails leaves a plain Pause, not the wipe, as the cause", async () => {
    const { h, id } = await populated();
    h.runtime.db.$client
      .prepare(
        "CREATE TEMP TRIGGER no_delete BEFORE DELETE ON offers BEGIN SELECT RAISE(ABORT, 'no'); END",
      )
      .run();
    const res = await h.call("POST", "/storage/wipe", CONFIRM);
    expect(res.status).toBe(500);

    expect(recordExists(h, id)).toBe(true);
    expect((await h.json("GET", "/storage")).body.wipe).toEqual({ running: null, last: null });
    expect((await h.json("GET", "/crawl")).body).toMatchObject({
      state: "paused",
      paused: { reason: "user" },
      holds: ["paused"],
      actions: { resume: true },
    });
  });

  it("a wipe the process stopped in before deleting anything leaves a plain Pause at the next start", async () => {
    const { h, id } = await oneOffer();
    // An earlier wipe finished; then a second one paused and the process stopped while it waited
    // for the request in flight.
    const deleted = { offers: 0, snapshots: 0, unexpectedPages: 0, requests: 0 };
    writeJson(
      h.runtime.db,
      "retention.lastWipe",
      { at: h.clock.now - HOUR, deleted, filesRemoved: true },
      h.clock.now,
    );
    const state = (readJson(h.runtime.db, "crawl.engine") as object | undefined) ?? {};
    writeJson(
      h.runtime.db,
      "crawl.engine",
      { ...state, paused: { reason: "wiped", at: h.clock.now } },
      h.clock.now,
    );
    h.runtime.close();

    const again = bootOffers({ dataDir: h.dataDir, start: h.clock.now });
    expect(recordExists(again, id)).toBe(true);
    expect((await again.json("GET", "/crawl")).body).toMatchObject({
      state: "paused",
      paused: { reason: "user" },
      holds: ["paused"],
    });
  });

  it("keeps the wipe as the cause across a restart once the wipe happened", async () => {
    const { h } = await populated();
    await h.json("POST", "/storage/wipe", CONFIRM);
    h.runtime.close();

    const again = bootOffers({ dataDir: h.dataDir, start: h.clock.now });
    expect((await again.json("GET", "/crawl")).body).toMatchObject({
      state: "wiped",
      paused: { reason: "wiped" },
    });
  });

  it("finishes at the next start a wipe the process stopped in before removing the pages", async () => {
    const { h, adId } = await oneOffer();
    // As if the process stopped right after the rows were deleted.
    h.runtime.db.$client.prepare("DELETE FROM offers").run();
    const deleted = { offers: 1, snapshots: 0, unexpectedPages: 0, requests: 0 };
    writeJson(
      h.runtime.db,
      "retention.lastWipe",
      { at: h.clock.now, deleted, filesRemoved: false },
      h.clock.now,
    );
    expect(snapshotExists(h, adId)).toBe(true);
    h.runtime.close();

    const again = bootOffers({ dataDir: h.dataDir, start: h.clock.now });
    expect(snapshotExists(again, adId)).toBe(false);
    expect((await again.json("GET", "/storage")).body.wipe.last).toMatchObject({
      deleted: { offers: 1, snapshots: 1 },
      filesRemoved: true,
    });
  });
});
