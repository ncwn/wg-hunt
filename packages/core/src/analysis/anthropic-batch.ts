import type Anthropic from "@anthropic-ai/sdk";
import { createAnthropicClient, kindOf, messageParams, readMessage } from "./anthropic.js";
import {
  type BatchOutcome,
  type BatchProvider,
  type BatchRequest,
  ProviderError,
  type ProviderErrorKind,
} from "./provider.js";

export type BatchesClient = {
  messages: {
    batches: {
      create(
        params: Anthropic.Messages.BatchCreateParams,
      ): PromiseLike<Anthropic.Messages.MessageBatch>;
      retrieve(id: string): PromiseLike<Anthropic.Messages.MessageBatch>;
      results(
        id: string,
      ): PromiseLike<AsyncIterable<Anthropic.Messages.MessageBatchIndividualResponse>>;
      cancel(id: string): PromiseLike<Anthropic.Messages.MessageBatch>;
      /** Most recently created first. */
      list(): AsyncIterable<Anthropic.Messages.MessageBatch>;
    };
  };
};

function kindOfErrorType(type: string): ProviderErrorKind {
  switch (type) {
    case "authentication_error":
    case "permission_error":
    case "billing_error":
      return "unauthorized";
    case "rate_limit_error":
      return "rate_limited";
    case "overloaded_error":
      return "overloaded";
    case "timeout_error":
      return "timeout";
    case "invalid_request_error":
    case "not_found_error":
      return "rejected";
    default:
      return "server_error";
  }
}

function outcomeOf(response: Anthropic.Messages.MessageBatchIndividualResponse): BatchOutcome {
  const customId = response.custom_id;
  const result = response.result;
  switch (result.type) {
    case "succeeded":
      try {
        return { customId, status: "succeeded", response: readMessage(result.message) };
      } catch (error) {
        if (error instanceof ProviderError) {
          return {
            customId,
            status: "failed",
            kind: error.kind,
            ...(error.usage && { usage: error.usage }),
          };
        }
        return { customId, status: "failed", kind: "invalid_response" };
      }
    case "errored":
      return { customId, status: "failed", kind: kindOfErrorType(result.error.error.type) };
    case "expired":
      return { customId, status: "failed", kind: "expired" };
    default:
      return { customId, status: "failed", kind: "canceled" };
  }
}

export function createAnthropicBatchProvider(
  options: { apiKey: string } | { client: BatchesClient },
): BatchProvider {
  const client: BatchesClient =
    "client" in options ? options.client : createAnthropicClient(options.apiKey);

  async function call<T>(run: () => PromiseLike<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      // Anything else becomes a kind; the SDK's message (which could echo the key) is dropped.
      throw new ProviderError(kindOf(error));
    }
  }

  return {
    async submit(requests: BatchRequest[]) {
      const batch = await call(() =>
        client.messages.batches.create({
          requests: requests.map(({ customId, request }) => ({
            custom_id: customId,
            params: messageParams(request),
          })),
        }),
      );
      return { batchId: batch.id };
    },

    async status(batchId: string) {
      const batch = await call(() => client.messages.batches.retrieve(batchId));
      return { ended: batch.processing_status === "ended" };
    },

    async find({ since, requestCount, exclude }) {
      return call(async () => {
        let earliest: { id: string; createdAt: number } | undefined;
        // Newest first: stop once the batches are older than the one being looked for.
        for await (const batch of client.messages.batches.list()) {
          const createdAt = Date.parse(batch.created_at);
          if (createdAt < since) break;
          const counts = batch.request_counts;
          const total =
            counts.processing +
            counts.succeeded +
            counts.errored +
            counts.canceled +
            counts.expired;
          if (total !== requestCount || exclude.includes(batch.id)) continue;
          if (earliest === undefined || createdAt < earliest.createdAt) {
            earliest = { id: batch.id, createdAt };
          }
        }
        return earliest?.id;
      });
    },

    async cancel(batchId: string) {
      await call(() => client.messages.batches.cancel(batchId));
    },

    async results(batchId: string) {
      return call(async () => {
        const outcomes: BatchOutcome[] = [];
        for await (const response of await client.messages.batches.results(batchId)) {
          outcomes.push(outcomeOf(response));
        }
        return outcomes;
      });
    },
  };
}
