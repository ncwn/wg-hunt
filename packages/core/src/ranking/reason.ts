import type { FilterKey, Strength } from "./filters.js";

/** The bands, in the order they are shown. */
export const BANDS = ["match", "near-match", "warned", "hidden"] as const;
export type Band = (typeof BANDS)[number];

/** ✓ passes, ⚠ passes or misses on weak evidence or inside a margin, ✗ misses. */
export const OUTCOMES = ["pass", "warn", "fail"] as const;
type Outcome = (typeof OUTCOMES)[number];

export const EFFECTS = ["none", "near-match", "hidden"] as const;
export type Effect = (typeof EFFECTS)[number];

export const CAUSES = [
  "met",
  "missed",
  "within-margin",
  "unknown",
  "doubtful",
  "incomplete-costs",
  "conditional",
  "early",
  "worth-asking",
] as const;
type Cause = (typeof CAUSES)[number];

export type Reason = {
  filter: FilterKey;
  strength: Strength;
  outcome: Outcome;
  effect: Effect;
  cause: Cause;
  message: string;
  quote?: string;
};

export const CHIP_KINDS = [
  "converted-rent",
  "costs-incomplete",
  "requirement",
  "scam-caution",
] as const;
export const CHIP_TONES = ["ok", "info", "warn"] as const;
export type Chip = {
  kind: (typeof CHIP_KINDS)[number];
  tone: (typeof CHIP_TONES)[number];
  label: string;
  quote?: string;
  evidence?: string;
};

export type Check =
  | { kind: "pass"; message: string; quote?: string; doubtful?: boolean }
  | {
      kind: "miss";
      message: string;
      quote?: string;
      doubtful?: boolean;
      withinMargin?: boolean;
    }
  | { kind: "unknown"; message: string; quote?: string }
  | {
      kind: "soft";
      cause: "conditional" | "early" | "worth-asking" | "incomplete-costs";
      message: string;
      quote?: string;
    };

export function toReason(filter: FilterKey, strength: Strength, check: Check): Reason {
  const base = { filter, strength, message: check.message, ...quoted(check.quote) };
  switch (check.kind) {
    case "pass":
      return check.doubtful
        ? {
            ...base,
            outcome: "warn",
            effect: "near-match",
            cause: "doubtful",
            message: `${check.message} (the evidence is Doubtful)`,
          }
        : { ...base, outcome: "pass", effect: "none", cause: "met" };
    case "unknown":
      return { ...base, outcome: "warn", effect: "near-match", cause: "unknown" };
    case "soft":
      return { ...base, outcome: "warn", effect: "near-match", cause: check.cause };
    case "miss":
      if (check.withinMargin) {
        return { ...base, outcome: "warn", effect: "near-match", cause: "within-margin" };
      }
      if (check.doubtful) {
        const message = `${check.message} (the evidence is Doubtful)`;
        return strength === "want"
          ? { ...base, message, outcome: "fail", effect: "near-match", cause: "doubtful" }
          : { ...base, message, outcome: "warn", effect: "near-match", cause: "doubtful" };
      }
      return {
        ...base,
        outcome: "fail",
        effect: strength === "dealbreaker" ? "hidden" : "near-match",
        cause: "missed",
      };
  }
}

const quoted = (quote: string | undefined) => (quote ? { quote } : {});
