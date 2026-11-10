import type { ApiClient } from "../api/client.js";
import { useMutation } from "../mutation.js";
import { type MarksChange, type Offer, reanalyze, setMarks } from "../offers.js";
import { Button } from "../ui/Button.js";
import { Notice } from "../ui/status.js";
import { RecheckButton } from "./RecheckButton.js";

export function useMarker(api: ApiClient, offer: Offer, onMarked: (offer: Offer) => void) {
  const marking = useMutation(offer.id);

  function mark(change: MarksChange) {
    void marking.run(async () => {
      const result = await setMarks(api, offer.id, change);
      if (!result.ok) return result;
      onMarked(result.data);
      return { ok: true, data: undefined };
    });
  }

  const failure = marking.state.status === "failed" ? marking.state.message : undefined;
  return { busy: marking.busy, failure, mark };
}

export function MarkFailure({ message }: { message: string | undefined }) {
  if (!message) return null;
  return <Notice tone="alarm">Couldn't save that. {message}</Notice>;
}

export function DetailActions({
  api,
  offer,
  onRecheck,
}: {
  api: ApiClient;
  offer: Offer;
  onRecheck: () => void;
}) {
  // A refusal is about the analysis as it stood; a new state (read, failed, pending) replaces it.
  const asking = useMutation(`${offer.id}:${offer.analysis.state}`);

  function readAgain() {
    void asking.run(() => reanalyze(api, offer.id));
  }

  return (
    <div className="od-tools">
      <RecheckButton
        api={api}
        offerId={offer.id}
        canRecheck={offer.visibility.actions.recheck}
        tracked={offer.tracked}
        recheck={offer.recheck}
        onQueued={onRecheck}
      />
      <Button
        size="sm"
        variant="soft"
        icon="sparkle"
        onClick={readAgain}
        disabled={asking.busy}
        title="Read the ad again"
      >
        {asking.busy ? "Asking…" : "Re-analyse"}
      </Button>
      {asking.state.status === "failed" && <Notice tone="alarm">{asking.state.message}</Notice>}
    </div>
  );
}
