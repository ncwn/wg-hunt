import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { safeJoin } from "../retention/data-folder.js";
import type { JobKind } from "./constants.js";

export const UNEXPECTED_PAGES_DIR = "unexpected-pages";

export function createRawPageStore(dataDir: string) {
  return (page: { at: number; kind: JobKind; path: string; body: string }): string => {
    const dir = join(dataDir, UNEXPECTED_PAGES_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date(page.at).toISOString().replace(/[:.]/g, "-");
    const name = `${stamp}-${page.kind}.html.gz`;
    writeFileSync(join(dir, name), gzipSync(page.body), { mode: 0o600 });
    return `${UNEXPECTED_PAGES_DIR}/${name}`;
  };
}

export function createRawPageCheck(dataDir: string) {
  return (savedAs: string): boolean => {
    try {
      return existsSync(safeJoin(dataDir, savedAs));
    } catch {
      return false;
    }
  };
}
