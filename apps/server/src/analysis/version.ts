import { analysisVersion } from "@wg-hunt/core";
import type { AnalysisJob } from "../offers/offers.js";

export { analysisVersion };

/**
 * Unversioned results count as the current prompt at their recorded model and effort, so an
 * upgrade doesn't outdate every Offer.
 */
export function onOlderAnalysis(
  job: Pick<AnalysisJob, "state" | "stale" | "analysisVersion" | "ranWith">,
  current: string,
): boolean {
  if (job.state !== "analyzed" || job.stale || job.ranWith === null) return false;
  const stamped = job.analysisVersion ?? analysisVersion(job.ranWith);
  return stamped !== current;
}
