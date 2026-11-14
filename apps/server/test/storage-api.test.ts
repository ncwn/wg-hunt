import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ingestAds, OTHER_ROOM_TEXT } from "./dedupe-harness.js";
import { bootOffers } from "./offers-harness.js";
import { oneOffer } from "./retention-harness.js";

const sizeOf = (path: string) => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

function filesBelow(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
  } catch {
    return [];
  }
}

describe("GET /storage", () => {
  it("needs the access token", async () => {
    const h = bootOffers();
    expect((await h.runtime.app.request("/api/v1/storage")).status).toBe(401);
  });

  it("returns the retention constants, read-only", async () => {
    const h = bootOffers();
    const { status, body } = await h.json("GET", "/storage");
    expect(status).toBe(200);
    expect(body.retention).toEqual({
      recordDays: 90,
      snapshotDays: 30,
      unexpectedPageDays: 30,
      requestLogDays: 30,
      lowDiskBytes: 1024 ** 3,
      pruneAt: "03:00 Europe/Berlin",
    });
    expect((await h.json("PUT", "/storage", {})).status).toBe(404);
  });

  it("matches the files on disk", async () => {
    const { h } = await oneOffer();
    mkdirSync(join(h.dataDir, "unexpected-pages"), { recursive: true });
    writeFileSync(join(h.dataDir, "unexpected-pages", "page.html.gz"), "z".repeat(1234));
    // A prune checkpoints the write-ahead log; the readout counts it either way.
    const { body } = await h.json("GET", "/storage");

    const database = ["wg-hunt.sqlite", "wg-hunt.sqlite-wal", "wg-hunt.sqlite-shm"]
      .map((name) => sizeOf(join(h.dataDir, name)))
      .reduce((a, b) => a + b, 0);
    const snapshots = filesBelow(join(h.dataDir, "offer-pages"));
    expect(snapshots.length).toBeGreaterThan(0);
    expect(body.database.bytes).toBe(database);
    expect(body.snapshots).toEqual({
      files: snapshots.length,
      bytes: snapshots.map(sizeOf).reduce((a, b) => a + b, 0),
    });
    expect(body.unexpectedPages).toEqual({ files: 1, bytes: 1234 });
    expect(body.requestLog.rows).toBeGreaterThan(0);
    expect(body.freeBytes).toBeGreaterThan(0);
  });

  it("counts Offers shown, Stale, Untracked and kept for marks", async () => {
    const { h } = await oneOffer();
    const rooms = [
      { adId: 9000002, street: "Zweite Straße 2", text: OTHER_ROOM_TEXT, flatSize: 55 },
      { adId: 9000003, street: "Dritte Straße 3", text: "c ".repeat(90), flatSize: 61 },
      { adId: 9000004, street: "Vierte Straße 4", text: "d ".repeat(95), flatSize: 72 },
    ];
    const [, third, fourth] = ingestAds(h, ...rooms);
    await h.json("PATCH", `/offers/${third?.offerId}/marks`, { shortlisted: true });
    await h.json("PATCH", `/offers/${fourth?.offerId}/marks`, { dismissed: true });
    h.runtime.db.$client.exec(
      "UPDATE offer_ads SET pageStatus = 'deactivated' WHERE adId = '9000004'",
    );

    const { body } = await h.json("GET", "/storage");
    expect(body.offers).toEqual({
      total: 4,
      shown: 1,
      stale: 1,
      untracked: 2,
      keptForMarks: 2,
    });
  });
});
