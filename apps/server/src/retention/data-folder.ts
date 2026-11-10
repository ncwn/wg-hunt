import { type Dirent, lstatSync, readdirSync, statfsSync, unlinkSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Everything wg-hunt deletes, it deletes inside the data folder. Names come from walking the
 * folder (never from the database or a request), they are checked to lie inside it, and symbolic
 * links are never followed: a link is left alone, so nothing outside the folder can be reached
 * through one.
 */

export function safeJoin(root: string, relativePath: string): string {
  if (relativePath.includes("\0") || isAbsolute(relativePath)) {
    throw new Error("not a path inside the data folder");
  }
  const base = resolve(root);
  const full = resolve(base, relativePath);
  const inside = relative(base, full);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error("not a path inside the data folder");
  }
  return full;
}

export type FolderFile = {
  /** Relative to the data folder, with `/` separators. */
  path: string;
  bytes: number;
  mtimeMs: number;
};

export function listFiles(dataDir: string, folder: string): FolderFile[] {
  const files: FolderFile[] = [];
  const walk = (relativeDir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(safeJoin(dataDir, relativeDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        try {
          const stat = lstatSync(safeJoin(dataDir, path));
          files.push({ path, bytes: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          // Gone since it was listed.
        }
      }
    }
  };
  try {
    if (!lstatSync(safeJoin(dataDir, folder)).isDirectory()) return files;
  } catch {
    return files;
  }
  walk(folder);
  return files;
}

/** True when it was there. */
export function removeFile(dataDir: string, path: string): boolean {
  try {
    const full = safeJoin(dataDir, path);
    if (!lstatSync(full).isFile()) return false;
    unlinkSync(full);
    return true;
  } catch {
    return false;
  }
}

export function freeDiskBytes(dataDir: string): number | null {
  try {
    const stats = statfsSync(dataDir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

export const sumBytes = (files: readonly { bytes: number }[]) =>
  files.reduce((total, file) => total + file.bytes, 0);
