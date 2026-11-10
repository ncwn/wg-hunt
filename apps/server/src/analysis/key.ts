import { createHash } from "node:crypto";
import { type AnalysisProvider, type BatchProvider, ProviderError, policyOf } from "@wg-hunt/core";
import type { Db } from "../db/index.js";
import { deleteSetting, getSetting, putSetting } from "../db/settings.js";
import { readSecret } from "../secrets.js";

export type KeyState = "absent" | "present" | "refused";

const REFUSED = "analysis.keyRefused";

/** Tells keys apart without storing a copy, so a new key is never taken for a refused one. */
const fingerprintOf = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);

export function keyState(db: Db): KeyState {
  const key = readSecret(db, "anthropic");
  if (key === undefined) return "absent";
  return getSetting(db, REFUSED)?.value === fingerprintOf(key) ? "refused" : "present";
}

export function noteKeyRefused(db: Db, key: string, now: Date): void {
  putSetting(db, REFUSED, fingerprintOf(key), now);
}

/** The refused key included: saving it again means try it again. */
export function noteKeySaved(db: Db): void {
  if (getSetting(db, REFUSED) !== undefined) deleteSetting(db, REFUSED);
}

function noteKeyAccepted(db: Db, key: string): void {
  if (getSetting(db, REFUSED)?.value === fingerprintOf(key)) deleteSetting(db, REFUSED);
}

export type KeyAt = {
  db: Db;
  key: string;
  now: () => Date;
  changed?: () => void;
};

/**
 * A call that resolves, or fails with an answer from the model, went through with the key.
 * Every other failure says nothing sure about the key and changes nothing.
 */
async function reporting<T>(at: KeyAt, call: () => Promise<T>): Promise<T> {
  // Read at the note, not when the call began: another call may have changed the key meanwhile.
  const note = (write: () => void) => {
    const before = keyState(at.db);
    write();
    if (keyState(at.db) !== before) at.changed?.();
  };
  try {
    const result = await call();
    note(() => noteKeyAccepted(at.db, at.key));
    return result;
  } catch (error) {
    if (error instanceof ProviderError) {
      if (error.kind === "unauthorized") note(() => noteKeyRefused(at.db, at.key, at.now()));
      else if (policyOf(error.kind).billed === "yes") note(() => noteKeyAccepted(at.db, at.key));
    }
    throw error;
  }
}

export function keyReporting(inner: AnalysisProvider, at: KeyAt): AnalysisProvider {
  return { analyse: (request) => reporting(at, () => inner.analyse(request)) };
}

/** Every method is named, not spread, so a method added to the interface must be reported too. */
export function keyReportingBatch(inner: BatchProvider, at: KeyAt): BatchProvider {
  return {
    submit: (requests) => reporting(at, () => inner.submit(requests)),
    status: (batchId) => reporting(at, () => inner.status(batchId)),
    results: (batchId) => reporting(at, () => inner.results(batchId)),
    find: (args) => reporting(at, () => inner.find(args)),
    cancel: (batchId) => reporting(at, () => inner.cancel(batchId)),
  };
}
