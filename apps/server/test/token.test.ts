import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateToken, MIN_TOKEN_LENGTH, tokenMatches } from "../src/token.js";

function tokenFile() {
  return join(mkdtempSync(join(tmpdir(), "wg-hunt-token-")), "access-token");
}

describe("loadOrCreateToken", () => {
  it("generates a long token readable only by the owner, and reuses it", () => {
    const file = tokenFile();
    const token = loadOrCreateToken(file);
    expect(token.length).toBeGreaterThanOrEqual(MIN_TOKEN_LENGTH);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadOrCreateToken(file)).toBe(token);
  });

  it.each(["", "\n", "short"])("regenerates when the file holds %j", (content) => {
    const file = tokenFile();
    writeFileSync(file, content);
    const token = loadOrCreateToken(file);
    expect(token.length).toBeGreaterThanOrEqual(MIN_TOKEN_LENGTH);
    expect(readFileSync(file, "utf8").trim()).toBe(token);
  });
});

describe("tokenMatches", () => {
  it("never matches an empty expected token", () => {
    expect(tokenMatches("", "")).toBe(false);
  });
});
