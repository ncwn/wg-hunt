import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { snapshotPath } from "../src/crawl/snapshots.js";
import { listFiles, removeFile, safeJoin } from "../src/retention/data-folder.js";
import { tempDataDir } from "./helpers.js";
import { bootOffers } from "./offers-harness.js";
import { goStale, nights, oneOffer } from "./retention-harness.js";

describe("safeJoin", () => {
  const root = "/data/wg-hunt";

  it("joins plain relative paths", () => {
    expect(safeJoin(root, "offer-pages/wg-gesucht/1.html.gz")).toBe(
      "/data/wg-hunt/offer-pages/wg-gesucht/1.html.gz",
    );
  });

  it.each([
    "../escape",
    "offer-pages/../../escape",
    "/etc/passwd",
    "a/../../b",
    "..",
    ".",
    "",
    "bad\0name",
  ])("refuses %j", (path) => {
    expect(() => safeJoin(root, path)).toThrow("not a path inside the data folder");
  });
});

describe("snapshot file names", () => {
  it.each([
    ["wg-gesucht", "../../x"],
    ["..", "123"],
    ["wg-gesucht", "12/34"],
    ["a/b", "1"],
    ["wg-gesucht", ""],
    ["wg gesucht", "1"],
  ])("refuses source %j with Ad ID %j", (source, adId) => {
    expect(() => snapshotPath(source, adId)).toThrow();
  });
});

describe("deleting only inside the data folder", () => {
  it("lists and removes plain files, and never a link, a folder or a path that leaves", () => {
    const dir = tempDataDir();
    const outside = tempDataDir();
    writeFileSync(join(outside, "target.txt"), "outside");
    mkdirSync(join(dir, "offer-pages", "wg-gesucht"), { recursive: true });
    writeFileSync(join(dir, "offer-pages", "wg-gesucht", "1.html.gz"), "inside");
    symlinkSync(join(outside, "target.txt"), join(dir, "offer-pages", "wg-gesucht", "2.html.gz"));

    expect(listFiles(dir, "offer-pages").map((f) => f.path)).toEqual([
      "offer-pages/wg-gesucht/1.html.gz",
    ]);
    expect(removeFile(dir, "offer-pages/wg-gesucht/2.html.gz")).toBe(false);
    expect(removeFile(dir, "offer-pages/wg-gesucht")).toBe(false);
    expect(removeFile(dir, `../${join(outside, "target.txt")}`)).toBe(false);
    expect(removeFile(dir, join(outside, "target.txt"))).toBe(false);
    expect(existsSync(join(outside, "target.txt"))).toBe(true);
    expect(removeFile(dir, "offer-pages/wg-gesucht/1.html.gz")).toBe(true);
  });

  it("does not list a folder that is itself a link to somewhere else", () => {
    const dir = tempDataDir();
    const outside = tempDataDir();
    writeFileSync(join(outside, "1.html.gz"), "outside");
    symlinkSync(outside, join(dir, "offer-pages"));
    expect(listFiles(dir, "offer-pages")).toEqual([]);
  });

  it("follows no database value out of the folder when pruning or wiping", async () => {
    const { h, id } = await oneOffer();
    const outside = join(h.dataDir, "..", `outside-${Date.now()}.html.gz`);
    writeFileSync(outside, "keep me");
    // A hand-edited database naming paths and ids that lead out of the folder.
    h.runtime.db.$client.exec(
      `UPDATE offer_ads SET adId = '../../outside', source = '..' WHERE offerId = ${id}`,
    );
    h.runtime.db.$client.exec("UPDATE seen_ads SET adId = '../x'");
    goStale(h);
    nights(h, 100);
    await h.json("POST", "/storage/wipe", { confirm: "delete all Offer data" });
    expect(existsSync(outside)).toBe(true);
  });
});

describe("a fresh instance", () => {
  it("prunes and wipes without any data", async () => {
    const h = bootOffers();
    expect(h.runtime.retention.prune()).toEqual({
      offers: 0,
      snapshots: 0,
      unexpectedPages: 0,
      requests: 0,
    });
    expect(
      (await h.json("POST", "/storage/wipe", { confirm: "delete all Offer data" })).status,
    ).toBe(200);
  });
});
