import type { Offer } from "../offers.js";
import { type Reason, ReasonList } from "../ui/offers.js";

const OUTCOME = { ok: "pass", warn: "warn", info: "warn" } as const;

/**
 * Only what the ad asks of whoever moves in: the ranking's other chips are already shown elsewhere
 * on the card.
 */
export function OfferChips({ offer }: { offer: Offer }) {
  const reasons: Reason[] = offer.chips
    .filter((chip) => chip.kind === "requirement")
    .map((chip) => ({
      outcome: OUTCOME[chip.tone],
      text: chip.label,
      ...(chip.quote ? { quote: chip.quote } : {}),
    }));
  if (reasons.length === 0) return null;
  return (
    <div className="od-asks">
      <p className="od-label">The ad asks for</p>
      <ReasonList reasons={reasons} label="The ad asks for" />
    </div>
  );
}
