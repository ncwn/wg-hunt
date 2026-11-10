import { createHash } from "node:crypto";
import { z } from "zod";
import { modelFactsOutputSchema } from "../offer-facts/index.js";
import { ANALYSIS_PREFIX, buildUserTurn } from "./prompt.js";
import type { ModelChoice } from "./provider.js";

/** Catches a change to how the user turn is built. */
const SAMPLE_USER_TURN = buildUserTurn({
  text: { title: "T", sections: [{ label: "L", text: "X" }] },
  category: "flatshare-room",
  ruleFacts: {},
});

/**
 * The escalation pass is not part of it: it only reads what the first pass doubted, so changing it
 * never makes a finished result outdated.
 */
export function analysisVersionMaterial(choice: ModelChoice): string {
  return JSON.stringify([
    ANALYSIS_PREFIX,
    SAMPLE_USER_TURN,
    z.toJSONSchema(modelFactsOutputSchema),
    choice.model,
    choice.effort,
  ]);
}

const cache = new Map<string, string>();

export function analysisVersion(choice: ModelChoice): string {
  const key = `${choice.model}\u0000${choice.effort ?? ""}`;
  let version = cache.get(key);
  if (version === undefined) {
    version = createHash("sha256")
      .update(analysisVersionMaterial(choice))
      .digest("hex")
      .slice(0, 16);
    cache.set(key, version);
  }
  return version;
}
