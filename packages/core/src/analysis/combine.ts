import { type Fact, UNKNOWN } from "../offer-facts/fact.js";
import {
  applicabilityContext,
  isApplicable,
  type OfferFacts,
  type RuleFactKey,
  type RuleFacts,
} from "../offer-facts/index.js";
import type { Gender } from "../offer-facts/values.js";
import type { Category } from "../searches.js";
import type { Conflict, GenderSought, ModelFacts } from "./model-facts.js";

export type CombinedFacts = Omit<OfferFacts, "category">;

const GENDERS: readonly Gender[] = ["woman", "man", "diverse"];

const gendersOf = (value: GenderSought): ReadonlySet<Gender> =>
  new Set(value === "any" ? GENDERS : value);

const isSubset = (small: ReadonlySet<Gender>, large: ReadonlySet<Gender>) =>
  [...small].every((gender) => large.has(gender));

function mergeGenderSought(
  field: Fact<GenderSought> | undefined,
  text: Fact<GenderSought> | undefined,
): Fact<GenderSought> | undefined {
  if (text === undefined || (text.value === UNKNOWN && field !== undefined)) return field;
  if (field === undefined || field.value === UNKNOWN || text.value === UNKNOWN) return text;

  const fieldSet = gendersOf(field.value);
  const textSet = gendersOf(text.value);
  const sameSet = isSubset(fieldSet, textSet) && isSubset(textSet, fieldSet);
  if (sameSet) return field;

  const asAlternative = (fact: Fact<GenderSought>) => ({
    value: fact.value as GenderSought,
    origin: fact.origin,
    quote: fact.quote,
  });
  if (isSubset(textSet, fieldSet)) {
    return { ...text, alternatives: [asAlternative(field)] };
  }
  return { ...field, alternatives: [asAlternative(text)] };
}

const MONEY_KEYS: readonly RuleFactKey[] = [
  "baseRent",
  "utilities",
  "otherCosts",
  "deposit",
  "equipmentFee",
  "warmRent",
];

/** An amount in euros from text such as `500 Euro` or `1.250,50 €`. */
function parseAmount(text: string): number | undefined {
  const digits = /\d[\d.,]*/.exec(text)?.[0]?.replace(/[.,]+$/, "");
  if (digits === undefined) return undefined;
  const normalized = digits.includes(",")
    ? digits.replaceAll(".", "").replace(",", ".")
    : /^\d{1,3}(\.\d{3})+$/.test(digits)
      ? digits.replaceAll(".", "")
      : digits;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : undefined;
}

type Money = { amount: number; converted: boolean };

function withRentAlternatives(
  rules: Record<string, unknown>,
  conflicts: Fact<Conflict>[],
): Record<string, unknown> {
  const result = { ...rules };
  for (const conflict of conflicts) {
    if (conflict.value === UNKNOWN) continue;
    const key = conflict.value.factKey;
    if (!MONEY_KEYS.includes(key)) continue;
    const fact = result[key] as Fact<Money> | undefined;
    const amount = parseAmount(conflict.value.textValue);
    if (fact === undefined || fact.value === UNKNOWN || amount === undefined) continue;
    if (amount === fact.value.amount) continue;
    result[key] = {
      ...fact,
      alternatives: [
        ...(fact.alternatives ?? []),
        { value: { amount, converted: false }, origin: "text", quote: conflict.quote },
      ],
    };
  }
  return result;
}

/** The model's facts are stored apart so a re-parse of the page never loses them. */
export function combineOfferFacts(args: {
  category: Category;
  ruleFacts: RuleFacts;
  modelFacts?: ModelFacts | undefined;
}): CombinedFacts {
  const { category, ruleFacts, modelFacts } = args;
  if (modelFacts === undefined) return { ...ruleFacts };

  const combined: Record<string, unknown> = withRentAlternatives(
    { ...ruleFacts },
    modelFacts.conflicts,
  );
  const context = applicabilityContext(ruleFacts);
  const put = (key: string, value: unknown) => {
    if (value !== undefined && isApplicable(key, category, context)) combined[key] = value;
  };
  put("anmeldung", modelFacts.anmeldung);
  put("minimumStay", modelFacts.minimumStay);
  put("requirements", modelFacts.requirements);
  put("scamSignals", modelFacts.scamSignals);
  put("conflicts", modelFacts.conflicts);
  const gender = mergeGenderSought(
    ruleFacts.genderSought as Fact<GenderSought> | undefined,
    modelFacts.genderSoughtText,
  );
  put("genderSought", gender);
  return combined as CombinedFacts;
}
