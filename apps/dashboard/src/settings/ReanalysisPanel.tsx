import { useState } from "react";
import { type RunProgress, usd, useAnalysisState } from "../analysis.js";
import { type EndedRun, shown } from "../analysis-run.js";
import { useMutation } from "../mutation.js";
import { Button } from "../ui/Button.js";
import { Confirm } from "../ui/Confirm.js";
import { SettingRow } from "../ui/controls.js";
import { Notice } from "../ui/status.js";
import { Problem } from "./Section.js";

const offers = (n: number) => `${n} ${n === 1 ? "offer" : "offers"}`;

function outcome(run: EndedRun): string {
  switch (run.status) {
    // Nothing failed, but an Offer whose words changed or that a merge took while the run was
    // going was dropped, not read again.
    case "succeeded":
      if (run.applied === run.total)
        return `Re-analysis finished: ${offers(run.total)} read again.`;
      if (run.applied === 0)
        return "Re-analysis finished, but no offer was read again: they all changed or were merged while it ran.";
      return `Re-analysis finished: ${run.applied} of ${offers(run.total)} read again. The rest changed or were merged while it ran.`;
    case "partial":
      return "Re-analysis finished, but some ads couldn't be read. Those offers keep what they had.";
    case "failed":
      return "Re-analysis didn't work, so nothing changed. The offers keep what they had.";
    case "stopped":
      return run.stopReason === "interrupted"
        ? "Re-analysis stopped: its offers were deleted before every one was read."
        : "Re-analysis stopped: the monthly limit ran out before every offer was read. The rest keep what they had.";
    default: {
      // A status this page doesn't know yet still says something.
      const unknown: never = run.status;
      return `Re-analysis ended (${String(unknown)}).`;
    }
  }
}

function Progress({ run }: { run: Pick<RunProgress, "done" | "total"> }) {
  return (
    <p role="status" className="adv-note">
      Re-analysing: {run.done} of {offers(run.total)} done.
    </p>
  );
}

/** Nothing is re-analysed until the seeker clicks. */
export function ReanalysisPanel() {
  const { view, run: heard, retryRun, dismissRun, startRun } = useAnalysisState();
  const [asking, setAsking] = useState(false);
  const starting = useMutation(asking);

  if (view.status !== "ready") return null;
  const { spend, olderVersion: outdated, actions, activeRunId } = view.analysis;
  const run = shown(heard, activeRunId);
  const running = run.status === "following";

  async function start() {
    const result = await starting.run(startRun);
    if (result?.ok) setAsking(false);
  }

  const cost =
    outdated.estimatedCostUsd < 0.01 ? "less than $0.01" : usd(outdated.estimatedCostUsd);
  const refusedBy = actions.startRunRefusedBy;
  const blocker =
    refusedBy === "no-api-key"
      ? "Add an Anthropic API key first, under Keys."
      : refusedBy === "api-key-refused"
        ? "The Anthropic API key was refused. Replace it first, under Keys."
        : refusedBy === "spend-cap-reached"
          ? spend.state === "reached"
            ? "The monthly limit is reached, so reading is paused until next month or a higher limit."
            : spend.state === "waiting-for-in-flight"
              ? "Ads being read right now hold the rest of the monthly limit. Try again once they're done."
              : "What's left of the monthly limit doesn't cover reading one ad again in full, so this waits for next month or a higher limit."
          : undefined;

  return (
    <div className="adv-rerun">
      {run.status === "following" && run.progress && <Progress run={run.progress} />}
      {run.status === "following" && !run.progress && run.problem && (
        <Problem
          message={`Couldn't read how the re-analysis is going: ${run.problem}`}
          onRetry={retryRun}
        />
      )}
      {run.status === "ended" && (
        <Notice tone={run.outcome.status === "succeeded" ? "info" : "warn"} onDismiss={dismissRun}>
          {outcome(run.outcome)}
        </Notice>
      )}
      {!running && outdated.count > 0 && refusedBy !== "analysis-run-active" && (
        <SettingRow
          title={`${offers(outdated.count)} on an older analysis, re-analyse for about ${cost}`}
          description={blocker ?? "Half price, results within an hour"}
          control={
            <Button
              size="sm"
              variant="secondary"
              disabled={!actions.startRun}
              onClick={() => setAsking(true)}
            >
              Re-analyse
            </Button>
          }
        />
      )}
      {asking && (
        <Confirm
          question={`Re-analyse ${offers(outdated.count)}?`}
          confirmLabel="Re-analyse"
          busy={starting.busy}
          problem={starting.state.status === "failed" && starting.state.message}
          onConfirm={() => void start()}
          onCancel={() => setAsking(false)}
        >
          It costs about {cost}, counted against the monthly limit. Results come within an hour.
        </Confirm>
      )}
    </div>
  );
}
