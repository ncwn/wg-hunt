import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** 32 random bytes in base64url. */
export const MIN_TOKEN_LENGTH = 43;

/** A file that is empty or too short to be one of ours is replaced rather than trusted. */
export function loadOrCreateToken(file: string): string {
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length >= MIN_TOKEN_LENGTH) return existing;
  }
  const token = generateToken();
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export type AccessToken = {
  current(): string;
  /** Nothing changes if the write fails. */
  rotate(): string;
};

export function openAccessToken(file: string): AccessToken {
  let token = loadOrCreateToken(file);
  return {
    current: () => token,
    rotate() {
      const fresh = generateToken();
      // Written beside the file and renamed over it, so a crash never leaves a half-written token.
      const pending = `${file}.new`;
      writeFileSync(pending, `${fresh}\n`, { mode: 0o600 });
      chmodSync(pending, 0o600);
      renameSync(pending, file);
      token = fresh;
      return fresh;
    },
  };
}

export function tokenMatches(expected: string, given: string): boolean {
  if (expected.length < MIN_TOKEN_LENGTH) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
