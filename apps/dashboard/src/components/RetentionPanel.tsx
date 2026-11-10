import type { ApiClient } from "../api/client.js";
import { useMutation } from "../mutation.js";
import { type Offer, type OfferRetention, releasePairPins } from "../offers.js";
import { Button } from "../ui/Button.js";
import { Notice } from "../ui/status.js";

const KEPT_BECAUSE: Record<OfferRetention["keptBecause"][number], string> = {
  dismissed: "you dismissed it",
  shortlisted: "you shortlisted it",
  contacted: "you contacted them",
  "scam-mark": "your scam mark",
  "fact-override": "a fact you corrected",
  "pair-override": "a merge or split you made",
};

const day = (iso: string | null) =>
  iso === null
    ? "soon"
    : new Date(iso).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });

function list(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

function retentionText({
  state,
  keptBecause,
  recordExpiresAt,
  snapshotExpiresAt,
}: OfferRetention): string {
  const why = list(keptBecause.map((reason) => KEPT_BECAUSE[reason]));
  if (state === "not-quiet") {
    const kept = why ? ` Once it is, it is kept because of ${why}.` : "";
    return `Kept while a Search finds it and it isn't stale.${kept}`;
  }
  const pages = `Its saved pages are deleted on ${day(snapshotExpiresAt)}.`;
  if (state === "kept") return `Kept because of ${why}. ${pages}`;
  return `Deleted on ${day(recordExpiresAt)} unless it comes back. ${pages}`;
}

export function RetentionPanel({
  api,
  offer,
  onChanged,
}: {
  api: ApiClient;
  offer: Offer;
  onChanged: (offer: Offer) => void;
}) {
  const releasing = useMutation(offer.id);
  const pinned = offer.retention.keptBecause.includes("pair-override");

  function release() {
    void releasing.run(async () => {
      const result = await releasePairPins(api, offer.id);
      if (!result.ok) return result;
      onChanged(result.data);
      return { ok: true, data: undefined };
    });
  }

  return (
    <div className="od-stack">
      <p>{retentionText(offer.retention)}</p>
      {pinned && (
        <div className="od-actions">
          <Button size="sm" variant="secondary" onClick={release} disabled={releasing.busy}>
            {releasing.busy ? "Saving…" : "Let it expire"}
          </Button>
          <span className="od-muted">The merge or split stays as it is.</span>
        </div>
      )}
      {releasing.state.status === "failed" && (
        <Notice tone="alarm">Couldn't save that. {releasing.state.message}</Notice>
      )}
    </div>
  );
}
