import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("the dashboard's source", () => {
  it("uses no browser select, date, time, checkbox or number control", () => {
    const root = fileURLToPath(new URL("../src/", import.meta.url));
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : path.endsWith(".tsx") ? [path] : [];
      });
    const native =
      /<select\b|type="(date|time|month|week|datetime-local|checkbox|radio|number|range)"/;
    expect(files(root).filter((path) => native.test(readFileSync(path, "utf8")))).toEqual([]);
    const bare = /<(input|textarea)\b|\btype=\{/;
    const outside = files(root).filter((path) => !path.includes("/ui/"));
    expect(outside.filter((path) => bare.test(readFileSync(path, "utf8")))).toEqual([]);
  });
});
