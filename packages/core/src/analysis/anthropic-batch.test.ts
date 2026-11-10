import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { messageParams } from "./anthropic.js";
import { type BatchesClient, createAnthropicBatchProvider } from "./anthropic-batch.js";
import { ANALYSIS_PREFIX } from "./prompt.js";
import { outputWith, sure } from "./testing.js";

type Message = Anthropic.Message;
type Result = Anthropic.Messages.MessageBatchResult;

const request = {
  model: "claude-haiku-5-5",
  effort: "medium" as const,
  prefix: ANALYSIS_PREFIX,
  userTurn: "Category: flatshare-room\nTitle: Zimmer",
};

const message = (body: unknown, over: Partial<Message> = {}): Message =>
  ({
    content: [{ type: "text", text: JSON.stringify(body) }],
    stop_reason: "end_turn",
    usage: {
      input_tokens: 900,
      output_tokens: 300,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 0,
    },
    ...over,
  }) as Message;

function fakeBatches(
  results: Record<string, Result> = {},
  ended = true,
  listed: Partial<Anthropic.Messages.MessageBatch>[] = [],
) {
  const created: Anthropic.Messages.BatchCreateParams[] = [];
  const canceled: string[] = [];
  const client: BatchesClient = {
    messages: {
      batches: {
        async create(params) {
          created.push(params);
          return { id: "msgbatch_1" } as Anthropic.Messages.MessageBatch;
        },
        async retrieve() {
          return {
            processing_status: ended ? "ended" : "in_progress",
          } as Anthropic.Messages.MessageBatch;
        },
        async results() {
          return (async function* () {
            for (const [custom_id, result] of Object.entries(results)) yield { custom_id, result };
          })();
        },
        async cancel(id) {
          canceled.push(id);
          return { id } as Anthropic.Messages.MessageBatch;
        },
        list() {
          return (async function* () {
            for (const batch of listed) yield batch as Anthropic.Messages.MessageBatch;
          })();
        },
      },
    },
  };
  return { client, created, canceled };
}

describe("submitting a batch", () => {
  it("sends each request exactly as the realtime call would, under its own id", async () => {
    const { client, created } = fakeBatches();

    const { batchId } = await createAnthropicBatchProvider({ client }).submit([
      { customId: "item-1", request },
      { customId: "item-2", request: { ...request, effort: "high", userTurn: "another" } },
    ]);

    expect(batchId).toBe("msgbatch_1");
    expect(created[0]?.requests.map((r) => r.custom_id)).toEqual(["item-1", "item-2"]);
    expect(created[0]?.requests[0]?.params).toEqual(messageParams(request));
    expect(created[0]?.requests[1]?.params.output_config?.effort).toBe("high");
  });

  it("fails with a kind only, never the API's message", async () => {
    const client: BatchesClient = {
      messages: {
        batches: {
          async create() {
            throw new Error("401 invalid x-api-key sk-ant-SECRET");
          },
          async retrieve() {
            throw new Error("unused");
          },
          async results() {
            throw new Error("unused");
          },
          async cancel() {
            throw new Error("unused");
          },
          list() {
            throw new Error("unused");
          },
        },
      },
    };

    const failure = await createAnthropicBatchProvider({ client })
      .submit([{ customId: "item-1", request }])
      .catch((error) => error);

    expect(failure).toMatchObject({ name: "ProviderError", kind: "server_error" });
    expect(String(failure.message)).not.toContain("SECRET");
  });
});

describe("a batch's status", () => {
  it("is ended only once the API says so", async () => {
    const running = createAnthropicBatchProvider({ client: fakeBatches({}, false).client });
    const done = createAnthropicBatchProvider({ client: fakeBatches({}, true).client });

    expect(await running.status("msgbatch_1")).toEqual({ ended: false });
    expect(await done.status("msgbatch_1")).toEqual({ ended: true });
  });
});

describe("a batch's results", () => {
  it("parses the facts and the usage of a request that succeeded", async () => {
    const output = outputWith({ anmeldung: { value: "possible", ...sure("Anmeldung möglich") } });
    const { client } = fakeBatches({ "item-1": { type: "succeeded", message: message(output) } });

    const outcomes = await createAnthropicBatchProvider({ client }).results("msgbatch_1");

    expect(outcomes).toEqual([
      {
        customId: "item-1",
        status: "succeeded",
        response: {
          output,
          usage: {
            inputTokens: 900,
            outputTokens: 300,
            cacheReadTokens: 2000,
            cacheWriteTokens: 0,
          },
        },
      },
    ]);
  });

  it("keeps the usage of a refused, cut-off or unreadable answer: it is billed", async () => {
    const { client } = fakeBatches({
      refused: {
        type: "succeeded",
        message: message(null, { stop_reason: "refusal", content: [] }),
      },
      cut: { type: "succeeded", message: message({}, { stop_reason: "max_tokens" }) },
      junk: { type: "succeeded", message: message({ anmeldung: 1 }) },
    });

    const outcomes = await createAnthropicBatchProvider({ client }).results("msgbatch_1");

    expect(outcomes.map((o) => [o.customId, o.status === "failed" && o.kind])).toEqual([
      ["refused", "refused"],
      ["cut", "truncated"],
      ["junk", "invalid_response"],
    ]);
    for (const outcome of outcomes) {
      expect(outcome.status === "failed" && outcome.usage?.outputTokens).toBe(300);
    }
  });

  it("maps an errored, expired or canceled request to a kind, with no usage", async () => {
    const error = (type: string): Result =>
      ({
        type: "errored",
        error: { type: "error", request_id: null, error: { type, message: "raw API message" } },
      }) as Result;
    const { client } = fakeBatches({
      bad: error("invalid_request_error"),
      busy: error("overloaded_error"),
      boom: error("api_error"),
      late: { type: "expired" },
      gone: { type: "canceled" },
    });

    const outcomes = await createAnthropicBatchProvider({ client }).results("msgbatch_1");

    expect(outcomes).toEqual([
      { customId: "bad", status: "failed", kind: "rejected" },
      { customId: "busy", status: "failed", kind: "overloaded" },
      { customId: "boom", status: "failed", kind: "server_error" },
      { customId: "late", status: "failed", kind: "expired" },
      { customId: "gone", status: "failed", kind: "canceled" },
    ]);
  });

  it("reads an empty batch", async () => {
    const { client } = fakeBatches({});
    expect(await createAnthropicBatchProvider({ client }).results("msgbatch_1")).toEqual([]);
  });
});

describe("finding a batch whose id was never written down", () => {
  const counts = (total: number) => ({
    processing: total,
    succeeded: 0,
    errored: 0,
    canceled: 0,
    expired: 0,
  });
  const batch = (id: string, createdAt: string, total: number) => ({
    id,
    created_at: createdAt,
    request_counts: counts(total),
  });

  it("returns the earliest batch created since then with exactly that many requests", async () => {
    const { client } = fakeBatches({}, true, [
      batch("msgbatch_new", "2026-11-04T10:05:00Z", 3),
      batch("msgbatch_other_size", "2026-11-04T10:03:00Z", 5),
      batch("msgbatch_mine", "2026-11-04T10:01:00Z", 3),
      batch("msgbatch_old", "2026-11-04T09:00:00Z", 3),
    ]);

    const found = await createAnthropicBatchProvider({ client }).find({
      since: Date.parse("2026-11-04T10:00:00Z"),
      requestCount: 3,
      exclude: [],
    });

    expect(found).toBe("msgbatch_mine");
  });

  it("skips batches that are already someone's, and says undefined when none is left", async () => {
    const { client } = fakeBatches({}, true, [batch("msgbatch_a", "2026-11-04T10:01:00Z", 2)]);
    const provider = createAnthropicBatchProvider({ client });
    const since = Date.parse("2026-11-04T10:00:00Z");

    expect(
      await provider.find({ since, requestCount: 2, exclude: ["msgbatch_a"] }),
    ).toBeUndefined();
    expect(await provider.find({ since, requestCount: 2, exclude: [] })).toBe("msgbatch_a");
  });

  it("counts a batch's requests whatever their state", async () => {
    const { client } = fakeBatches({}, true, [
      {
        id: "msgbatch_done",
        created_at: "2026-11-04T10:01:00Z",
        request_counts: { processing: 0, succeeded: 1, errored: 1, canceled: 1, expired: 0 },
      },
    ]);

    const found = await createAnthropicBatchProvider({ client }).find({
      since: 0,
      requestCount: 3,
      exclude: [],
    });

    expect(found).toBe("msgbatch_done");
  });
});

describe("cancelling a batch", () => {
  it("asks the API to cancel it", async () => {
    const { client, canceled } = fakeBatches();

    await createAnthropicBatchProvider({ client }).cancel("msgbatch_1");

    expect(canceled).toEqual(["msgbatch_1"]);
  });
});
