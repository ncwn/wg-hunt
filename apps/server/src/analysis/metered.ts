import { type AnalysisProvider, ProviderError, policyOf } from "@wg-hunt/core";
import type { SpendLedger } from "./spend.js";

/**
 * Refused and cut-off answers are billed too. A failure whose kind may have been billed with no
 * usage to read (a timeout, a lost connection) counts its reservation as spent, not released.
 */
export function meteredProvider(inner: AnalysisProvider, ledger: SpendLedger): AnalysisProvider {
  return {
    async analyse(request) {
      const worst = ledger.estimateMicros(request, { batch: false });
      // A model the price table does not know cannot be held to the cap, so it is not called.
      if (worst === undefined) throw new ProviderError("unpriced");
      const hold = ledger.reserve(worst);
      if (hold === undefined) {
        ledger.sync();
        throw new ProviderError("spend_cap_reached");
      }
      try {
        const response = await inner.analyse(request);
        ledger.record({
          model: request.model,
          effort: request.effort,
          batch: false,
          usage: response.usage,
        });
        return response;
      } catch (error) {
        if (error instanceof ProviderError && error.usage !== undefined) {
          ledger.record({
            model: request.model,
            effort: request.effort,
            batch: false,
            usage: error.usage,
          });
        } else if (!(error instanceof ProviderError) || policyOf(error.kind).billed === "unknown") {
          ledger.recordUnconfirmed(worst);
        }
        throw error;
      } finally {
        hold.release();
      }
    },
  };
}
