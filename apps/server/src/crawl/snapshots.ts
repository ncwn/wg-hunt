import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

/** Inside the data folder, never in the repository. */
export const OFFER_PAGES_DIR = "offer-pages";

export type SnapshotStore = {
  /** Only the latest page of an Ad ID is kept. */
  write(source: string, adId: string, html: string): void;
  read(source: string, adId: string): string | undefined;
  has(source: string, adId: string): boolean;
};

/** Source and Ad ID become file names, so only plain ones are accepted. */
const SAFE = /^[a-z0-9-]{1,40}$/;
const AD_ID = /^\d{1,20}$/;

export function snapshotPath(source: string, adId: string): string {
  if (!SAFE.test(source) || !AD_ID.test(adId)) throw new Error("not a plain Source or Ad ID");
  return `${OFFER_PAGES_DIR}/${source}/${adId}.html.gz`;
}

/** Raw Offer pages hold precise location data: owner-only files, compressed, in the data folder. */
export function createSnapshotStore(dataDir: string): SnapshotStore {
  return {
    write(source, adId, html) {
      const file = join(dataDir, snapshotPath(source, adId));
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      // Written beside the old copy and renamed over it, so a crash never leaves half a page.
      const temporary = `${file}.tmp`;
      writeFileSync(temporary, gzipSync(html), { mode: 0o600 });
      renameSync(temporary, file);
    },
    read(source, adId) {
      try {
        return gunzipSync(readFileSync(join(dataDir, snapshotPath(source, adId)))).toString("utf8");
      } catch {
        return undefined;
      }
    },
    has(source, adId) {
      return existsSync(join(dataDir, snapshotPath(source, adId)));
    },
  };
}
