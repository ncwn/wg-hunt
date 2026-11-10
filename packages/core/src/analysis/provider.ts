import type { ModelFactsOutput } from "../offer-facts/index.js";
import { ERROR_KINDS } from "./error-kinds.js";

/** Which of these a given model takes is the price table's business. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** `effort` is null for a model that takes no effort. */
export type ModelChoice = { model: string; effort: Effort | null };

/** Thinking included. It is what a request can cost at worst, which the spend cap reserves. */
export const MAX_OUTPUT_TOKENS = 16_000;

export type AnalysisRequest = ModelChoice & {
  prefix: string;
  userTurn: string;
};

export type TokenUsage = {
  /** Input tokens that were neither read from nor written to the cache. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Informational, when the API says: already billed in `outputTokens`. */
  thinkingTokens?: number;
};

export type AnalysisResponse = { output: ModelFactsOutput; usage: TokenUsage };

export type BatchRequest = { customId: string; request: AnalysisRequest };

export type BatchOutcome =
  | { customId: string; status: "succeeded"; response: AnalysisResponse }
  | {
      customId: string;
      status: "failed";
      kind: ProviderErrorKind;
      usage?: TokenUsage;
    };

/**
 * Results come in any order and are matched by `customId`. Throws `ProviderError` for anything
 * that went wrong with the batch as a whole.
 */
export interface BatchProvider {
  submit(requests: BatchRequest[]): Promise<{ batchId: string }>;
  status(batchId: string): Promise<{ ended: boolean }>;
  results(batchId: string): Promise<BatchOutcome[]>;
  /**
   * For a batch created without its id being written down (a request that timed out, a process
   * that stopped). `since` is epoch ms; the earliest such batch wins.
   */
  find(args: {
    since: number;
    requestCount: number;
    exclude: string[];
  }): Promise<string | undefined>;
  /** Requests the batch already finished are kept and billed; the rest end as canceled. */
  cancel(batchId: string): Promise<void>;
}

/**
 * A provider throws `ProviderError` for anything that went wrong and never returns a partial
 * answer.
 */
export interface AnalysisProvider {
  analyse(request: AnalysisRequest): Promise<AnalysisResponse>;
}

/** Never carries the Offer's text or a credential. */
export const PROVIDER_ERROR_KINDS = [
  "rate_limited",
  "overloaded",
  "server_error",
  "network",
  "timeout",
  "invalid_response",
  "refused",
  "truncated",
  "unauthorized",
  "rejected",
  /** The model is not in the price table, so the call can't be held to the spend cap and isn't made. */
  "unpriced",
  /** A batch request that was not processed within 24 hours. */
  "expired",
  "canceled",
  /** The monthly spend cap stopped the call before it was sent. */
  "spend_cap_reached",
] as const;
export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    /** Set when the API answered: a refusal or a cut-off is billed. */
    readonly usage?: TokenUsage,
  ) {
    // The message is only the kind: a provider never lets a raw API message through.
    super(kind);
    this.name = "ProviderError";
  }

  get retryable(): boolean {
    return ERROR_KINDS[this.kind].retryInCall;
  }
}
