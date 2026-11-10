import type { z } from "zod";
import type { Fact } from "../offer-facts/fact.js";
import type { conflictValue } from "../offer-facts/schema.js";
import type {
  anmeldungValue,
  genderSoughtValue,
  Requirement,
  scamSignalKind,
} from "../offer-facts/values.js";

export type Anmeldung = z.infer<typeof anmeldungValue>;
export type GenderSought = z.infer<typeof genderSoughtValue>;
export type ScamSignalKind = z.infer<typeof scamSignalKind>;
export type Conflict = z.infer<typeof conflictValue>;

/** The gender-sought reading is not yet merged with the structured field. */
export type ModelFacts = {
  anmeldung: Fact<Anmeldung>;
  minimumStay: Fact<number>;
  genderSoughtText?: Fact<GenderSought>;
  requirements?: Fact<Requirement>[];
  scamSignals: Fact<ScamSignalKind>[];
  conflicts: Fact<Conflict>[];
};

/** Kept with the Offer, never in a console log: it holds Offer text. */
export type AnalysisLogEntry = {
  /** 1 for the model pass, 2 for the escalation pass. */
  tier: 1 | 2;
  fact: string;
  /** A Doubtful reason, or `set_unknown` when a quote that was never found turned a value unknown. */
  event: string;
  value: string;
  quote: string;
  note?: string;
};
