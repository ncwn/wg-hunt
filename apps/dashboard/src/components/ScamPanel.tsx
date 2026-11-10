import type { ApiClient } from "../api/client.js";
import type { Offer, ScamSignal } from "../offers.js";
import { Button } from "../ui/Button.js";
import { MarkFailure, useMarker } from "./OfferActions.js";

function Signal({ signal }: { signal: ScamSignal }) {
  const strong = signal.strength === "strong";
  return (
    <li className="od-signal">
      <span className={`wh-chip ${strong ? "wh-chip-fail" : "wh-chip-warn"}`}>
        {strong ? "Strong" : "Soft"}
        <span className="wh-sr">: </span>
      </span>
      <div className="od-signal-text">
        <p className="od-strong">
          {signal.message}
          {signal.doubtful && <span className="od-muted"> (doubtful)</span>}
        </p>
        {/* The quote is the Offer's page text, never markup: React renders it as text. */}
        {signal.quote && (
          <p className="od-quote">
            <span className="od-quote-label">In the ad</span>“{signal.quote}”
          </p>
        )}
        {signal.evidence && <p className="od-muted">{signal.evidence}</p>}
      </div>
    </li>
  );
}

export function ScamPanel({
  api,
  offer,
  onMarked,
}: {
  api: ApiClient;
  offer: Offer;
  onMarked: (offer: Offer) => void;
}) {
  const { scam } = offer;
  const { busy, failure, mark } = useMarker(api, offer, onMarked);
  return (
    <div className="od-stack">
      {scam.mark !== null && (
        <p className="od-strong">
          {scam.mark === "scam" ? "You marked it as a scam." : "You marked it as not a scam."}
        </p>
      )}
      <p>{scam.signals.length === 0 ? "No Scam signals were found." : scam.summary}</p>
      {scam.signals.length > 0 && (
        <ul className="od-signals">
          {scam.signals.map((signal) => (
            <Signal key={`${signal.kind}:${signal.origin}`} signal={signal} />
          ))}
        </ul>
      )}
      <div className="od-actions">
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || scam.mark === "scam"}
          onClick={() => mark({ scam: "scam" })}
        >
          Mark as scam
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || scam.mark === "not"}
          onClick={() => mark({ scam: "not" })}
        >
          Not a scam
        </Button>
        {scam.mark !== null && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => mark({ scam: "clear" })}
          >
            Clear my mark
          </Button>
        )}
      </div>
      <MarkFailure message={failure} />
    </div>
  );
}
