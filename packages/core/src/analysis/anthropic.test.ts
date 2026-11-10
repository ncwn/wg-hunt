import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  createAnthropicClient,
  createAnthropicProvider,
  type MessagesClient,
} from "./anthropic.js";
import { ANALYSIS_PREFIX } from "./prompt.js";
import { MAX_OUTPUT_TOKENS, ProviderError } from "./provider.js";
import { emptyOutput, outputWith, sure } from "./testing.js";

type Params = Parameters<MessagesClient["messages"]["create"]>[0];
type Reply = Anthropic.Message;

const usage = {
  input_tokens: 900,
  output_tokens: 300,
  cache_read_input_tokens: 2000,
  cache_creation_input_tokens: 0,
};

const reply = (body: unknown, over: Partial<Reply> = {}): Reply =>
  ({
    content: [{ type: "text", text: JSON.stringify(body) }],
    stop_reason: "end_turn",
    usage,
    ...over,
  }) as Reply;

function fakeClient(answer: (params: Params) => Reply | Promise<Reply>) {
  const sent: Params[] = [];
  const client: MessagesClient = {
    messages: {
      async create(params) {
        sent.push(params);
        return answer(params);
      },
    },
  };
  return { client, sent };
}

const request = {
  model: "claude-haiku-5-5",
  effort: "medium" as const,
  prefix: ANALYSIS_PREFIX,
  userTurn: "Category: flatshare-room\nTitle: Zimmer",
};

describe("the Anthropic provider's request", () => {
  it("is one text turn with structured output, the effort and a cached prefix", async () => {
    const { client, sent } = fakeClient(() => reply(emptyOutput()));

    await createAnthropicProvider({ client }).analyse(request);

    const params = sent[0];
    expect(params).toMatchObject({
      model: "claude-haiku-5-5",
      output_config: { effort: "medium", format: { type: "json_schema" } },
      system: [{ type: "text", text: ANALYSIS_PREFIX, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: request.userTurn }],
    });
    expect(JSON.stringify(params?.messages)).not.toContain('"image"');
    expect(params?.messages.at(-1)?.role).toBe("user");
  });

  it("sets no sampling parameter and no thinking budget", async () => {
    const { client, sent } = fakeClient(() => reply(emptyOutput()));

    await createAnthropicProvider({ client }).analyse(request);

    const keys = Object.keys(sent[0] ?? {});
    for (const forbidden of ["temperature", "top_p", "top_k", "thinking", "tools", "tool_choice"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("leaves effort out for a model that takes none", async () => {
    const { client, sent } = fakeClient(() => reply(emptyOutput()));

    await createAnthropicProvider({ client }).analyse({
      ...request,
      model: "claude-haiku-4-5",
      effort: null,
    });

    expect(sent[0]?.output_config).not.toHaveProperty("effort");
  });

  it("sends the same system prefix for every Offer", async () => {
    const { client, sent } = fakeClient(() => reply(emptyOutput()));
    const provider = createAnthropicProvider({ client });

    await provider.analyse(request);
    await provider.analyse({ ...request, userTurn: "another Offer", effort: "high" });

    expect(JSON.stringify(sent[1]?.system)).toBe(JSON.stringify(sent[0]?.system));
  });

  it("uses a schema that structured output accepts: the model output, with no optional fields", async () => {
    const { client, sent } = fakeClient(() => reply(emptyOutput()));

    await createAnthropicProvider({ client }).analyse(request);

    const format = sent[0]?.output_config?.format as { schema: Record<string, unknown> };
    expect(format.schema.type).toBe("object");
    expect(format.schema.additionalProperties).toBe(false);
    expect(Object.keys(format.schema.properties as object)).toContain("genderSoughtFromText");
  });
});

describe("the Anthropic provider's answer", () => {
  it("returns the parsed facts and what the call used", async () => {
    const output = outputWith({ anmeldung: { value: "possible", ...sure("Anmeldung möglich") } });
    const { client } = fakeClient(() => reply(output));

    const response = await createAnthropicProvider({ client }).analyse(request);

    expect(response.output).toEqual(output);
    expect(response.usage).toEqual({
      inputTokens: 900,
      outputTokens: 300,
      cacheReadTokens: 2000,
      cacheWriteTokens: 0,
    });
  });

  it("reports the thinking tokens the API says are inside the output count", async () => {
    const { client } = fakeClient(() =>
      reply(emptyOutput(), {
        usage: {
          ...usage,
          output_tokens: 1400,
          output_tokens_details: { thinking_tokens: 1000 },
        } as Reply["usage"],
      }),
    );

    const response = await createAnthropicProvider({ client }).analyse(request);

    expect(response.usage.outputTokens).toBe(1400);
    expect(response.usage.thinkingTokens).toBe(1000);
  });

  it("reads the text block even when thinking blocks come first", async () => {
    const { client } = fakeClient(() =>
      reply(emptyOutput(), {
        content: [
          { type: "thinking", thinking: "", signature: "x" },
          { type: "text", text: JSON.stringify(emptyOutput()) },
        ] as Reply["content"],
      }),
    );

    const response = await createAnthropicProvider({ client }).analyse(request);

    expect(response.output).toEqual(emptyOutput());
  });

  it.each([
    ["not JSON", reply(null, { content: [{ type: "text", text: "sorry" }] as Reply["content"] })],
    ["JSON that is not the schema", reply({ anmeldung: 1 })],
    ["no text at all", reply(null, { content: [] })],
  ])("fails with invalid_response on %s", async (_name, bad) => {
    const { client } = fakeClient(() => bad);

    await expect(createAnthropicProvider({ client }).analyse(request)).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it("fails with refused when the model refuses, and truncated when it ran out of tokens", async () => {
    const refused = fakeClient(() => reply(null, { stop_reason: "refusal", content: [] }));
    const cut = fakeClient(() => reply({}, { stop_reason: "max_tokens" }));

    await expect(
      createAnthropicProvider({ client: refused.client }).analyse(request),
    ).rejects.toMatchObject({ kind: "refused" });
    await expect(
      createAnthropicProvider({ client: cut.client }).analyse(request),
    ).rejects.toMatchObject({ kind: "truncated" });
  });
});

describe("what a call that answered but gave nothing usable still used", () => {
  it.each([
    ["a refusal", reply(null, { stop_reason: "refusal", content: [] }), "refused"],
    ["a cut-off answer", reply({}, { stop_reason: "max_tokens" }), "truncated"],
    ["an unreadable answer", reply({ anmeldung: 1 }), "invalid_response"],
  ])("keeps the usage on the error for %s: it is billed", async (_name, bad, kind) => {
    const { client } = fakeClient(() => bad);

    const failure = await createAnthropicProvider({ client })
      .analyse(request)
      .catch((error) => error);

    expect(failure).toMatchObject({ kind });
    expect(failure.usage).toEqual({
      inputTokens: 900,
      outputTokens: 300,
      cacheReadTokens: 2000,
      cacheWriteTokens: 0,
    });
  });

  it("asks for no more output than the most a request is reserved for", async () => {
    const { client, sent } = fakeClient(() => reply(emptyOutput()));

    await createAnthropicProvider({ client }).analyse(request);

    expect(sent[0]?.max_tokens).toBe(MAX_OUTPUT_TOKENS);
  });
});

describe("the Anthropic provider's errors", () => {
  const apiError = (status: number) =>
    new Anthropic.APIError(status, {}, "raw API message", new Headers());

  it.each([
    [429, "rate_limited", true],
    [529, "overloaded", true],
    [500, "server_error", true],
    [503, "server_error", true],
    [401, "unauthorized", false],
    [403, "unauthorized", false],
    [400, "rejected", false],
  ] as const)("maps HTTP %i to %s (retryable: %s)", async (status, kind, retryable) => {
    const { client } = fakeClient(() => {
      throw apiError(status);
    });

    const failure = await createAnthropicProvider({ client })
      .analyse(request)
      .catch((error) => error);

    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure).toMatchObject({ kind, retryable });
  });

  it("maps a dropped connection to network and a slow one to timeout", async () => {
    const dropped = fakeClient(() => {
      throw new Anthropic.APIConnectionError({ message: "connect ECONNRESET" });
    });
    const slow = fakeClient(() => {
      throw new Anthropic.APIConnectionTimeoutError();
    });

    await expect(
      createAnthropicProvider({ client: dropped.client }).analyse(request),
    ).rejects.toMatchObject({ kind: "network" });
    await expect(
      createAnthropicProvider({ client: slow.client }).analyse(request),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("never lets the API key or the API's own message into the error", async () => {
    const key = "sk-ant-api03-SECRET-KEY-1234567890";
    const { client } = fakeClient(() => {
      throw new Anthropic.APIError(401, {}, `invalid x-api-key ${key}`, new Headers());
    });

    const failure: Error = await createAnthropicProvider({ client })
      .analyse(request)
      .then(
        () => new Error("it did not fail"),
        (error: Error) => error,
      );

    expect(String(failure.message)).not.toContain(key);
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain(key);
    expect(String(failure.stack)).not.toContain(key);
    expect(failure.cause).toBeUndefined();
  });
});

describe("the Anthropic provider's client", () => {
  it("has the SDK's own retries off, so wg-hunt's count the attempts", () => {
    expect(createAnthropicClient("sk-ant-test-key-0000000000").maxRetries).toBe(0);
  });
});
