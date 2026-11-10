import { useAnalysisState } from "../analysis.js";
import { Problem } from "./Section.js";

export function ReadingProblem() {
  const { view, refresh } = useAnalysisState();
  if (view.status !== "failed") return null;
  return (
    <div className="settings-notices">
      <Problem message={`Couldn't load the reading status: ${view.message}`} onRetry={refresh} />
    </div>
  );
}
