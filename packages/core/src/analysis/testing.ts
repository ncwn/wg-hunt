import type { ModelFactsOutput } from "../offer-facts/index.js";
import {
  type AnalysisProvider,
  type AnalysisRequest,
  type AnalysisResponse,
  type BatchOutcome,
  type BatchProvider,
  type BatchRequest,
  ProviderError,
  type TokenUsage,
} from "./provider.js";

export function emptyOutput(): ModelFactsOutput {
  const none = { quote: "", ambiguous: false, ambiguityReason: "" };
  return {
    anmeldung: { value: "unknown", ...none },
    requirements: [],
    minimumStay: { value: "unknown", months: 0, ...none },
    genderSoughtFromText: { value: "unknown", only: [], ...none },
    scamSignals: [],
    conflicts: [],
  };
}

export function outputWith(facts: Partial<ModelFactsOutput>): ModelFactsOutput {
  return { ...emptyOutput(), ...facts };
}

export const sure = (quote: string) => ({ quote, ambiguous: false, ambiguityReason: "" });

export const unsure = (quote: string, reason = "wording is unclear") => ({
  quote,
  ambiguous: true,
  ambiguityReason: reason,
});

export type Scripted = ModelFactsOutput | ProviderError;

const DEFAULT_USAGE: TokenUsage = {
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function fakeProvider(
  script: Scripted[] | ((call: number) => Scripted),
  options: { usage?: TokenUsage } = {},
) {
  const requests: AnalysisRequest[] = [];
  const provider: AnalysisProvider = {
    async analyse(request): Promise<AnalysisResponse> {
      const call = requests.length;
      requests.push(request);
      const next =
        typeof script === "function" ? script(call) : script[Math.min(call, script.length - 1)];
      if (next === undefined) throw new Error("the fake provider has no script");
      if (next instanceof ProviderError) throw next;
      return { output: next, usage: options.usage ?? DEFAULT_USAGE };
    },
  };
  return { provider, requests };
}

export function fakeBatchProvider(
  script: Scripted[] | ((call: number, request: BatchRequest) => Scripted),
  options: { usage?: TokenUsage } = {},
) {
  const batches = new Map<
    string,
    { requests: BatchRequest[]; ended: boolean; canceled: boolean }
  >();
  const canceled: string[] = [];
  const submissions: BatchRequest[][] = [];
  let calls = 0;
  const control = {
    failSubmit: undefined as ProviderError | undefined,
    /** Creates the batch and then fails, as a timed-out request can. */
    failSubmitAfterCreate: undefined as ProviderError | undefined,
    failFind: undefined as ProviderError | undefined,
    failStatus: undefined as ProviderError | undefined,
    failResults: undefined as ProviderError | undefined,
  };

  const answer = (request: BatchRequest): BatchOutcome => {
    const call = calls++;
    const next =
      typeof script === "function"
        ? script(call, request)
        : script[Math.min(call, script.length - 1)];
    if (next === undefined) throw new Error("the fake batch provider has no script");
    if (next instanceof ProviderError) {
      return {
        customId: request.customId,
        status: "failed",
        kind: next.kind,
        ...(next.usage && { usage: next.usage }),
      };
    }
    return {
      customId: request.customId,
      status: "succeeded",
      response: { output: next, usage: options.usage ?? DEFAULT_USAGE },
    };
  };

  const provider: BatchProvider = {
    async submit(requests) {
      if (control.failSubmit) throw control.failSubmit;
      const batchId = `batch-${batches.size + 1}`;
      batches.set(batchId, { requests, ended: false, canceled: false });
      submissions.push(requests);
      if (control.failSubmitAfterCreate) throw control.failSubmitAfterCreate;
      return { batchId };
    },
    async status(batchId) {
      if (control.failStatus) throw control.failStatus;
      return { ended: batches.get(batchId)?.ended ?? false };
    },
    async results(batchId) {
      if (control.failResults) throw control.failResults;
      const batch = batches.get(batchId);
      if (!batch?.ended) throw new ProviderError("server_error");
      if (batch.canceled) {
        return batch.requests.map((r) => ({
          customId: r.customId,
          status: "failed" as const,
          kind: "canceled" as const,
        }));
      }
      return batch.requests.map(answer);
    },
    async find({ requestCount, exclude }) {
      if (control.failFind) throw control.failFind;
      for (const [id, batch] of batches) {
        if (batch.requests.length === requestCount && !exclude.includes(id)) return id;
      }
      return undefined;
    },
    async cancel(batchId) {
      const batch = batches.get(batchId);
      if (batch) batch.canceled = true;
      canceled.push(batchId);
    },
  };

  return {
    provider,
    submissions,
    batchIds: () => [...batches.keys()],
    canceled,
    complete(batchId?: string) {
      for (const [id, batch] of batches)
        if (batchId === undefined || id === batchId) batch.ended = true;
    },
    control,
  };
}

export function fakeProviders() {
  return {
    providerFor: () => fakeProvider([emptyOutput()]).provider,
    batchProviderFor: () => fakeBatchProvider([emptyOutput()]).provider,
  };
}
