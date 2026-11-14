import { useSyncExternalStore } from "react";
import type { ApiClient } from "./api/client.js";

const KEY = "wg-hunt.offers.last-seen";

const listeners = new Set<() => void>();
/** The last time this page could not store (a private window, blocked or full storage). */
let unstored: number | null = null;

function stored(): number | null {
  try {
    const kept = localStorage.getItem(KEY);
    if (kept === null) return null;
    const at = Number(kept);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/**
 * The later of the stored time and the one this page set: a browser that reads but won't write
 * (storage full) would otherwise keep answering with the old time, and the click did nothing.
 */
function read(): number | null {
  const kept = stored();
  if (kept === null) return unstored;
  return unstored === null ? kept : Math.max(kept, unstored);
}

/**
 * Now by the server's clock, which made the `createdAt` and `bandChangedAt` that "new" is measured
 * against and reads `?since=`: a browser clock that runs ahead would hide rooms that came after.
 */
export async function serverNow(api: ApiClient): Promise<number> {
  try {
    const { response } = await api.GET("/offers/counts");
    const at = Date.parse(response.headers.get("Date") ?? "");
    if (Number.isFinite(at)) return at;
  } catch {
    // The browser's clock will do.
  }
  return Date.now();
}

export function markAllSeen(at: number = Date.now()): void {
  try {
    localStorage.setItem(KEY, String(at));
    unstored = null;
  } catch {
    unstored = at;
  }
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Epoch milliseconds, or null when there has been none. */
export function useLastSeen(): number | null {
  return useSyncExternalStore(subscribe, read, () => null);
}

export function isNewOffer(
  offer: { band: string; createdAt: string; bandChangedAt: string },
  lastSeen: number | null,
): boolean {
  if (offer.band === "hidden") return false;
  if (lastSeen === null) return true;
  return Math.max(Date.parse(offer.createdAt), Date.parse(offer.bandChangedAt)) > lastSeen;
}
