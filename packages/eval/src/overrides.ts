import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { contentHash, MODEL_FACT_KEYS, RULE_FACT_KEYS } from "@wg-hunt/core";
import { wgGesuchtSource } from "@wg-hunt/core/sources/wg-gesucht";
import { OFFER_SUFFIX } from "./cases.js";

const LOCAL_SET_DIR = "eval";

export const localSetDir = (dataDir: string) => join(dataDir, LOCAL_SET_DIR);
export const localOffersDir = (dataDir: string) => join(localSetDir(dataDir), "offers");
export const localPairsDir = (dataDir: string) => join(localSetDir(dataDir), "pairs");
export const localRunsDir = (dataDir: string) => join(localSetDir(dataDir), "runs");

type Page = { source: "wg-gesucht"; adId: string };

/**
 * A fact the seeker corrected by hand: their value is the truth a run is scored against. `source`
 * and `adId` name the Offer's current page; `madeOn` and `adCount` are absent from a file written
 * before the server recorded them, or by hand.
 */
export type ManualOverride = Page & {
  key: string;
  value: unknown;
  madeOn?: (Page & { textHash: string | null }) | null;
  adCount?: number;
  /** ISO 8601. */
  createdAt?: string;
};

/** Without both times, the one later in the list. */
const isLater = (a: ManualOverride, b: ManualOverride) =>
  a.createdAt !== undefined &&
  b.createdAt !== undefined &&
  Date.parse(a.createdAt) > Date.parse(b.createdAt);

const FACT_KEYS: readonly string[] = [...RULE_FACT_KEYS, ...MODEL_FACT_KEYS];
const AD_ID = /^\d{1,20}$/;

export function readSnapshot(dataDir: string, source: string, adId: string): string | undefined {
  if (!/^[a-z0-9-]{1,40}$/.test(source) || !AD_ID.test(adId)) return undefined;
  try {
    return gunzipSync(
      readFileSync(join(dataDir, "offer-pages", source, `${adId}.html.gz`)),
    ).toString("utf8");
  } catch {
    return undefined;
  }
}

export type ExportResult = {
  exported: string[];
  skipped: { adId: string; key: string; reason: string }[];
};

function labelledPage(override: ManualOverride): (Page & { textHash: string | null }) | string {
  const { madeOn, adCount = 1 } = override;
  if (madeOn) return madeOn;
  if (madeOn === null && adCount > 1) {
    return "it was made before wg-hunt recorded which of the Offer's Ad IDs it was made on";
  }
  return { source: override.source, adId: override.adId, textHash: null };
}

export function exportOverrides(args: {
  dataDir: string;
  overrides: readonly ManualOverride[];
  readPage: (source: string, adId: string) => string | undefined;
}): ExportResult {
  for (const { adId, key, madeOn } of args.overrides) {
    for (const id of [adId, ...(madeOn ? [madeOn.adId] : [])]) {
      if (!AD_ID.test(id)) throw new Error(`not an Ad ID: ${JSON.stringify(id)}`);
    }
    if (!FACT_KEYS.includes(key)) throw new Error(`not an Offer Fact: ${key}`);
  }

  const result: ExportResult = { exported: [], skipped: [] };
  const skip = (adId: string, overrides: { key: string }[], reason: string) => {
    for (const { key } of overrides) result.skipped.push({ adId, key, reason });
  };

  const byPage = new Map<
    string,
    { page: Page; overrides: (ManualOverride & { textHash: string | null })[] }
  >();
  for (const override of args.overrides) {
    const page = labelledPage(override);
    if (typeof page === "string") {
      skip(override.adId, [override], page);
      continue;
    }
    const id = `${page.source}-${page.adId}`;
    const entry = byPage.get(id) ?? { page, overrides: [] };
    entry.overrides.push({ ...override, textHash: page.textHash });
    byPage.set(id, entry);
  }

  const dir = localOffersDir(args.dataDir);
  for (const [id, { page, overrides }] of byPage) {
    const html = args.readPage(page.source, page.adId);
    if (html === undefined) {
      skip(page.adId, overrides, "its page is no longer in the data folder");
      continue;
    }
    const parsed = wgGesuchtSource.parseOffer(html, { firstSeen: new Date() });
    if (parsed.outcome !== "parsed" || parsed.status === "deleted") {
      skip(page.adId, overrides, "its page is not an Offer page the adapter can read");
      continue;
    }
    // A Recheck stores the page anew under the same Ad ID: it may show words edited since.
    const stored = contentHash(parsed.text);
    const edited = overrides.filter((o) => o.textHash !== null && o.textHash !== stored);
    skip(page.adId, edited, "the stored page no longer has the words it was made on");
    // A split leaves a correction on the Offer it was made on, so the Offer that took the Ad ID
    // can correct the same fact on the same page again.
    const latest = new Map<string, ManualOverride>();
    for (const o of overrides.filter((o) => !edited.includes(o))) {
      const rival = latest.get(o.key);
      const [kept, lost] = rival && isLater(rival, o) ? [rival, o] : [o, rival];
      if (lost)
        skip(page.adId, [lost], "a later correction of the same fact on the same page wins");
      latest.set(o.key, kept);
    }
    const labels = [...latest.values()];
    if (labels.length === 0) continue;

    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const labelsFile = join(dir, `${id}${OFFER_SUFFIX}`);
    const existing = existsSync(labelsFile)
      ? (JSON.parse(readFileSync(labelsFile, "utf8")) as { expected?: Record<string, unknown> })
      : {};
    const expected = { ...existing.expected };
    for (const { key, value } of labels) expected[key] = value;

    writeFileSync(join(dir, `${id}.html`), html, { mode: 0o600 });
    writeFileSync(
      labelsFile,
      `${JSON.stringify({ ...existing, category: parsed.category, note: "exported from manual overrides", expected }, null, 2)}\n`,
      { mode: 0o600 },
    );
    result.exported.push(id);
  }
  return result;
}
