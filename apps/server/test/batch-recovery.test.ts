import { ProviderError } from "@wg-hunt/core";
import { describe, expect, it } from "vitest";
import {
  type Boot,
  boot,
  change,
  crawlOffers,
  MINUTE,
  offerOf,
  poll,
  setKey,
  status,
  usage,
} from "./analysis-harness.js";
import { offerPageWith } from "./offers-harness.js";

const runOf = async (h: Boot, id: number) => (await h.json("GET", `/analysis/runs/${id}`)).body;
const reserved = (h: Boot) => h.runtime.analysis.spend.reservedMicros();
const DAY = 24 * 60 * MINUTE;

async function startedRun(h: Boot, count = 2) {
  await setKey(h);
  const offers = await crawlOffers(h, count);
  await change(h, { model: "claude-sonnet-5-5", effort: "medium" });
  const { body: run } = await h.json("POST", "/analysis/runs");
  return { run, offers };
}

describe("a batch send that gets no answer", () => {
  it("keeps the batch it may have created, sends nothing again, and adopts it when it is found", async () => {
    const h = boot();
    h.batch.control.failSubmitAfterCreate = new ProviderError("timeout");
    const { run } = await startedRun(h);
    const calls = h.requests.length;

    await poll(h);

    expect(h.batch.submissions).toHaveLength(1);
    expect(reserved(h)).toBeGreaterThan(0);
    h.batch.control.failSubmitAfterCreate = undefined;
    h.runtime.analysis.sweep();
    await h.runtime.analysis.idle();

    await poll(h);
    h.batch.complete();
    await poll(h);

    expect(h.batch.submissions).toHaveLength(1);
    expect(reserved(h)).toBe(0);
    expect(await runOf(h, run.id)).toMatchObject({ status: "succeeded", counts: { applied: 2 } });
    expect(h.requests.length).toBe(calls);
  });

  it("does not send its Offers in realtime, or again in a batch, while it may exist", async () => {
    const h = boot();
    h.batch.control.failSubmit = new ProviderError("timeout");
    const { run } = await startedRun(h);
    const calls = h.requests.length;

    await poll(h);
    await poll(h);
    h.runtime.analysis.sweep();
    await h.runtime.analysis.idle();

    expect(h.batch.submissions).toHaveLength(0);
    expect(h.requests.length).toBe(calls);
    expect(reserved(h)).toBeGreaterThan(0);
    expect(await runOf(h, run.id)).toMatchObject({ status: "running", counts: { pending: 2 } });
  });

  it("queues the requests again, once it is known the batch was never created", async () => {
    const h = boot();
    h.batch.control.failSubmit = new ProviderError("network");
    const { run } = await startedRun(h);
    await poll(h);
    expect(h.batch.submissions).toHaveLength(0);

    // Past the grace period, with nothing found by what the batch held.
    h.clock.now += 11 * MINUTE;
    h.batch.control.failSubmit = undefined;
    await poll(h);

    expect(h.batch.submissions).toHaveLength(1);
    h.batch.complete();
    await poll(h);
    expect(await runOf(h, run.id)).toMatchObject({ status: "succeeded" });
    expect(reserved(h)).toBe(0);
  });

  it("waits while the API cannot say, rather than guessing", async () => {
    const h = boot();
    h.batch.control.failSubmit = new ProviderError("server_error");
    await startedRun(h);
    await poll(h);
    h.clock.now += 11 * MINUTE;
    h.batch.control.failFind = new ProviderError("network");
    h.batch.control.failSubmit = undefined;

    await poll(h);

    expect(h.batch.submissions).toHaveLength(0);
    expect(reserved(h)).toBeGreaterThan(0);
  });

  it("fails the requests at once when the API answered with a refusal: nothing was created", async () => {
    const h = boot();
    h.batch.control.failSubmit = new ProviderError("rejected");
    const { run } = await startedRun(h);

    await poll(h);

    expect(await runOf(h, run.id)).toMatchObject({ status: "failed", counts: { failed: 2 } });
    expect(reserved(h)).toBe(0);
  });
});

describe("a restart after a batch was sent", () => {
  it("adopts the batch it finds instead of sending it a second time", async () => {
    const first = boot();
    first.batch.control.failSubmitAfterCreate = new ProviderError("timeout");
    const { run } = await startedRun(first);
    await poll(first);
    expect(first.batch.submissions).toHaveLength(1);
    first.runtime.close();

    const second = boot({
      dataDir: first.dataDir,
      start: first.clock.now,
      sameProviders: {
        realtime: { provider: first.provider, requests: first.requests },
        batch: first.batch,
      },
    });
    first.batch.control.failSubmitAfterCreate = undefined;
    await poll(second);
    first.batch.complete();
    await poll(second);

    expect(first.batch.submissions).toHaveLength(1);
    expect(await runOf(second, run.id)).toMatchObject({
      status: "succeeded",
      counts: { applied: 2 },
    });
    expect(reserved(second)).toBe(0);
  });

  it("sends the requests once more only when no batch matches", async () => {
    const first = boot();
    first.batch.control.failSubmit = new ProviderError("timeout");
    const { run } = await startedRun(first);
    await poll(first);
    first.runtime.close();
    first.batch.control.failSubmit = undefined;

    const second = boot({
      dataDir: first.dataDir,
      start: first.clock.now + 11 * MINUTE,
      sameProviders: {
        realtime: { provider: first.provider, requests: first.requests },
        batch: first.batch,
      },
    });
    await poll(second);

    expect(first.batch.submissions).toHaveLength(1);
    first.batch.complete();
    await poll(second);
    expect(await runOf(second, run.id)).toMatchObject({ status: "succeeded" });
  });

  it("matches results only to the batch they belong to", async () => {
    const h = boot();
    await startedRun(h);
    await poll(h);
    const ids = h.batch.submissions[0]?.map((r) => r.customId) ?? [];
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(/^b\d+-i\d+$/);
    expect(new Set(ids.map((id) => id.split("-")[0])).size).toBe(1);
  });
});

describe("a batch whose results can never be read", () => {
  it("is ended after five rejections in a row, counted as spent, and its Offers keep their facts", async () => {
    const h = boot();
    const { run, offers } = await startedRun(h);
    await poll(h);
    const held = reserved(h);
    expect(held).toBeGreaterThan(0);
    const before = (await status(h)).spend.spentUsd;
    h.batch.control.failStatus = new ProviderError("rejected");

    for (let i = 0; i < 4; i++) await poll(h);
    expect(reserved(h)).toBe(held);
    await poll(h);

    expect(reserved(h)).toBe(0);
    expect((await status(h)).spend.spentUsd).toBeCloseTo(before + held / 1e6, 9);
    expect(await runOf(h, run.id)).toMatchObject({
      status: "failed",
      counts: { failed: 2 },
      errorKinds: { rejected: 2 },
    });
    for (const offer of offers) {
      expect((await offerOf(h, offer.id)).analysis.model).toBe("claude-haiku-5-5");
    }
  });

  it("does not count a look that failed some other way, and starts over after one that worked", async () => {
    const h = boot();
    await startedRun(h);
    await poll(h);
    h.batch.control.failStatus = new ProviderError("rejected");
    for (let i = 0; i < 4; i++) await poll(h);
    h.batch.control.failStatus = undefined;
    await poll(h);
    h.batch.control.failStatus = new ProviderError("rejected");
    for (let i = 0; i < 4; i++) await poll(h);

    expect(reserved(h)).toBeGreaterThan(0);
  });

  it("is ended after 29 days, the longest the API keeps results", async () => {
    const h = boot();
    const { run } = await startedRun(h);
    await poll(h);
    const held = reserved(h);

    h.clock.now += 29 * DAY;
    await poll(h);

    expect(reserved(h)).toBe(0);
    expect((await status(h)).spend.spentUsd).toBeCloseTo(held / 1e6, 9);
    expect(await runOf(h, run.id)).toMatchObject({ status: "failed", errorKinds: { expired: 2 } });
  });
});

describe("filling a batch", () => {
  it("lets a smaller request in where a bigger one does not fit", async () => {
    const h = boot({ size: 3 });
    await setKey(h);
    const ids = [9000001, 9000002, 9000003];
    h.site.cards = h.freshCards(ids);
    for (const id of ids.slice(0, 2)) {
      h.site.pages.set(id, offerPageWith({ title: `${"B".repeat(60_000)} ${id}`, warmRent: 450 }));
    }
    await h.addSearch();
    await h.crawl();
    await h.runtime.analysis.idle();
    expect(h.requests).toHaveLength(3);
    const { spend, batch } = h.runtime.analysis;
    const settings = (await h.json("GET", "/settings/analysis")).body;
    const worst = h.requests
      .map((request) => spend.estimateMicros(request, { batch: true }) ?? 0)
      .sort((a, b) => a - b);
    const [small, big] = [worst[0] ?? 0, worst[2] ?? 0];
    expect(big).toBeGreaterThan(small + 1000);
    await change(h, {
      monthlySpendCapUsd: spend.spentUsd() + (big + small + 5) / 1e6,
    });

    batch.enqueue(h.runtime.offers.analysisJobs(), { plan: batch.planOf(settings) });
    await poll(h);

    const sent = h.batch.submissions[0] ?? [];
    expect(sent).toHaveLength(2);
    const lengths = sent.map((r) => r.request.userTurn.length).sort((a, b) => a - b);
    expect(lengths[0]).toBeLessThan(5000);
    expect(lengths[1]).toBeGreaterThan(50_000);
  });
});

describe("a cap lowered below what is out", () => {
  // Sonnet 5.5 batch requests that really cost $0.075 each.
  const BIG = usage({ inputTokens: 0, outputTokens: 15_000 });

  it("cancels the batches in flight and stops the run", async () => {
    const h = boot({ size: 2, batchUsage: BIG, start: Date.parse("2026-11-30T08:00:00Z") });
    await setKey(h);
    await crawlOffers(h, 5);
    await change(h, {
      model: "claude-sonnet-5-5",
      effort: "medium",
      escalation: null,
      monthlySpendCapUsd: 0.2,
    });
    const { body: run } = await h.json("POST", "/analysis/runs");
    await poll(h);
    expect(h.batch.submissions.map((batch) => batch.length)).toEqual([2]);
    const spentBefore = (await status(h)).spend.spentUsd;

    await change(h, { monthlySpendCapUsd: 0.05 });
    await poll(h);

    expect(h.batch.canceled).toEqual(["batch-1"]);
    expect(await runOf(h, run.id)).toMatchObject({ counts: { capped: 3, pending: 2 } });
    await poll(h);
    expect(h.batch.canceled).toEqual(["batch-1"]);

    h.batch.complete();
    await poll(h);
    const done = await runOf(h, run.id);
    expect(done).toMatchObject({
      status: "stopped",
      stopReason: "spend-cap-reached",
      counts: { failed: 0, capped: 5, applied: 0, pending: 0 },
      errorKinds: { canceled: 2, spend_cap_reached: 3 },
    });
    expect(h.batch.submissions).toHaveLength(1);
    expect((await status(h)).spend.spentUsd).toBeCloseTo(spentBefore, 9);
    expect(reserved(h)).toBe(0);
    for (const offer of (await h.json("GET", "/offers")).body.items) {
      expect((await offerOf(h, offer.id)).analysis.model).toBe("claude-haiku-5-5");
    }
  });

  it("leaves a batch alone while the cap still covers it", async () => {
    const h = boot({ size: 2, batchUsage: BIG });
    await setKey(h);
    await crawlOffers(h, 3);
    await change(h, { model: "claude-sonnet-5-5", effort: "medium", monthlySpendCapUsd: 5 });
    await h.json("POST", "/analysis/runs");
    await poll(h);

    await change(h, { monthlySpendCapUsd: 4 });
    await poll(h);

    expect(h.batch.canceled).toEqual([]);
  });
});
