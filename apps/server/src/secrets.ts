import type { Db } from "./db/index.js";
import { deleteSetting, getSetting, putSetting } from "./db/settings.js";

export const SECRET_NAMES = ["anthropic"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export function isSecretName(name: string): name is SecretName {
  return (SECRET_NAMES as readonly string[]).includes(name);
}

// Secrets sit in the `settings` table of the SQLite file in the gitignored data folder.
const keyOf = (name: SecretName) => `secret:${name}`;

/** The API never returns it. */
export function readSecret(db: Db, name: SecretName): string | undefined {
  return getSetting(db, keyOf(name))?.value;
}

export function writeSecret(db: Db, name: SecretName, value: string): Date {
  return putSetting(db, keyOf(name), value);
}

export function clearSecret(db: Db, name: SecretName): void {
  deleteSetting(db, keyOf(name));
}

export type SecretHint = {
  name: SecretName;
  set: boolean;
  masked: string | null;
  updatedAt: Date | null;
};

/** The vendor prefix that is public knowledge and helps the seeker tell keys apart. */
const SHOWN_PREFIX = /^sk-ant-/;
const SHOWN_SUFFIX = 4;
/** Below this length even the last characters would give too much away. */
const MIN_LENGTH_FOR_HINT = 16;

function maskSecret(value: string): string {
  if (value.length < MIN_LENGTH_FOR_HINT) return "••••";
  const prefix = SHOWN_PREFIX.exec(value)?.[0] ?? "";
  return `${prefix}…${value.slice(-SHOWN_SUFFIX)}`;
}

export function secretHint(db: Db, name: SecretName): SecretHint {
  const row = getSetting(db, keyOf(name));
  return row
    ? { name, set: true, masked: maskSecret(row.value), updatedAt: row.updatedAt }
    : { name, set: false, masked: null, updatedAt: null };
}
