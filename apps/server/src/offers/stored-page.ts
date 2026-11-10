import type { Category, ParseResult, Source, SourceAdapter } from "@wg-hunt/core";
import type { SnapshotStore } from "../crawl/snapshots.js";

type Parsed = Extract<ParseResult, { outcome: "parsed" }>;

export type StoredPage =
  | { state: "missing" }
  | { state: "unreadable"; html: string }
  | { state: "deleted"; html: string; parsed: Extract<Parsed, { status: "deleted" }> }
  | { state: "readable"; html: string; parsed: Exclude<Parsed, { status: "deleted" }> };

/**
 * "Sofort" is the day this Ad ID was first seen, not its Offer's: a re-post merged into an older
 * Offer is available from its own first day, as when the crawl read it.
 */
export function readStoredPage(
  deps: {
    adapters: Record<Source, SourceAdapter>;
    snapshots: Pick<SnapshotStore, "read">;
  },
  ad: { source: Source; adId: string; firstSeenAt: Date; category?: Category | null },
  offerCategory?: Category,
): StoredPage {
  const html = deps.snapshots.read(ad.source, ad.adId);
  if (html === undefined) return { state: "missing" };
  const category = ad.category ?? offerCategory;
  const parsed = deps.adapters[ad.source].parseOffer(html, {
    firstSeen: ad.firstSeenAt,
    ...(category && { category }),
  });
  if (parsed.outcome !== "parsed") return { state: "unreadable", html };
  if (parsed.status === "deleted") return { state: "deleted", html, parsed };
  return { state: "readable", html, parsed };
}
