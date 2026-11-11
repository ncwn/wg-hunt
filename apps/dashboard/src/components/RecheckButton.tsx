import type { ApiClient } from "../api/client.js";
import { ask } from "../api/result.js";
import { useMutation } from "../mutation.js";
import { type Offer, recheckPending } from "../offers.js";
import { formatWhen } from "../searches.js";
import { Button } from "../ui/Button.js";
import { Notice } from "../ui/status.js";

type Props = {
  api: ApiClient;
  offerId: number;
  canRecheck: boolean;
  /** Some Search finds the Offer, if not its current Ad ID. */
  tracked: boolean;
  recheck: Offer["recheck"];
  onQueued: () => void;
};

const notCrawled = (tracked: boolean) =>
  tracked
    ? "No Search lists this Offer's current ad, so wg-hunt doesn't crawl it"
    : "None of your Searches finds this Offer";

const QUEUED = "Queued. Rechecks go last: this one runs when nothing else is waiting.";

function RecheckNotice({ recheck }: { recheck: Offer["recheck"] }) {
  if (recheckPending(recheck)) {
    return (
      <Notice tone="info">
        {recheck.state === "in-flight" ? "Rechecking: fetching the ad's page now." : QUEUED}
      </Notice>
    );
  }
  if (recheck.state === "failed") {
    const retry =
      recheck.retryAfter === null
        ? ""
        : ` No automatic Recheck before ${formatWhen(recheck.retryAfter)}.`;
    return <Notice tone="alarm">The last Recheck got no usable page.{retry}</Notice>;
  }
  return null;
}

export function RecheckButton({ api, offerId, canRecheck, tracked, recheck, onQueued }: Props) {
  // The answer to a press stands until the Offer's own `recheck` moves on and speaks for it.
  const asking = useMutation(
    `${offerId}:${canRecheck}:${recheck.state}:${recheck.manual}:${recheck.pageFetchedAt}`,
  );

  function queue() {
    void asking.run(
      async () => {
        const result = await ask(() =>
          api.POST("/offers/{id}/recheck", { params: { path: { id: offerId } } }),
        );
        if (result.ok) onQueued();
        return result;
      },
      (data) => data.message,
    );
  }

  const answered = asking.state.status === "done" || asking.state.status === "failed";
  return (
    <>
      <Button
        size="sm"
        variant="soft"
        icon="refresh"
        onClick={queue}
        disabled={asking.busy || !canRecheck}
        title={canRecheck ? "Fetch the ad's page again" : notCrawled(tracked)}
      >
        Recheck
      </Button>
      {asking.state.status === "done" && <Notice tone="info">{asking.state.message}</Notice>}
      {asking.state.status === "failed" && <Notice tone="alarm">{asking.state.message}</Notice>}
      {!answered && <RecheckNotice recheck={recheck} />}
    </>
  );
}
