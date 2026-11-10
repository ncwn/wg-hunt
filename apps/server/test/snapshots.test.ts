import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createSnapshotStore } from "../src/crawl/snapshots.js";
import { tempDataDir } from "./helpers.js";

const html = (marker: string) => `<html><body>${marker.repeat(2000)}</body></html>`;

describe("Offer page snapshots", () => {
  it("keeps the page as gzip inside the data folder, smaller than the HTML", () => {
    const dataDir = tempDataDir();
    const store = createSnapshotStore(dataDir);
    store.write("wg-gesucht", "9000001", html("a"));

    const bytes = readFileSync(join(dataDir, "offer-pages/wg-gesucht/9000001.html.gz"));
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    expect(bytes.length).toBeLessThan(html("a").length / 10);
    expect(gunzipSync(bytes).toString("utf8")).toBe(html("a"));
    expect(store.read("wg-gesucht", "9000001")).toBe(html("a"));
  });

  it("is private to the owner", () => {
    const dataDir = tempDataDir();
    createSnapshotStore(dataDir).write("wg-gesucht", "9000001", html("a"));
    expect(statSync(join(dataDir, "offer-pages/wg-gesucht/9000001.html.gz")).mode & 0o077).toBe(0);
    expect(statSync(join(dataDir, "offer-pages")).mode & 0o077).toBe(0);
  });

  it("replaces the page of the same Ad ID with a newer fetch and leaves no other file behind", () => {
    const dataDir = tempDataDir();
    const store = createSnapshotStore(dataDir);
    store.write("wg-gesucht", "9000001", html("a"));
    store.write("wg-gesucht", "9000001", html("b"));
    store.write("wg-gesucht", "9000002", html("c"));

    expect(store.read("wg-gesucht", "9000001")).toBe(html("b"));
    expect(store.read("wg-gesucht", "9000002")).toBe(html("c"));
    expect(readdirSync(join(dataDir, "offer-pages", "wg-gesucht")).sort()).toEqual([
      "9000001.html.gz",
      "9000002.html.gz",
    ]);
  });

  it("reads nothing for an Ad ID it never kept", () => {
    expect(createSnapshotStore(tempDataDir()).read("wg-gesucht", "1")).toBeUndefined();
  });

  it("refuses an Ad ID that could point outside its folder", () => {
    const store = createSnapshotStore(tempDataDir());
    expect(() => store.write("wg-gesucht", "../../x", html("a"))).toThrow();
    expect(() => store.write("../etc", "1", html("a"))).toThrow();
  });
});
