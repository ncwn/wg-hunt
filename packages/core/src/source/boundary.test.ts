import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CORE_SRC = fileURLToPath(new URL("..", import.meta.url));
const ADAPTER = join("sources", "wg-gesucht");
/** It holds no site logic. */
const SOURCE_REGISTRY = "searches.ts";

const SITE_STRINGS = /wg[-_. ]?gesucht|\bwgg_/i;

describe("the Source seam", () => {
  it("keeps every wg-gesucht string inside the adapter", () => {
    const outside = (readdirSync(CORE_SRC, { recursive: true }) as string[])
      .filter((path) => /\.(ts|json|md)$/.test(path))
      .filter((path) => !path.startsWith(ADAPTER) && path !== SOURCE_REGISTRY)
      .filter((path) => path !== relative(CORE_SRC, fileURLToPath(import.meta.url)))
      .filter((path) => SITE_STRINGS.test(readFileSync(join(CORE_SRC, path), "utf8")));
    expect(outside).toEqual([]);
  });

  it("scans something: the adapter itself does name the site", () => {
    const adapter = readFileSync(join(CORE_SRC, ADAPTER, "index.ts"), "utf8");
    expect(SITE_STRINGS.test(adapter)).toBe(true);
  });
});
