import { type DoubtfulReason, type Fact, UNKNOWN } from "../offer-facts/fact.js";
import {
  applicabilityContext,
  isApplicable,
  type ModelFactsOutput,
  type RuleFactKey,
  type RuleFacts,
} from "../offer-facts/index.js";
import type { Requirement } from "../offer-facts/values.js";
import type { Category } from "../searches.js";
import type { OfferText } from "../source/source.js";
import type {
  AnalysisLogEntry,
  Anmeldung,
  Conflict,
  GenderSought,
  ModelFacts,
  ScamSignalKind,
} from "./model-facts.js";
import { findTripwires, type TripwireHit, type TripwireTopic, textPieces } from "./tripwires.js";

type Evidence = { quote: string; ambiguous: boolean; ambiguityReason: string };

const asText = (value: unknown): string => {
  const json = JSON.stringify(value) ?? "";
  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
};

function monthsBetween(from: string, to: string): number | undefined {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
  return Math.floor((b - a) / (30.44 * 24 * 3600 * 1000));
}

const stated = <T>(facts: RuleFacts, key: RuleFactKey): T | undefined => {
  const fact = facts[key] as Fact<T> | undefined;
  return fact === undefined || fact.value === UNKNOWN ? undefined : (fact.value as T);
};

function contradictedField(
  fact:
    | { fact: "requirement"; value: Requirement }
    | { fact: "minimumStay"; months: number }
    | { fact: "scam"; kind: ScamSignalKind },
  rules: RuleFacts,
): RuleFactKey | undefined {
  if (fact.fact === "requirement") {
    const { kind, value } = fact.value;
    if (kind === "smoking" && value === "non_smoker" && stated(rules, "smoking") === "anywhere") {
      return "smoking";
    }
    if (kind === "pets" && value === "no_pets" && stated(rules, "petsAllowed") === true) {
      return "petsAllowed";
    }
    return undefined;
  }
  if (fact.fact === "minimumStay") {
    const from = stated<string>(rules, "availableFrom");
    const until = stated<string>(rules, "availableUntil");
    if (from === undefined || until === undefined || until === "none") return undefined;
    const span = monthsBetween(from, until);
    // A month of slack: "available until the 30th" and "from the 1st" are about one month.
    return span !== undefined && fact.months > span + 1 ? "availableUntil" : undefined;
  }
  if (fact.kind === "deposit_over_three_months") {
    const deposit = stated<{ amount: number }>(rules, "deposit");
    const rent = stated<{ amount: number }>(rules, "baseRent");
    if (deposit && rent && rent.amount > 0 && deposit.amount <= 3 * rent.amount) return "deposit";
  }
  return undefined;
}

/** Checks every fact by rule, never by a score the model reports. */
export function readTier(args: {
  output: ModelFactsOutput;
  text: OfferText;
  ruleFacts: RuleFacts;
  category: Category;
  tier: 1 | 2;
}): { facts: ModelFacts; log: AnalysisLogEntry[] } {
  const { output, text, ruleFacts, category, tier } = args;
  const pieces = textPieces(text);
  const log: AnalysisLogEntry[] = [];
  const context = applicabilityContext(ruleFacts);
  const applies = (key: string) => isApplicable(key, category, context);

  const quoteFound = (quote: string) =>
    quote.trim() !== "" && pieces.some((piece) => piece.includes(quote));

  const recorded = new Set<string>(output.conflicts.map((conflict) => conflict.factKey));

  function build<V>(
    name: string,
    value: V | typeof UNKNOWN,
    evidence: Evidence,
    extra: { contradicts?: RuleFactKey | undefined; tripwire?: TripwireHit | undefined } = {},
  ): Fact<V> {
    const reasons: DoubtfulReason[] = [];
    const note = (reason: DoubtfulReason, quote: string) => {
      reasons.push(reason);
      log.push({
        tier,
        fact: name,
        event: reason,
        value: asText(value),
        quote,
        ...(evidence.ambiguous && reason === "model_ambiguous" && evidence.ambiguityReason !== ""
          ? { note: evidence.ambiguityReason }
          : {}),
      });
    };
    let quote = evidence.quote;
    if (value !== UNKNOWN && !quoteFound(quote)) note("quote_not_found", quote);
    if (evidence.ambiguous) note("model_ambiguous", quote);
    if (value !== UNKNOWN && extra.contradicts !== undefined && !recorded.has(extra.contradicts)) {
      note("contradicts_field", quote);
    }
    if (value === UNKNOWN && extra.tripwire !== undefined) {
      quote = extra.tripwire.quote;
      note("keyword_tripwire", quote);
    }
    return {
      value,
      origin: "text",
      quote,
      confidence: reasons.length === 0 ? { status: "confident" } : { status: "doubtful", reasons },
    };
  }

  const hits = findTripwires(pieces);
  const hit = (topic: TripwireTopic) => hits.find((candidate) => candidate.topic === topic);

  const anmeldung = build<Anmeldung>(
    "anmeldung",
    output.anmeldung.value,
    output.anmeldung,
    output.anmeldung.value === UNKNOWN ? { tripwire: hit("anmeldung") } : {},
  );

  const months = output.minimumStay.months;
  const minimumStayStated = output.minimumStay.value === "stated" && months > 0;
  const minimumStay = build<number>(
    "minimumStay",
    minimumStayStated ? months : UNKNOWN,
    output.minimumStay,
    minimumStayStated
      ? { contradicts: contradictedField({ fact: "minimumStay", months }, ruleFacts) }
      : { tripwire: hit("minimumStay") },
  );

  const scamSignals = output.scamSignals.map((signal) =>
    build<ScamSignalKind>("scamSignals", signal.kind, signal, {
      contradicts: contradictedField({ fact: "scam", kind: signal.kind }, ruleFacts),
    }),
  );
  for (const kind of ["money_before_viewing", "keys_by_post"] as const) {
    const found = hit(kind);
    if (found && !output.scamSignals.some((signal) => signal.kind === kind)) {
      scamSignals.push(
        build<ScamSignalKind>("scamSignals", UNKNOWN, sureNothing(), { tripwire: found }),
      );
    }
  }

  // Gender sought is never a conflict: the text's reading is merged with the field by rule.
  const conflicts = output.conflicts
    .filter((conflict) => conflict.factKey !== "genderSought")
    .map((conflict) =>
      build<Conflict>(
        "conflicts",
        { factKey: conflict.factKey, textValue: conflict.textValue },
        conflict,
      ),
    );

  const facts: ModelFacts = { anmeldung, minimumStay, scamSignals, conflicts };

  if (applies("requirements")) {
    const requirements = output.requirements.map((requirement) => {
      const value = normalizeRequirement(requirement);
      return build<Requirement>("requirements", value, requirement, {
        contradicts: contradictedField({ fact: "requirement", value }, ruleFacts),
      });
    });
    const diet = hit("diet");
    if (diet && !output.requirements.some((requirement) => requirement.kind === "diet")) {
      requirements.push(
        build<Requirement>("requirements", UNKNOWN, sureNothing(), { tripwire: diet }),
      );
    }
    facts.requirements = requirements;
  }

  if (applies("genderSought")) {
    const reading = output.genderSoughtFromText;
    const value: GenderSought | typeof UNKNOWN =
      reading.value === "any"
        ? "any"
        : reading.value === "only" && reading.only.length > 0
          ? [...new Set(reading.only)].sort()
          : UNKNOWN;
    facts.genderSoughtText = build<GenderSought>("genderSought", value, reading);
  }

  return { facts, log };
}

const sureNothing = (): Evidence => ({ quote: "", ambiguous: false, ambiguityReason: "" });

const DIET = new Set(["vegan", "vegetarian"]);
const OCCUPATION = new Set(["student", "working", "trainee"]);

function normalizeRequirement(requirement: {
  kind: Requirement["kind"];
  strictness: Requirement["strictness"];
  value: string;
}): Requirement {
  const { kind, strictness } = requirement;
  const value = requirement.value.trim();
  const other = { kind: "other", strictness, value } as const;
  switch (kind) {
    case "diet":
      return DIET.has(value) ? { kind, strictness, value: value as "vegan" | "vegetarian" } : other;
    case "occupation":
      return OCCUPATION.has(value)
        ? { kind, strictness, value: value as "student" | "working" | "trainee" }
        : other;
    case "smoking":
      return value === "non_smoker" ? { kind, strictness, value } : other;
    case "pets":
      return value === "no_pets" ? { kind, strictness, value } : other;
    case "language":
      return /^[a-z]{2}$/i.test(value) ? { kind, strictness, value: value.toLowerCase() } : other;
    default:
      return { kind, strictness, value };
  }
}
