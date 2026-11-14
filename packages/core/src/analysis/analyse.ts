import type { RuleFacts } from "../offer-facts/index.js";
import type { Category } from "../searches.js";
import type { OfferText } from "../source/source.js";
import { hasDoubtful, mergeTiers, settle } from "./merge-tiers.js";
import type { AnalysisLogEntry, ModelFacts } from "./model-facts.js";
import { ANALYSIS_PREFIX, buildUserTurn } from "./prompt.js";
import {
  type AnalysisProvider,
  type AnalysisRequest,
  type AnalysisResponse,
  type ModelChoice,
  ProviderError,
  type TokenUsage,
} from "./provider.js";
import { readTier } from "./read-tier.js";

const MAX_RETRIES = 3;
const BACKOFF_MS = 1000;

export type AnalysisResult = {
  facts: ModelFacts;
  escalated: boolean;
  log: AnalysisLogEntry[];
  calls: { tier: 1 | 2; model: string; effort: ModelChoice["effort"]; usage: TokenUsage }[];
};

export type AnalyseOfferArgs = {
  provider: AnalysisProvider;
  text: OfferText;
  category: Category;
  ruleFacts: RuleFacts;
  model: ModelChoice;
  /** `null`: off. */
  escalation: ModelChoice | null;
  sleep?: (ms: number) => Promise<void>;
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function callWithRetry(
  provider: AnalysisProvider,
  request: AnalysisRequest,
  sleep: (ms: number) => Promise<void>,
): Promise<AnalysisResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await provider.analyse(request);
    } catch (error) {
      // Anything that is not a ProviderError is a bug in the provider; it may still be transient.
      const failure = error instanceof ProviderError ? error : new ProviderError("server_error");
      if (!failure.retryable || attempt >= MAX_RETRIES) throw failure;
      await sleep(BACKOFF_MS * 2 ** attempt);
    }
  }
}

export type StepArgs = Pick<
  AnalyseOfferArgs,
  "text" | "category" | "ruleFacts" | "model" | "escalation"
>;

export function firstRequest(args: StepArgs): AnalysisRequest {
  const { text, category, ruleFacts, model } = args;
  return {
    ...model,
    prefix: ANALYSIS_PREFIX,
    userTurn: buildUserTurn({ text, category, ruleFacts }),
  };
}

export function escalationRequest(args: StepArgs): AnalysisRequest {
  if (args.escalation === null) throw new Error("escalation is off");
  return { ...firstRequest(args), ...args.escalation };
}

/** Plain JSON, so a batch can keep it in the database while it waits. */
export type EscalationState = {
  /** The first pass's facts as read, before the last-pass settling. */
  first: ModelFacts;
  log: AnalysisLogEntry[];
  calls: AnalysisResult["calls"];
};

export type FirstStep =
  | { kind: "done"; result: AnalysisResult }
  | {
      kind: "escalate";
      request: AnalysisRequest;
      provisional: AnalysisResult;
      state: EscalationState;
    };

export function readFirst(args: StepArgs, response: AnalysisResponse): FirstStep {
  const { text, category, ruleFacts, model, escalation } = args;
  const read = readTier({ output: response.output, text, ruleFacts, category, tier: 1 });
  const calls: AnalysisResult["calls"] = [{ tier: 1, ...model, usage: response.usage }];
  const settled = settle(read.facts, 1);
  const result: AnalysisResult = {
    facts: settled.facts,
    escalated: false,
    log: [...read.log, ...settled.log],
    calls,
  };
  if (escalation === null || !hasDoubtful(read.facts)) return { kind: "done", result };
  return {
    kind: "escalate",
    request: escalationRequest(args),
    provisional: result,
    state: { first: read.facts, log: read.log, calls },
  };
}

export function readSecond(
  args: StepArgs,
  state: EscalationState,
  response: AnalysisResponse,
): AnalysisResult {
  const { text, category, ruleFacts, escalation } = args;
  if (escalation === null) throw new Error("escalation is off");
  const read = readTier({ output: response.output, text, ruleFacts, category, tier: 2 });
  const merged = mergeTiers(state.first, read.facts);
  const settled = settle(merged.facts, 2);
  return {
    facts: settled.facts,
    escalated: true,
    log: [...state.log, ...read.log, ...merged.log, ...settled.log],
    calls: [...state.calls, { tier: 2, ...escalation, usage: response.usage }],
  };
}

export async function analyseOffer(args: AnalyseOfferArgs): Promise<AnalysisResult> {
  const sleep = args.sleep ?? wait;
  const first = await callWithRetry(args.provider, firstRequest(args), sleep);
  const step = readFirst(args, first);
  if (step.kind === "done") return step.result;
  const second = await callWithRetry(args.provider, step.request, sleep);
  return readSecond(args, step.state, second);
}
