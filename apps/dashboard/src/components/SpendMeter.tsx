import { type AnalysisStatus, usd } from "../analysis.js";

/**
 * A `meter`, so a screen reader hears the amounts, not just a width; phrasing content, so it can
 * sit inside a description.
 */
export function SpendMeter({ spend }: { spend: AnalysisStatus["spend"] }) {
  // A limit of zero is spent before it starts: the bar is full.
  const max = spend.capUsd > 0 ? spend.capUsd : 1;
  const value = spend.capUsd > 0 ? Math.min(spend.spentUsd, max) : max;
  return (
    <meter
      className="spend-meter"
      data-tone={spend.state === "ok" ? "ok" : "alarm"}
      aria-label="Spend this month"
      aria-valuetext={`${usd(spend.spentUsd)} of ${usd(spend.capUsd)}`}
      min={0}
      max={max}
      value={value}
    />
  );
}
