import { type AnalysisProvider, type BatchProvider, ProviderError } from "@wg-hunt/core";
import { describe, expect, it } from "vitest";
import {
  type KeyAt,
  keyReporting,
  keyReportingBatch,
  keyState,
  noteKeyRefused,
} from "../src/analysis/key.js";
import {
  anmeldungOk,
  boot,
  change,
  crawlOffers,
  KEY,
  offerOf,
  poll,
  setKey,
  status,
} from "./analysis-harness.js";

async function inBatch() {
  const h = boot();
  await setKey(h);
  await change(h, { batchOnly: true });
  const [offer] = await crawlOffers(h, 1);
  await poll(h);
  expect(h.batch.submissions).toHaveLength(1);
  return { h, id: offer?.id as number };
}

describe("a refused key", () => {
  it("is tried again when the same key is saved again", async () => {
    let refuse = true;
    const h = boot({
      script: (call) => (call > 0 && refuse ? new ProviderError("unauthorized") : anmeldungOk),
    });
    await setKey(h);
    const [first, second] = await crawlOffers(h, 2);
    const ids = [first?.id as number, second?.id as number];

    expect((await status(h)).key).toBe("refused");
    expect((await h.json("POST", `/offers/${ids[0]}/reanalyze`)).status).toBe(409);

    // Before the save: it pokes a sweep, which would mark a key the script still refuses.
    refuse = false;
    await setKey(h);

    expect((await status(h)).key).toBe("present");
    expect((await h.json("POST", `/offers/${ids[0]}/reanalyze`)).status).toBe(202);
    await h.runtime.analysis.idle();
    for (const id of ids) expect((await offerOf(h, id)).analysisState).toBe("analyzed");
  });

  it("is noted by a batch poll the API refuses, and the Offers it holds say so", async () => {
    const { h, id } = await inBatch();

    h.batch.control.failStatus = new ProviderError("unauthorized");
    await poll(h);

    const now = await status(h);
    expect(now.key).toBe("refused");
    expect(now.byStatus["key-refused"]).toBe(1);
    expect((await offerOf(h, id)).analysisStatus).toMatchObject({
      status: "key-refused",
      next: "replace-key",
      willRead: false,
    });
  });

  it("is cleared by a batch poll that goes through", async () => {
    const { h, id } = await inBatch();
    noteKeyRefused(h.runtime.db, KEY, new Date(h.clock.now));

    await poll(h);

    expect((await status(h)).key).toBe("present");
    expect((await offerOf(h, id)).analysisStatus.status).toBe("in-batch");
    h.batch.complete();
    await poll(h);
    expect((await offerOf(h, id)).analysisStatus.status).toBe("analyzed");
  });
});

const failing = (error: Error) => () => Promise.reject(error);

function batchThrowing(error: Error): BatchProvider {
  return {
    submit: failing(error),
    status: failing(error),
    results: failing(error),
    find: failing(error),
    cancel: failing(error),
  };
}

const calls: ((api: BatchProvider) => Promise<unknown>)[] = [
  (api) => api.submit([]),
  (api) => api.status("b"),
  (api) => api.results("b"),
  (api) => api.find({ since: 0, requestCount: 1, exclude: [] }),
  (api) => api.cancel("b"),
];

const everyCall = (error: Error): ((at: KeyAt) => Promise<unknown>)[] => [
  ...calls.map((call) => (at: KeyAt) => call(keyReportingBatch(batchThrowing(error), at))),
  (at: KeyAt) =>
    keyReporting({ analyse: failing(error) } satisfies AnalysisProvider, at).analyse({} as never),
];

async function withKey() {
  const h = boot();
  await setKey(h);
  return { db: h.runtime.db, key: KEY, now: () => new Date(h.clock.now) };
}

describe("every provider call reports the key", () => {
  it("marks it refused when the API answers unauthorized", async () => {
    for (const call of everyCall(new ProviderError("unauthorized"))) {
      const at = await withKey();
      await expect(call(at)).rejects.toThrow(ProviderError);
      expect(keyState(at.db)).toBe("refused");
    }
  });

  it("changes nothing on an error that says nothing about the key", async () => {
    for (const call of everyCall(new ProviderError("rate_limited"))) {
      const at = await withKey();
      await expect(call(at)).rejects.toThrow(ProviderError);
      expect(keyState(at.db)).toBe("present");
      noteKeyRefused(at.db, KEY, at.now());
      await expect(call(at)).rejects.toThrow(ProviderError);
      expect(keyState(at.db)).toBe("refused");
    }
  });

  it("clears a refusal when the model answered, even badly", async () => {
    for (const call of everyCall(new ProviderError("refused"))) {
      const at = await withKey();
      noteKeyRefused(at.db, KEY, at.now());
      await expect(call(at)).rejects.toThrow(ProviderError);
      expect(keyState(at.db)).toBe("present");
    }
  });

  it("leaves a newer key present when an older one is refused", async () => {
    for (const call of everyCall(new ProviderError("unauthorized"))) {
      const at = await withKey();
      await expect(call({ ...at, key: `${KEY}-older-0123` })).rejects.toThrow(ProviderError);
      expect(keyState(at.db)).toBe("present");
    }
  });

  it("says the key changed when a call begun before a refusal goes through after it", async () => {
    const at = await withKey();
    let changes = 0;
    const counted = { ...at, changed: () => changes++ };
    let finish = () => {};
    const slow = keyReportingBatch(
      {
        ...batchThrowing(new Error()),
        cancel: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      },
      counted,
    ).cancel("b");
    const refused = keyReportingBatch(batchThrowing(new ProviderError("unauthorized")), counted);
    await expect(refused.status("b")).rejects.toThrow(ProviderError);
    expect(changes).toBe(1);

    finish();
    await slow;

    expect(keyState(at.db)).toBe("present");
    expect(changes).toBe(2);
  });

  it("clears a refusal when a call goes through", async () => {
    const at = await withKey();
    noteKeyRefused(at.db, KEY, at.now());
    const api = keyReportingBatch({ ...batchThrowing(new Error()), cancel: async () => {} }, at);
    await api.cancel("b");
    expect(keyState(at.db)).toBe("present");
  });
});
