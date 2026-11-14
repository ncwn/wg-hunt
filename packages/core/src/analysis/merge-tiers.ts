import { type Confidence, type DoubtfulReason, type Fact, UNKNOWN } from "../offer-facts/fact.js";
import type { Requirement } from "../offer-facts/values.js";
import type { AnalysisLogEntry, ModelFacts } from "./model-facts.js";

const isDoubtful = (fact: Fact<unknown>): boolean => fact.confidence?.status === "doubtful";

export function hasDoubtful(facts: ModelFacts): boolean {
  return allFacts(facts).some(([, fact]) => isDoubtful(fact));
}

function allFacts(facts: ModelFacts): [string, Fact<unknown>][] {
  const named = (name: string, list: Fact<unknown>[]): [string, Fact<unknown>][] =>
    list.map((fact) => [name, fact]);
  return [
    ...named("anmeldung", [facts.anmeldung]),
    ...named("minimumStay", [facts.minimumStay]),
    ...named("genderSought", facts.genderSoughtText ? [facts.genderSoughtText] : []),
    ...named("requirements", facts.requirements ?? []),
    ...named("scamSignals", facts.scamSignals),
    ...named("conflicts", facts.conflicts),
  ];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const reasonsOf = (fact: Fact<unknown>): DoubtfulReason[] =>
  fact.confidence?.status === "doubtful" ? fact.confidence.reasons : [];

function doubtful(reasons: DoubtfulReason[]): Confidence {
  return {
    status: "doubtful",
    reasons: [...new Set(reasons)] as [DoubtfulReason, ...DoubtfulReason[]],
  };
}

function mergeFact<V>(
  name: string,
  first: Fact<V>,
  second: Fact<V>,
  log: AnalysisLogEntry[],
): Fact<V> {
  if (first.confidence?.status !== "confident" || same(first.value, second.value)) return second;
  log.push({
    tier: 2,
    fact: name,
    event: "tiers_disagree",
    value: JSON.stringify(first.value) ?? "",
    quote: first.quote,
    note: "the first pass read a different value",
  });
  return { ...second, confidence: doubtful([...reasonsOf(second), "tiers_disagree"]) };
}

function mergeList<V>(
  name: string,
  first: Fact<V>[],
  second: Fact<V>[],
  keyOf: (fact: Fact<V>) => string,
  log: AnalysisLogEntry[],
): Fact<V>[] {
  const firstByKey = new Map(first.map((fact) => [keyOf(fact), fact]));
  const merged = second.map((fact) => {
    const before = firstByKey.get(keyOf(fact));
    firstByKey.delete(keyOf(fact));
    return before === undefined ? fact : mergeFact(name, before, fact, log);
  });
  for (const lost of firstByKey.values()) {
    if (isDoubtful(lost)) continue;
    log.push({
      tier: 2,
      fact: name,
      event: "tiers_disagree",
      value: JSON.stringify(lost.value) ?? "",
      quote: lost.quote,
      note: "the escalation pass did not find it",
    });
    merged.push({ ...lost, confidence: doubtful(["tiers_disagree"]) });
  }
  return merged;
}

const requirementKey = (fact: Fact<Requirement>) => {
  const value = fact.value;
  return value === UNKNOWN ? `unknown:${fact.quote}` : `${value.kind}:${value.value}`;
};

export function mergeTiers(
  first: ModelFacts,
  second: ModelFacts,
): { facts: ModelFacts; log: AnalysisLogEntry[] } {
  const log: AnalysisLogEntry[] = [];
  const facts: ModelFacts = {
    anmeldung: mergeFact("anmeldung", first.anmeldung, second.anmeldung, log),
    minimumStay: mergeFact("minimumStay", first.minimumStay, second.minimumStay, log),
    scamSignals: mergeList(
      "scamSignals",
      first.scamSignals,
      second.scamSignals,
      (fact) => `${String(fact.value)}`,
      log,
    ),
    conflicts: mergeList(
      "conflicts",
      first.conflicts,
      second.conflicts,
      (fact) => (fact.value === UNKNOWN ? "unknown" : fact.value.factKey),
      log,
    ),
  };
  if (second.genderSoughtText) {
    facts.genderSoughtText = first.genderSoughtText
      ? mergeFact("genderSought", first.genderSoughtText, second.genderSoughtText, log)
      : second.genderSoughtText;
  }
  if (second.requirements) {
    facts.requirements = mergeList(
      "requirements",
      first.requirements ?? [],
      second.requirements,
      requirementKey,
      log,
    );
  }
  return { facts, log };
}

export function settle(
  facts: ModelFacts,
  tier: 1 | 2,
): { facts: ModelFacts; log: AnalysisLogEntry[] } {
  const log: AnalysisLogEntry[] = [];
  const settleFact = <V>(name: string, fact: Fact<V>): Fact<V> => {
    if (!reasonsOf(fact).includes("quote_not_found") || fact.value === UNKNOWN) return fact;
    log.push({
      tier,
      fact: name,
      event: "set_unknown",
      value: JSON.stringify(fact.value) ?? "",
      quote: fact.quote,
    });
    return { ...fact, value: UNKNOWN, quote: "" };
  };
  const settled: ModelFacts = {
    anmeldung: settleFact("anmeldung", facts.anmeldung),
    minimumStay: settleFact("minimumStay", facts.minimumStay),
    scamSignals: facts.scamSignals.map((fact) => settleFact("scamSignals", fact)),
    conflicts: facts.conflicts.map((fact) => settleFact("conflicts", fact)),
  };
  if (facts.genderSoughtText) {
    settled.genderSoughtText = settleFact("genderSought", facts.genderSoughtText);
  }
  if (facts.requirements) {
    settled.requirements = facts.requirements.map((fact) => settleFact("requirements", fact));
  }
  return { facts: settled, log };
}
