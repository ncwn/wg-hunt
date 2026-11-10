import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CATEGORIES,
  type Category,
  type FactKey,
  MODEL_FACT_KEYS,
  type ModelFactsOutput,
  modelFactsOutputSchema,
  RULE_FACT_KEYS,
} from "@wg-hunt/core";
import { z } from "zod";
import type { Labels } from "./score.js";

export const OFFER_SUFFIX = ".offer.json";
export const PAIR_SUFFIX = ".pair.json";

const FACT_KEYS: readonly string[] = [...RULE_FACT_KEYS, ...MODEL_FACT_KEYS];

/**
 * `expected` holds each fact as Offer Facts store it (`"possible"`, `6`, `{"min": 25}`); a fact
 * left out is not scored.
 */
const offerFile = z.object({
  /** Committed cases say so; the data folder's do not have to. */
  synthetic: z.boolean().optional(),
  note: z.string().optional(),
  language: z.enum(["de", "en"]).optional(),
  category: z.enum(CATEGORIES),
  expected: z.record(z.string(), z.unknown()),
  /** One per call; the second answers escalation. */
  replay: z.union([modelFactsOutputSchema, z.array(modelFactsOutputSchema).min(1)]).optional(),
});

export type OfferCase = {
  id: string;
  category: Category;
  html: string;
  expected: Labels;
  replay?: ModelFactsOutput[];
};

const advertiser = z.object({
  name: z.string().optional(),
  avatarUrl: z.string().optional(),
  kind: z.enum(["private", "pro", "company"]).optional(),
});

const pairSide = z.object({ page: z.string(), advertiser });

const pairFile = z.object({
  synthetic: z.boolean().optional(),
  note: z.string().optional(),
  category: z.enum(CATEGORIES),
  expected: z.enum(["duplicate", "sibling", "cloned", "apart"]),
  a: pairSide,
  b: pairSide,
});

export type PairSide = { html: string; advertiser: z.infer<typeof advertiser> };
export type PairCase = {
  id: string;
  category: Category;
  expected: z.infer<typeof pairFile>["expected"];
  a: PairSide;
  b: PairSide;
};

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
}

function fail(file: string, error: z.ZodError): never {
  const issues = error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  throw new Error(`${file}: ${issues.join("; ")}`);
}

const filesEnding = (dir: string, suffix: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(suffix))
        .sort()
    : [];

export function loadOfferCases(dir: string): OfferCase[] {
  return filesEnding(dir, OFFER_SUFFIX).map((name) => {
    const id = name.slice(0, -OFFER_SUFFIX.length);
    const file = join(dir, name);
    const parsed = offerFile.safeParse(readJson(file));
    if (!parsed.success) fail(file, parsed.error);
    const unknownKeys = Object.keys(parsed.data.expected).filter((key) => !FACT_KEYS.includes(key));
    if (unknownKeys.length > 0) {
      throw new Error(`${file}: not Offer Facts: ${unknownKeys.join(", ")}`);
    }
    const page = join(dir, `${id}.html`);
    if (!existsSync(page)) throw new Error(`${file} has no page: expected ${id}.html beside it`);
    const { replay, category, expected } = parsed.data;
    return {
      id,
      category,
      html: readFileSync(page, "utf8"),
      expected: expected as Partial<Record<FactKey, unknown>>,
      ...(replay === undefined ? {} : { replay: Array.isArray(replay) ? replay : [replay] }),
    };
  });
}

export function loadPairCases(dir: string): PairCase[] {
  return filesEnding(dir, PAIR_SUFFIX).map((name) => {
    const id = name.slice(0, -PAIR_SUFFIX.length);
    const file = join(dir, name);
    const parsed = pairFile.safeParse(readJson(file));
    if (!parsed.success) fail(file, parsed.error);
    const read = (side: z.infer<typeof pairSide>): PairSide => {
      const page = join(dir, side.page);
      if (!existsSync(page))
        throw new Error(`${file} names a page that is not there: ${side.page}`);
      return { html: readFileSync(page, "utf8"), advertiser: side.advertiser };
    };
    return {
      id,
      category: parsed.data.category,
      expected: parsed.data.expected,
      a: read(parsed.data.a),
      b: read(parsed.data.b),
    };
  });
}
