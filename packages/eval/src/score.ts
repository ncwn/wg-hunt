import { type CombinedFacts, type FactKey, isListFact } from "@wg-hunt/core";

export type Labels = Partial<Record<FactKey, unknown>>;

export type FactScore = {
  key: string;
  expected: unknown;
  actual: unknown;
  correct: boolean;
};

type StoredFact = { value: unknown };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function itemOf(key: string, value: unknown): unknown {
  if (key === "conflicts" && typeof value === "object" && value !== null) {
    return (value as { factKey: string }).factKey;
  }
  return value;
}

function actualItems(key: string, facts: CombinedFacts): unknown[] {
  const list = (facts as Record<string, unknown>)[key];
  if (!Array.isArray(list)) return [];
  return (list as StoredFact[])
    .filter((fact) => fact.value !== "unknown")
    .map((fact) => itemOf(key, fact.value));
}

function without(items: unknown[], others: unknown[]): unknown[] {
  const remaining = others.map(canonical);
  const result: unknown[] = [];
  for (const item of items) {
    const at = remaining.indexOf(canonical(item));
    if (at === -1) result.push(item);
    else remaining.splice(at, 1);
  }
  return result;
}

/** A gender sought is a set, so its order is not part of the answer. */
function normalized(key: string, value: unknown): unknown {
  return key === "genderSought" && Array.isArray(value) ? [...value].sort() : value;
}

/** Scores against the combined rule and model facts, which is what ranking reads. */
export function scoreFacts(labels: Labels, facts: CombinedFacts): FactScore[] {
  return Object.entries(labels).flatMap(([key, expected]) => {
    if (expected === undefined) return [];
    if (isListFact(key)) {
      const wanted = Array.isArray(expected) ? (expected as unknown[]) : [];
      const found = actualItems(key, facts);
      const correct = without(wanted, found).length + without(found, wanted).length === 0;
      return [{ key, expected, actual: found, correct }];
    }
    const fact = (facts as Record<string, StoredFact | undefined>)[key];
    const actual = fact === undefined ? "unknown" : fact.value;
    return [
      {
        key,
        expected,
        actual,
        correct: canonical(normalized(key, expected)) === canonical(normalized(key, actual)),
      },
    ];
  });
}
