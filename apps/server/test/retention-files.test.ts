import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/index.js";
import { crawlRequests } from "../src/db/schema.js";
import { compact } from "../src/retention/prune.js";
import { nextScheduledPrune } from "../src/retention/schedule.js";
import { tempDataDir } from "./helpers.js";
import { bootOffers, HOUR } from "./offers-harness.js";
import {
  DAY,
  goStale,
  type Harness,
  nights,
  oneOffer,
  recordExists,
  snapshotExists,
} from "./retention-harness.js";

function oldFile(h: Harness, path: string, ageDays: number) {
  const full = join(h.dataDir, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, "x");
  const when = new Date(h.clock.now - ageDays * DAY);
  utimesSync(full, when, when);
  return full;
}

const exists = (h: Harness, path: string) => existsSync(join(h.dataDir, path));

describe("the raw snapshot's 30 days", () => {
  it("deletes the snapshot 30 days after the Offer went Stale, and keeps the record", async () => {
    const { h, id, adId } = await oneOffer();
    expect(snapshotExists(h, adId)).toBe(true);
    goStale(h);

    nights(h, 29);
    expect(snapshotExists(h, adId)).toBe(true);
    nights(h, 2);

    expect(snapshotExists(h, adId)).toBe(false);
    expect(recordExists(h, id)).toBe(true);
    expect((await h.json("GET", `/offers/${id}`)).status).toBe(200);
  });

  it("deletes the snapshot of a marked Offer on the same schedule", async () => {
    const { h, id, adId } = await oneOffer();
    await h.json("PATCH", `/offers/${id}/marks`, { shortlisted: true });
    goStale(h);
    nights(h, 31);
    expect(snapshotExists(h, adId)).toBe(false);
    expect(recordExists(h, id)).toBe(true);
  });

  it("keeps the snapshot of an Offer that came back before the 30 days", async () => {
    const { h, adId } = await oneOffer();
    goStale(h);
    nights(h, 25);
    h.runtime.db.$client.exec(`UPDATE offer_ads SET lastBumpAt = ${h.clock.now}`);
    // Quiet again 8 nights later; its 30 days start then, not 25 nights ago.
    nights(h, 37);
    expect(snapshotExists(h, adId)).toBe(true);
    nights(h, 2);
    expect(snapshotExists(h, adId)).toBe(false);
  });

  it("deletes snapshots that no Offer owns once they are 30 days old", async () => {
    const h = bootOffers();
    oldFile(h, "offer-pages/wg-gesucht/111.html.gz", 31);
    oldFile(h, "offer-pages/wg-gesucht/222.html.gz", 29);
    oldFile(h, "offer-pages/wg-gesucht/333.html.gz.tmp", 31);
    h.runtime.retention.prune();
    expect(exists(h, "offer-pages/wg-gesucht/111.html.gz")).toBe(false);
    expect(exists(h, "offer-pages/wg-gesucht/222.html.gz")).toBe(true);
    expect(exists(h, "offer-pages/wg-gesucht/333.html.gz.tmp")).toBe(false);
  });
});

describe("pages saved for 'page layout changed?' and the request log", () => {
  it("deletes saved pages after 30 days", () => {
    const h = bootOffers();
    oldFile(h, "unexpected-pages/old.html.gz", 31);
    oldFile(h, "unexpected-pages/new.html.gz", 29);
    const result = h.runtime.retention.prune();
    expect(result.unexpectedPages).toBe(1);
    expect(exists(h, "unexpected-pages/old.html.gz")).toBe(false);
    expect(exists(h, "unexpected-pages/new.html.gz")).toBe(true);
  });

  it("deletes request log rows after 30 days", async () => {
    const { h } = await oneOffer();
    const rows = () => h.runtime.db.select().from(crawlRequests).all().length;
    const total = rows();
    expect(total).toBeGreaterThan(1);
    h.clock.now += 29 * DAY;
    h.runtime.retention.prune();
    expect(rows()).toBe(total);
    h.clock.now += 2 * DAY;
    expect(h.runtime.retention.prune().requests).toBe(total);
    expect(rows()).toBe(0);
  });
});

describe("what the prune never touches", () => {
  it("leaves files outside the data folder alone, even through links", () => {
    const h = bootOffers();
    const outside = tempDataDir();
    const secret = join(outside, "keep.html.gz");
    writeFileSync(secret, "precious");
    const when = new Date(h.clock.now - 400 * DAY);
    utimesSync(secret, when, when);
    mkdirSync(join(h.dataDir, "offer-pages"), { recursive: true });
    symlinkSync(outside, join(h.dataDir, "offer-pages", "wg-gesucht"));
    symlinkSync(secret, join(h.dataDir, "offer-pages", "999.html.gz"));
    mkdirSync(join(h.dataDir, "unexpected-pages"), { recursive: true });
    symlinkSync(secret, join(h.dataDir, "unexpected-pages", "link.html.gz"));

    h.runtime.retention.prune();
    expect(readFileSync(secret, "utf8")).toBe("precious");
  });

  it("keeps the data folder's other files: the access token and the database", async () => {
    const { h } = await oneOffer();
    nights(h, 200);
    expect(readFileSync(join(h.dataDir, "access-token"), "utf8").trim().length).toBeGreaterThan(8);
    expect(existsSync(join(h.dataDir, "wg-hunt.sqlite"))).toBe(true);
  });
});

describe("incremental vacuum", () => {
  it("gives freed pages back to the disk", () => {
    const h = bootOffers();
    const filler = "x".repeat(1000);
    const insert = h.runtime.db.$client.prepare(
      "INSERT INTO crawl_requests (at, kind, path, outcome) VALUES (?, 'poll', ?, 'ok')",
    );
    h.runtime.db.$client.transaction(() => {
      for (let i = 0; i < 3000; i++) insert.run(h.clock.now - 60 * DAY, `/${i}/${filler}`);
    })();
    const pages = () => h.runtime.db.$client.pragma("page_count", { simple: true }) as number;
    const before = pages();
    expect(before).toBeGreaterThan(500);

    h.runtime.retention.prune();

    expect(h.runtime.db.$client.pragma("freelist_count", { simple: true })).toBe(0);
    expect(pages()).toBeLessThan(before / 4);
  });

  it("converts a database made without it", () => {
    const file = join(tempDataDir(), "old.sqlite");
    const old = new Database(file);
    old.exec("CREATE TABLE t (x TEXT)");
    old.close();

    const db = openDatabase(file);
    expect(db.$client.pragma("auto_vacuum", { simple: true })).toBe(0);
    compact(db);
    expect(db.$client.pragma("auto_vacuum", { simple: true })).toBe(2);
    db.$client.close();
  });

  it("starts a new database with it", () => {
    const db = openDatabase(join(tempDataDir(), "new.sqlite"));
    expect(db.$client.pragma("auto_vacuum", { simple: true })).toBe(2);
    db.$client.close();
  });
});

describe("the nightly schedule", () => {
  // 03:00 in Berlin is 02:00 UTC in winter and 01:00 UTC in summer.
  const at = (iso: string) => Date.parse(iso);

  it("finds the next 03:00 Berlin, winter and summer", () => {
    expect(nextScheduledPrune(at("2026-11-04T09:00:00Z"))).toBe(at("2026-11-05T02:00:00Z"));
    expect(nextScheduledPrune(at("2026-11-05T01:59:00Z"))).toBe(at("2026-11-05T02:00:00Z"));
    expect(nextScheduledPrune(at("2026-11-05T02:00:00Z"))).toBe(at("2026-11-05T02:00:00Z"));
    expect(nextScheduledPrune(at("2026-07-10T01:30:00Z"))).toBe(at("2026-07-11T01:00:00Z"));
    // The night the clocks go back (25 October 2026): 03:00 still comes once.
    expect(nextScheduledPrune(at("2026-10-24T05:00:00Z"))).toBe(at("2026-10-25T02:00:00Z"));
  });

  it("prunes once after each 03:00 Berlin, and makes up for a night the host was off", async () => {
    const h = bootOffers();
    expect(h.runtime.retention.tick()).toBeDefined();
    expect(h.runtime.retention.tick()).toBeUndefined();

    h.clock.now = at("2026-11-05T01:59:00Z");
    expect(h.runtime.retention.tick()).toBeUndefined();
    h.clock.now = at("2026-11-05T02:00:00Z");
    expect(h.runtime.retention.tick()).toBeDefined();
    h.clock.now += HOUR;
    expect(h.runtime.retention.tick()).toBeUndefined();

    h.clock.now = at("2026-11-08T11:00:00Z");
    expect(h.runtime.retention.tick()).toBeDefined();
    expect(h.runtime.retention.tick()).toBeUndefined();
  });

  it("reports when it last ran", () => {
    const h = bootOffers();
    expect(h.runtime.retention.storage().lastPrune).toBeNull();
    h.runtime.retention.prune();
    expect(h.runtime.retention.storage().lastPrune).toBe(new Date(h.clock.now).toISOString());
  });
});
