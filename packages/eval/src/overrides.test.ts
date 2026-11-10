import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { contentHash } from "@wg-hunt/core";
import { wgGesuchtSource } from "@wg-hunt/core/sources/wg-gesucht";
import { describe, expect, it } from "vitest";
import { loadOfferCases } from "./cases.js";
import { exportOverrides, localOffersDir, readSnapshot } from "./overrides.js";
import { renderPage } from "./synthetic-page.js";

function dataFolder(adIds: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "wg-hunt-data-"));
  for (const adId of adIds) {
    const file = join(dir, "offer-pages", "wg-gesucht", `${adId}.html.gz`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      gzipSync(
        renderPage({
          adId,
          title: "Zimmer in Beispiel-WG",
          category: "flatshare-room",
          flatmates: { code: "1w,1m,0d,0n", size: 3 },
          roomSize: 14,
          totalRent: { euros: 500 },
          sections: [["Zimmer", "Ein helles Zimmer."]],
        }),
      ),
    );
  }
  return dir;
}

function hashOf(dataDir: string, adId: string): string {
  const parsed = wgGesuchtSource.parseOffer(readSnapshot(dataDir, "wg-gesucht", adId) ?? "", {
    firstSeen: new Date(),
  });
  if (parsed.outcome !== "parsed" || parsed.status === "deleted") throw new Error("unreadable");
  return contentHash(parsed.text);
}

const override = (adId: string, key: string, value: unknown) => ({
  source: "wg-gesucht" as const,
  adId,
  key,
  value,
});

describe("exporting manual overrides as labels in the local set", () => {
  it("writes the page and a label for each corrected fact into the data folder", () => {
    const dataDir = dataFolder(["9300001"]);
    const result = exportOverrides({
      dataDir,
      overrides: [
        override("9300001", "anmeldung", "not_possible"),
        override("9300001", "minimumStay", 12),
      ],
      readPage: (source, adId) => readSnapshot(dataDir, source, adId),
    });
    expect(result.exported).toEqual(["wg-gesucht-9300001"]);
    const [offer] = loadOfferCases(localOffersDir(dataDir));
    expect(offer).toMatchObject({
      id: "wg-gesucht-9300001",
      category: "flatshare-room",
      expected: { anmeldung: "not_possible", minimumStay: 12 },
    });
    expect(offer?.html).toContain("Anzeigennummer: 9300001");
  });

  it("does not claim a language for the page: nothing reads one, and it was never looked at", () => {
    const dataDir = dataFolder(["9300001"]);
    exportOverrides({
      dataDir,
      overrides: [override("9300001", "anmeldung", "possible")],
      readPage: (source, adId) => readSnapshot(dataDir, source, adId),
    });
    const labels = JSON.parse(
      readFileSync(join(localOffersDir(dataDir), "wg-gesucht-9300001.offer.json"), "utf8"),
    );
    expect(Object.keys(labels).sort()).toEqual(["category", "expected", "note"]);
  });

  it("keeps the labels already there, and the newer correction wins", () => {
    const dataDir = dataFolder(["9300001"]);
    const readPage = (source: string, adId: string) => readSnapshot(dataDir, source, adId);
    exportOverrides({
      dataDir,
      overrides: [
        override("9300001", "anmeldung", "possible"),
        override("9300001", "minimumStay", 6),
      ],
      readPage,
    });
    exportOverrides({
      dataDir,
      overrides: [override("9300001", "anmeldung", "conditional")],
      readPage,
    });
    const [offer] = loadOfferCases(localOffersDir(dataDir));
    expect(offer?.expected).toEqual({ anmeldung: "conditional", minimumStay: 6 });
  });

  it("skips an Offer whose page is gone and says why", () => {
    const dataDir = dataFolder([]);
    const result = exportOverrides({
      dataDir,
      overrides: [override("9300002", "anmeldung", "possible")],
      readPage: (source, adId) => readSnapshot(dataDir, source, adId),
    });
    expect(result.exported).toEqual([]);
    expect(result.skipped).toEqual([
      { adId: "9300002", key: "anmeldung", reason: "its page is no longer in the data folder" },
    ]);
  });

  it("labels the page the correction was made on, not the Offer's current one", () => {
    const dataDir = dataFolder(["9300001", "9300002"]);
    const result = exportOverrides({
      dataDir,
      overrides: [
        {
          ...override("9300002", "anmeldung", "possible"),
          madeOn: { source: "wg-gesucht", adId: "9300001", textHash: hashOf(dataDir, "9300001") },
          adCount: 2,
        },
      ],
      readPage: (source, adId) => readSnapshot(dataDir, source, adId),
    });
    expect(result).toEqual({ exported: ["wg-gesucht-9300001"], skipped: [] });
  });

  it("skips and counts a correction whose page is gone, without labelling the current page", () => {
    const dataDir = dataFolder(["9300002"]);
    const result = exportOverrides({
      dataDir,
      overrides: [
        {
          ...override("9300002", "anmeldung", "possible"),
          madeOn: { source: "wg-gesucht", adId: "9300001", textHash: null },
          adCount: 2,
        },
      ],
      readPage: (source, adId) => readSnapshot(dataDir, source, adId),
    });
    expect(result).toEqual({
      exported: [],
      skipped: [
        { adId: "9300001", key: "anmeldung", reason: "its page is no longer in the data folder" },
      ],
    });
    expect(loadOfferCases(localOffersDir(dataDir))).toEqual([]);
  });

  it("labels the later of two corrections of one fact made on the same page, and counts the other", () => {
    const dataDir = dataFolder(["9300001"]);
    const madeOn = { source: "wg-gesucht" as const, adId: "9300001", textHash: null };
    const result = exportOverrides({
      dataDir,
      overrides: [
        {
          ...override("9300002", "minimumStay", 12),
          madeOn,
          createdAt: "2026-11-05T09:00:00.000Z",
        },
        {
          ...override("9300001", "minimumStay", 6),
          madeOn,
          createdAt: "2026-11-04T09:00:00.000Z",
        },
      ],
      readPage: (source, adId) => readSnapshot(dataDir, source, adId),
    });
    expect(result).toEqual({
      exported: ["wg-gesucht-9300001"],
      skipped: [
        {
          adId: "9300001",
          key: "minimumStay",
          reason: "a later correction of the same fact on the same page wins",
        },
      ],
    });
    const [offer] = loadOfferCases(localOffersDir(dataDir));
    expect(offer?.expected).toEqual({ minimumStay: 12 });
  });

  it("skips a correction whose page no longer has the words it was made on", () => {
    const dataDir = dataFolder(["9300001"]);
    const result = exportOverrides({
      dataDir,
      overrides: [
        {
          ...override("9300001", "anmeldung", "possible"),
          madeOn: { source: "wg-gesucht", adId: "9300001", textHash: "0".repeat(64) },
          adCount: 1,
        },
      ],
      readPage: (source, adId) => readSnapshot(dataDir, source, adId),
    });
    expect(result).toEqual({
      exported: [],
      skipped: [
        {
          adId: "9300001",
          key: "anmeldung",
          reason: "the stored page no longer has the words it was made on",
        },
      ],
    });
  });

  it("skips a correction of unknown page on an Offer with more than one Ad ID", () => {
    const dataDir = dataFolder(["9300001"]);
    const result = exportOverrides({
      dataDir,
      overrides: [
        { ...override("9300001", "anmeldung", "possible"), madeOn: null, adCount: 2 },
        { ...override("9300001", "minimumStay", 6), madeOn: null, adCount: 1 },
      ],
      readPage: (source, adId) => readSnapshot(dataDir, source, adId),
    });
    expect(result.exported).toEqual(["wg-gesucht-9300001"]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ adId: "9300001", key: "anmeldung" }),
    ]);
    const [offer] = loadOfferCases(localOffersDir(dataDir));
    expect(offer?.expected).toEqual({ minimumStay: 6 });
  });

  it("refuses an override of something that is not an Offer Fact", () => {
    const dataDir = dataFolder(["9300001"]);
    expect(() =>
      exportOverrides({
        dataDir,
        overrides: [override("9300001", "anmeldng", "possible")],
        readPage: (source, adId) => readSnapshot(dataDir, source, adId),
      }),
    ).toThrow(/anmeldng/);
  });

  it("refuses an Ad ID that is not plain digits, so it can never name another path", () => {
    const dataDir = dataFolder([]);
    expect(() =>
      exportOverrides({
        dataDir,
        overrides: [override("../../x", "anmeldung", "possible")],
        readPage: () => "x",
      }),
    ).toThrow(/Ad ID/);
  });
});
