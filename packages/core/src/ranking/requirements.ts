import type { Fact } from "../offer-facts/fact.js";
import type { OfferFacts } from "../offer-facts/schema.js";
import type { Requirement } from "../offer-facts/values.js";
import type { SeekerProfile } from "./profile.js";
import { applies } from "./read.js";
import type { Check, Chip } from "./reason.js";

type Stance = "contradicted" | "satisfied" | "silent";

function profileCanContradict(profile: SeekerProfile): boolean {
  return (
    profile.diet === "omnivore" ||
    profile.diet === "vegetarian" ||
    profile.occupation !== null ||
    profile.smoker === true ||
    profile.hasPets === true ||
    profile.languages.length > 0
  );
}

function stanceOf(requirement: Requirement, profile: SeekerProfile): Stance {
  const decide = (known: boolean, ok: boolean): Stance =>
    !known ? "silent" : ok ? "satisfied" : "contradicted";
  switch (requirement.kind) {
    case "diet": {
      const { diet } = profile;
      return decide(
        diet !== null,
        requirement.value === "vegan"
          ? diet === "vegan"
          : diet === "vegan" || diet === "vegetarian",
      );
    }
    case "occupation":
      return decide(profile.occupation !== null, profile.occupation === requirement.value);
    case "smoking":
      return decide(profile.smoker !== null, profile.smoker === false);
    case "pets":
      return decide(profile.hasPets !== null, profile.hasPets === false);
    case "language":
      return decide(profile.languages.length > 0, profile.languages.includes(requirement.value));
    case "religion":
    case "other":
      return "silent";
  }
}

const DIET = { vegan: "a vegan diet", vegetarian: "a vegetarian diet" } as const;
const OCCUPATION = { student: "students", working: "working people", trainee: "trainees" } as const;

function describe(requirement: Requirement): string {
  switch (requirement.kind) {
    case "diet":
      return DIET[requirement.value];
    case "occupation":
      return OCCUPATION[requirement.value];
    case "smoking":
      return "non-smokers";
    case "pets":
      return "no pets";
    case "language":
      return `${requirement.value} spoken`;
    case "religion":
    case "other":
      return requirement.value;
  }
}

type Stated = { fact: Fact<Requirement>; requirement: Requirement; stance: Stance };

function statedRequirements(facts: OfferFacts, profile: SeekerProfile): Stated[] | null {
  if (!applies(facts, "requirements") || facts.requirements === undefined) return null;
  return (facts.requirements as Fact<Requirement>[]).flatMap((fact) =>
    fact.value === "unknown"
      ? []
      : [{ fact, requirement: fact.value, stance: stanceOf(fact.value, profile) }],
  );
}

const isDoubtful = (fact: Fact<unknown>) => fact.confidence?.status === "doubtful";

export function checkRequirements(facts: OfferFacts, profile: SeekerProfile): Check | null {
  if (!applies(facts, "requirements") || !profileCanContradict(profile)) return null;
  if (facts.requirements === undefined) {
    return { kind: "unknown", message: "The Requirements have not been read yet" };
  }
  const stated = statedRequirements(facts, profile) ?? [];
  const deciding = stated.filter(
    ({ requirement, stance }) => requirement.strictness === "required" && stance !== "silent",
  );
  const contradicted = deciding.filter(({ stance }) => stance === "contradicted");
  if (contradicted.length > 0) {
    const firm = contradicted.filter(({ fact }) => !isDoubtful(fact));
    const [shown] = firm.length > 0 ? firm : contradicted;
    return {
      kind: "miss",
      message: `The Offer requires ${describe(shown?.requirement as Requirement)}, which does not fit your profile`,
      quote: shown?.fact.quote,
      doubtful: firm.length === 0,
    };
  }
  const shaky = deciding.find(({ fact }) => isDoubtful(fact));
  if (shaky) {
    return {
      kind: "pass",
      message: `The Offer requires ${describe(shaky.requirement)}, which fits your profile`,
      quote: shaky.fact.quote,
      doubtful: true,
    };
  }
  return {
    kind: "pass",
    message:
      deciding.length > 0
        ? "No Requirement contradicts your profile"
        : "No Requirement concerns your profile",
  };
}

export function requirementChips(facts: OfferFacts, profile: SeekerProfile): Chip[] {
  return (statedRequirements(facts, profile) ?? []).map(({ fact, requirement, stance }) => ({
    kind: "requirement",
    tone: stance === "contradicted" ? "warn" : stance === "satisfied" ? "ok" : "info",
    label: `${requirement.strictness === "required" ? "Requires" : "Prefers"} ${describe(requirement)}`,
    quote: fact.quote,
  }));
}
