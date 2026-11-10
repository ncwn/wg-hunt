import type { PageFailureKind, Source, SourceAdapter } from "@wg-hunt/core";
import type { SnapshotStore } from "../crawl/snapshots.js";
import type { AnalysisJob } from "../offers/offers.js";
import { readStoredPage } from "../offers/stored-page.js";

export function createOfferReader(deps: {
  adapters: Record<Source, SourceAdapter>;
  snapshots: Pick<SnapshotStore, "read">;
}) {
  return {
    read(job: AnalysisJob) {
      const page = readStoredPage(
        deps,
        {
          source: job.source,
          adId: job.adId,
          firstSeenAt: job.adFirstSeenAt,
          category: job.adCategory,
        },
        job.category,
      );
      if (page.state === "missing") return "no_stored_page" as const satisfies PageFailureKind;
      if (page.state !== "readable") return "unreadable_page" as const satisfies PageFailureKind;
      return page.parsed;
    },
  };
}

export type OfferReader = ReturnType<typeof createOfferReader>;
