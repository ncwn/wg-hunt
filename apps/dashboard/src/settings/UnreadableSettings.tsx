import type { ApiClient } from "../api/client.js";
import type { Result } from "../api/result.js";
import type { components } from "../api/schema.js";
import { useMutation } from "../mutation.js";
import { changeLatest, type Doc, ifMatch } from "../revision.js";
import { Button } from "../ui/Button.js";
import { Notice } from "../ui/status.js";
import type { AnalysisSettings } from "./form.js";

type SettingsState = components["schemas"]["SettingsState"];

const LABELS: Record<string, string> = {
  model: "Model",
  effort: "Effort",
  escalation: "Second read when unsure",
  batchOnly: "Always read in batches",
  monthlySpendCapUsd: "Monthly limit for reading offers",
  prices: "Prices",
  "pacing.gapMinSeconds": "Shortest gap",
  "pacing.gapMaxSeconds": "Longest gap",
  "pacing.sessionSize": "Requests per session",
  "pacing.breakMinMinutes": "Shortest break",
  "pacing.breakMaxMinutes": "Longest break",
  "pacing.hourlyCap": "Most requests an hour",
  "pacing.dailyCap": "Most requests a day",
  "pacing.activeHours": "Checks from and until",
  "recheck.enabled": "Recheck bumped offers",
  "recheck.maxPageAgeHours": "Recheck pages older than",
};

export function UnreadableSettings({
  state,
  onKeep,
}: {
  state: SettingsState | undefined;
  onKeep: () => Promise<Result<undefined>>;
}) {
  const keeping = useMutation(state?.unreadable.join(","));
  if (state?.source !== "partly-unreadable") return null;
  const names = state.unreadable.map((name) => LABELS[name] ?? name).join(", ");
  return (
    <div className="settings-notices">
      <Notice tone="warn">
        Some saved settings couldn't be read and went back to their default: {names}. Check them and
        save, or keep the settings as they are now.
      </Notice>
      {keeping.state.status === "failed" && (
        <Notice tone="alarm" onDismiss={keeping.reset}>
          {keeping.state.message}
        </Notice>
      )}
      <div>
        <Button
          variant="secondary"
          size="sm"
          disabled={keeping.busy}
          onClick={() => void keeping.run(onKeep)}
        >
          Keep these settings
        </Button>
      </div>
    </div>
  );
}

/** Writes the settings back as they read now, so that they parse as saved. */
export async function keepAnalysis(
  api: ApiClient,
  stored: Doc<AnalysisSettings> | undefined,
  onSaved: (doc: Doc<AnalysisSettings>) => void,
): Promise<Result<undefined>> {
  if (!stored) return { ok: false, message: "The reading settings aren't loaded yet." };
  const written = await changeLatest({
    start: stored,
    read: () => api.GET("/settings/analysis"),
    write: (body: AnalysisSettings, revision) =>
      api.PUT("/settings/analysis", { body, params: ifMatch(revision) }),
    change: (latest) => ({ body: latest }),
  });
  if (!written.ok) return written;
  onSaved(written.data);
  return { ok: true, data: undefined };
}
