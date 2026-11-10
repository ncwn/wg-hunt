import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { modelFactsOutputSchema } from "../offer-facts/index.js";
import {
  type AnalysisProvider,
  type AnalysisRequest,
  type AnalysisResponse,
  MAX_OUTPUT_TOKENS,
  ProviderError,
  type ProviderErrorKind,
  type TokenUsage,
} from "./provider.js";

export type MessagesClient = {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): PromiseLike<Anthropic.Message>;
  };
};

const TIMEOUT_MS = 120_000;

/**
 * The SDK's own retries are off: wg-hunt counts its attempts itself, so a failing call is tried
 * exactly 1 + 3 times, not three times as many.
 */
export function createAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, maxRetries: 0, timeout: TIMEOUT_MS });
}

export function kindOf(error: unknown): ProviderErrorKind {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (error instanceof Anthropic.APIConnectionError) return "network";
  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    if (status === 401 || status === 403) return "unauthorized";
    if (status === 429) return "rate_limited";
    if (status === 529) return "overloaded";
    if (status === 408 || status === 409) return "server_error";
    if (typeof status === "number" && status >= 500) return "server_error";
    if (typeof status === "number" && status >= 400) return "rejected";
  }
  return "server_error";
}

const format = zodOutputFormat(modelFactsOutputSchema);

/**
 * Realtime and batch requests both send this, so a batch reads an Offer as a realtime call would.
 * Thinking tokens count toward `max_tokens`, so it leaves room for the model to think at a high
 * effort and still finish the JSON: a response cut off there is `truncated`.
 */
export function messageParams(request: AnalysisRequest): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: request.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: [{ type: "text", text: request.prefix, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: request.userTurn }],
    output_config: {
      ...(request.effort === null ? {} : { effort: request.effort }),
      format,
    },
  };
}

function usageOf(message: Pick<Anthropic.Message, "usage">): TokenUsage {
  const usage = message.usage;
  const thinking = usage.output_tokens_details?.thinking_tokens;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    ...(typeof thinking === "number" && { thinkingTokens: thinking }),
  };
}

export function readMessage(message: Anthropic.Message): AnalysisResponse {
  const usage = usageOf(message);
  if (message.stop_reason === "refusal") throw new ProviderError("refused", usage);
  if (message.stop_reason === "max_tokens") throw new ProviderError("truncated", usage);

  // A response can start with thinking blocks: read the text by type, not by position.
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderError("invalid_response", usage);
  }
  const output = modelFactsOutputSchema.safeParse(parsed);
  if (!output.success) throw new ProviderError("invalid_response", usage);
  return { output: output.data, usage };
}

/**
 * Text only, no sampling parameters and no prefill. Errors carry only a kind: the SDK's own
 * message is dropped, so neither a key nor Offer text can leak through it.
 */
export function createAnthropicProvider(
  options: { apiKey: string } | { client: MessagesClient },
): AnalysisProvider {
  const client = "client" in options ? options.client : createAnthropicClient(options.apiKey);

  return {
    async analyse(request: AnalysisRequest): Promise<AnalysisResponse> {
      let message: Anthropic.Message;
      try {
        message = await client.messages.create(messageParams(request));
      } catch (error) {
        throw new ProviderError(kindOf(error));
      }
      return readMessage(message);
    },
  };
}
