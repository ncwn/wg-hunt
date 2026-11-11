import { useState } from "react";
import type { Result } from "../api/result.js";
import { type Hunt, useHunt } from "../hunt-status.js";
import { useMutation } from "../mutation.js";
import { Button } from "../ui/Button.js";
import { Notice } from "../ui/status.js";

/** The design system keeps buttons out of a Notice, so Resume sits beside it. */
export function HuntAlert() {
  const { hunt, resume } = useHunt();
  if (hunt?.state !== "needs-you") return null;
  // Each alarm starts folded and with no refusal: one that comes back later is a new alarm.
  return <Alarm key={hunt.stopped?.why ?? hunt.sentence} hunt={hunt} resume={resume} />;
}

function Alarm({ hunt, resume }: { hunt: Hunt; resume: () => Promise<Result<undefined>> }) {
  const [open, setOpen] = useState(false);
  const resuming = useMutation();

  async function onResume() {
    const result = await resuming.run(resume);
    if (result && !result.ok) setOpen(true);
  }

  return (
    <div className="hunt-alert" role="alert">
      {/* biome-ignore lint/a11y/useValidAriaRole: null is Notice's prop for "no role", since the wrapper is the alert */}
      <Notice
        tone="alarm"
        role={null}
        title={hunt.stopped?.why ?? hunt.sentence}
        open={open}
        onToggle={setOpen}
      >
        {hunt.stopped && <p>{hunt.stopped.next}</p>}
        {resuming.state.status === "failed" && <p>{resuming.state.message}</p>}
      </Notice>
      {hunt.control === "resume" && (
        <Button
          variant="primary"
          className="hunt-alert-resume"
          disabled={resuming.busy}
          onClick={onResume}
        >
          Resume
        </Button>
      )}
    </div>
  );
}
