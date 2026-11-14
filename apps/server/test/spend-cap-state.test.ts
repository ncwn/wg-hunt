import { ANALYSIS_PREFIX, type ModelChoice } from "@wg-hunt/core";
import { fakeBatchProvider, fakeProvider, outputWith, sure } from "@wg-hunt/core/analysis/testing";
import { describe, expect, it } from "vitest";
import { offerHtml } from "./fixtures/search-pages.js";
import { bootOffers } from "./offers-harness.js";

const KEY = "sk-ant-api03-test-key-do-not-leak-0123456789";
const HOUR = 60 * 60 * 1000;

const anmeldungOk = outputWith({
  anmeldung: { value: "possible", ...sure("Anmeldung ist möglich") },
});

type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};
const usage = (over: Partial<TokenUsage> = {}): TokenUsage => ({
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...over,
});

function boot(
  options: { usage?: TokenUsage; size?: number; start?: number; dataDir?: string } = {},
) {
  const realtime = fakeProvider([anmeldungOk], { usage: options.usage ?? usage() });
  const batch = fakeBatchProvider([anmeldungOk], { usage: usage() });
  const h = bootOffers({
    ...(options.start !== undefined && { start: options.start }),
    ...(options.dataDir !== undefined && { dataDir: options.dataDir }),
    analysis: {
      providerFor: () => realtime.provider,
      batchProviderFor: () => batch.provider,
      sleep: async () => {},
      batch: { size: options.size ?? 100 },
    },
  });
  return { ...h, ...realtime, batch };
}
type Boot = ReturnType<typeof boot>;

const setKey = async (h: Boot) => {
  expect((await h.call("PUT", "/secrets/anthropic", { value: KEY })).status).toBe(200);
};
async function change(h: Boot, patch: Record<string, unknown>) {
  const current = (await h.json("GET", "/settings/analysis")).body;
  expect((await h.json("PUT", "/settings/analysis", { ...current, ...patch })).status).toBe(200);
  await h.runtime.analysis.idle();
}
const spend = async (h: Boot) => (await h.json("GET", "/analysis")).body.spend;
const poll = (h: Boot) => h.runtime.analysis.pollBatches();
const capEvents = (h: Boot) =>
  h.events
    .filter((event) => event.type === "spend-cap-reached" || event.type === "spend-cap-cleared")
    .map((event) => ({ type: event.type, ...(event.data as { state: string; month: string }) }));

async function crawlOffers(h: Boot, count: number, first = 9000001) {
  const ids = Array.from({ length: count }, (_, i) => first + i);
  h.site.cards = h.freshCards(ids);
  await h.addSearch();
  await h.crawl();
  await h.runtime.analysis.idle();
  return (await h.json("GET", "/offers")).body.items as { id: number; analysisState: string }[];
}

const progressOf = (h: Boot, offerId: number, from = 0) =>
  h.events
    .slice(from)
    .filter((event) => event.type === "analysis-progress" && event.data.offerId === offerId)
    .map((event) => (event.data as { status: { status: string } }).status.status);
const cycle = async (h: Boot) => {
  h.runtime.analysis.sweep();
  await h.runtime.analysis.idle();
};
const statusOf = async (h: Boot, id: number) =>
  (await h.json("GET", `/offers/${id}`)).body.analysisStatus;
const owed = (h: Boot, id: number) => h.runtime.offers.analysisJob(id)?.reanalyzeRequestedAt;

function nominalUsd(h: Pick<Boot, "runtime">, choice: ModelChoice, batch: boolean): number {
  const micros = h.runtime.analysis.spend.estimateMicros(
    { ...choice, prefix: ANALYSIS_PREFIX, userTurn: "x".repeat(8_000) },
    { batch },
  );
  if (micros === undefined) throw new Error("unpriced");
  return micros / 1e6;
}

describe("GET /analysis spend", () => {
  it("is the one cap state: spend, reservations, headroom, and when the cap starts over", async () => {
    const h = boot();
    await setKey(h);
    await crawlOffers(h, 1);

    expect(await spend(h)).toEqual({
      month: "2026-11",
      spentUsd: 0.0002,
      capUsd: 5,
      reservedUsd: 0,
      headroomUsd: 4.9998,
      state: "ok",
      // Midnight on 1 December in Berlin.
      resetsAt: "2026-11-30T23:00:00.000Z",
    });
  });
});

describe("A: the cap lowered under what batches in flight reserved", () => {
  it("says the cap is reached (waiting for what is in flight), and clears it once they settle", async () => {
    const h = boot({ size: 5, start: Date.parse("2026-11-20T08:00:00Z") });
    await setKey(h);
    await crawlOffers(h, 5);
    await change(h, {
      model: "claude-sonnet-5-5",
      effort: "medium",
      escalation: null,
      monthlySpendCapUsd: 1,
    });
    expect((await h.json("POST", "/analysis/runs")).status).toBe(202);
    await poll(h);
    expect(h.batch.submissions.map((batch) => batch.length)).toEqual([5]);
    const reserved = (await spend(h)).reservedUsd;
    expect(reserved).toBeGreaterThan(0.3);

    await change(h, { monthlySpendCapUsd: 0.3 });
    await poll(h);

    expect(h.batch.canceled).toHaveLength(1);
    const lowered = await spend(h);
    expect(lowered).toMatchObject({ state: "waiting-for-in-flight", capUsd: 0.3 });
    expect(lowered.headroomUsd).toBeLessThan(0);
    expect(capEvents(h)).toEqual([
      expect.objectContaining({ type: "spend-cap-reached", state: "waiting-for-in-flight" }),
    ]);
    h.runtime.analysis.sweep();
    await h.runtime.analysis.idle();
    expect(await h.json("POST", "/analysis/runs")).toMatchObject({ status: 409 });

    h.batch.complete();
    await poll(h);
    h.runtime.analysis.sweep();
    await h.runtime.analysis.idle();

    expect(await spend(h)).toMatchObject({ state: "ok", reservedUsd: 0 });
    expect(capEvents(h).map((event) => event.type)).toEqual([
      "spend-cap-reached",
      "spend-cap-cleared",
    ]);
  });
});

describe("B: room for a batch request but not a realtime one", () => {
  const MEDIUM: ModelChoice = { model: "claude-haiku-5-5", effort: "medium" };
  const HIGH: ModelChoice = { model: "claude-haiku-5-5", effort: "high" };

  async function between(h: Boot, choice: ModelChoice) {
    const spent = (await spend(h)).spentUsd;
    const batch = nominalUsd(h, choice, true);
    const realtime = nominalUsd(h, choice, false);
    expect(realtime).toBeGreaterThan(batch);
    return Math.round((spent + (batch + realtime) / 2) * 1e6) / 1e6;
  }

  it("starts a re-analysis run", async () => {
    const h = boot();
    await setKey(h);
    await crawlOffers(h, 1);
    await change(h, { effort: "high", escalation: null });
    await change(h, { monthlySpendCapUsd: await between(h, HIGH) });
    expect((await spend(h)).state).toBe("ok");

    const started = await h.json("POST", "/analysis/runs");
    await poll(h);

    expect(started.status).toBe(202);
    expect(h.batch.submissions.flat()).toHaveLength(1);
  });

  it("still queues backfills for the Batch API", async () => {
    const h = boot({ start: Date.parse("2026-11-20T08:00:00Z") });
    await setKey(h);
    await change(h, { monthlySpendCapUsd: 0 });
    await crawlOffers(h, 1);
    expect(h.requests).toHaveLength(0);

    // Waited long enough to be a backfill.
    h.clock.now += 3 * HOUR;
    await change(h, { monthlySpendCapUsd: await between(h, MEDIUM) });
    await poll(h);

    expect(h.requests).toHaveLength(0);
    expect(h.batch.submissions.flat()).toHaveLength(1);
  });

  it("sends a new Offer through the Batch API rather than refusing it", async () => {
    const h = boot();
    await setKey(h);
    await change(h, { monthlySpendCapUsd: await between(h, MEDIUM) });

    await crawlOffers(h, 1);
    await poll(h);

    expect(h.requests).toHaveLength(0);
    expect(h.batch.submissions.flat()).toHaveLength(1);
  });

  async function readThenCapped() {
    const h = boot();
    await setKey(h);
    const [offer] = await crawlOffers(h, 1);
    expect(h.requests).toHaveLength(1);
    await change(h, { monthlySpendCapUsd: await between(h, MEDIUM) });
    expect((await spend(h)).state).toBe("ok");
    return { h, id: offer?.id as number };
  }

  it("sends a Re-analyse click through the Batch API rather than refusing it", async () => {
    const { h, id } = await readThenCapped();
    const from = h.events.length;

    const click = await h.json("POST", `/offers/${id}/reanalyze`);
    await h.runtime.analysis.idle();

    expect(click.status).toBe(202);
    expect((await statusOf(h, id)).status).toBe("in-batch");
    expect(progressOf(h, id, from)).not.toContain("reading");
    expect(h.requests).toHaveLength(1);

    await poll(h);
    expect(h.batch.submissions.flat()).toHaveLength(1);
    expect(await h.json("POST", `/offers/${id}/reanalyze`)).toMatchObject({
      status: 409,
      body: { type: "analysis-in-batch" },
    });

    h.batch.complete();
    await poll(h);
    expect((await statusOf(h, id)).status).toBe("analyzed");
    expect(owed(h, id)).toBeNull();
    await cycle(h);
    await poll(h);
    expect(h.requests).toHaveLength(1);
    expect(h.batch.submissions.flat()).toHaveLength(1);
  });

  it("sends a kept Re-analyse click through the Batch API at the next cycle", async () => {
    const { h, id } = await readThenCapped();
    h.runtime.offers.requestReanalysis(id);

    await cycle(h);
    await poll(h);

    expect(h.requests).toHaveLength(1);
    expect(h.batch.submissions.flat()).toHaveLength(1);
    expect((await statusOf(h, id)).status).toBe("in-batch");
  });
});

describe("a run the cap pays the first pass of, and not the escalation", () => {
  const HIGH: ModelChoice = { model: "claude-haiku-5-5", effort: "high" };

  /** The default escalation is Haiku 5.5 at high effort too, so it costs one more pass. */
  async function firstPassOnly(patch: Record<string, unknown> = {}) {
    const h = boot();
    await setKey(h);
    const [offer] = await crawlOffers(h, 1);
    await change(h, { effort: "high", ...patch });
    const cap = (await spend(h)).spentUsd + nominalUsd(h, HIGH, true) * 1.5;
    await change(h, { monthlySpendCapUsd: Math.round(cap * 1e6) / 1e6 });
    return { h, id: offer?.id as number };
  }

  it("is refused while the cap state is ok, and GET /analysis and the Offer say so", async () => {
    const { h, id } = await firstPassOnly();
    const calls = h.requests.length;

    const { body } = await h.json("GET", "/analysis");
    expect(body.spend.state).toBe("ok");
    expect(body.actions).toEqual({ startRun: false, startRunRefusedBy: "spend-cap-reached" });
    expect(await statusOf(h, id)).toMatchObject({
      status: "older-version",
      next: "raise-cap",
      at: body.spend.resetsAt,
    });

    const refused = await h.json("POST", "/analysis/runs");
    await poll(h);

    expect(refused).toMatchObject({ status: 409, body: { type: "spend-cap-reached" } });
    expect(h.requests).toHaveLength(calls);
    expect(h.batch.submissions).toHaveLength(0);
  });

  it("starts with escalation off", async () => {
    const { h, id } = await firstPassOnly({ escalation: null });

    expect((await h.json("GET", "/analysis")).body.actions).toEqual({
      startRun: true,
      startRunRefusedBy: null,
    });
    expect(await statusOf(h, id)).toMatchObject({ status: "older-version", next: "start-run" });

    const started = await h.json("POST", "/analysis/runs");
    await poll(h);

    expect(started.status).toBe(202);
    expect(h.batch.submissions.flat()).toHaveLength(1);
  });

  it("is announced once spend stops a run fitting, though the cap state stays ok", async () => {
    const h = boot();
    await setKey(h);
    await crawlOffers(h, 1);
    await change(h, { effort: "high" });
    const cap = (await spend(h)).spentUsd + nominalUsd(h, HIGH, true) * 2 + 0.0001;
    await change(h, { monthlySpendCapUsd: Math.round(cap * 1e6) / 1e6 });
    expect((await h.json("GET", "/analysis")).body.actions.startRun).toBe(true);
    const from = h.events.length;

    // A realtime read that costs $0.0002.
    await crawlOffers(h, 1, 9000002);

    expect((await spend(h)).state).toBe("ok");
    const announced = h.events
      .slice(from)
      .filter((event) => event.type === "analysis-status-changed")
      .map((event) => (event.data as { actions: unknown }).actions);
    expect(announced.at(-1)).toEqual({ startRun: false, startRunRefusedBy: "spend-cap-reached" });
  });
});

describe("C: Re-analyse on one Offer", () => {
  it("goes as a batch when what a batch in flight leaves pays for its batch call and not its realtime one", async () => {
    const h = boot();
    await setKey(h);
    const [held] = await crawlOffers(h, 1);
    expect(h.requests).toHaveLength(1);
    await change(h, { effort: "high" });
    expect((await h.json("POST", "/analysis/runs")).status).toBe(202);
    await poll(h);
    expect(h.batch.submissions).toHaveLength(1);
    const offer = (await crawlOffers(h, 1, 9000002)).find((o) => o.id !== held?.id);
    expect(h.requests).toHaveLength(2);
    const spent = (await spend(h)).spentUsd;
    const cap = spent + nominalUsd(h, { model: "claude-haiku-5-5", effort: "high" }, false);
    await change(h, { monthlySpendCapUsd: Math.ceil(cap * 1e6) / 1e6 });

    const answer = await h.json("POST", `/offers/${offer?.id}/reanalyze`);
    await h.runtime.analysis.idle();

    expect(answer.status).toBe(202);
    expect((await statusOf(h, offer?.id as number)).status).toBe("in-batch");
    expect(h.requests).toHaveLength(2);
    await poll(h);
    expect(h.batch.submissions.map((batch) => batch.length)).toEqual([1, 1]);
  });

  it("is read at once when there is room for its realtime call, also in batch-only mode", async () => {
    const h = boot();
    await setKey(h);
    await change(h, { batchOnly: true });
    const [offer] = await crawlOffers(h, 1);
    const id = offer?.id as number;
    await poll(h);
    h.batch.complete();
    await poll(h);
    expect((await statusOf(h, id)).status).toBe("analyzed");
    expect(h.requests).toHaveLength(0);

    const click = await h.json("POST", `/offers/${id}/reanalyze`);
    await h.runtime.analysis.idle();

    expect(click.status).toBe(202);
    expect(h.requests).toHaveLength(1);
    expect((await statusOf(h, id)).status).toBe("analyzed");
    expect(h.batch.submissions.flat()).toHaveLength(1);
  });
});

describe("an Offer bigger than a typical one", () => {
  const MEDIUM: ModelChoice = { model: "claude-haiku-5-5", effort: "medium" };

  const FILLER = " Die Küche ist groß und hell.";
  const big = (h: Boot, id: number, repeats = 700) =>
    h.site.pages.set(
      id,
      offerHtml().replace(
        "Das Zimmer ist hell und möbliert.",
        `Das Zimmer ist hell und möbliert.${FILLER.repeat(repeats)}`,
      ),
    );
  const submittedBig = (h: Boot) =>
    h.batch.submissions.flat().filter(({ request }) => request.userTurn.includes(FILLER));

  async function bigOfferCapped() {
    const h = boot();
    await setKey(h);
    big(h, 9000001);
    const [offer] = await crawlOffers(h, 1);
    const [first] = h.requests;
    if (first === undefined) throw new Error("not read");
    const own = (h.runtime.analysis.spend.estimateMicros(first, { batch: true }) ?? 0) / 1e6;
    const typical = nominalUsd(h, MEDIUM, true);
    expect(own).toBeGreaterThan(typical);
    const cap = (await spend(h)).spentUsd + (typical + own) / 2;
    await change(h, { monthlySpendCapUsd: Math.round(cap * 1e6) / 1e6 });
    expect((await spend(h)).state).toBe("ok");
    return { h, id: offer?.id as number };
  }

  it("waits for the cap when what is left pays for neither of its calls, and says so once", async () => {
    const { h, id } = await bigOfferCapped();
    const from = h.events.length;
    h.runtime.offers.requestReanalysis(id);
    await cycle(h);

    const { resetsAt } = await spend(h);
    expect(await statusOf(h, id)).toEqual({
      status: "waiting-for-cap",
      next: "raise-cap",
      reason: null,
      at: resetsAt,
      willRead: false,
    });
    expect((await h.json("GET", "/analysis")).body.awaiting).toBe(0);
    expect(progressOf(h, id, from)).toEqual(["waiting-for-cap"]);

    for (let i = 0; i < 3; i++) await cycle(h);
    expect(progressOf(h, id, from)).toEqual(["waiting-for-cap"]);
    expect(h.requests).toHaveLength(1);
    await poll(h);
    expect(h.batch.submissions).toHaveLength(0);

    const click = await h.json("POST", `/offers/${id}/reanalyze`);
    expect(click).toMatchObject({ status: 409, body: { type: "spend-cap-reached" } });

    await change(h, { monthlySpendCapUsd: 5 });
    await cycle(h);
    expect(h.requests).toHaveLength(2);
    expect(progressOf(h, id, from).slice(-2)).toEqual(["reading", "analyzed"]);
    expect((await statusOf(h, id)).status).toBe("analyzed");
    expect(owed(h, id)).toBeNull();
    await cycle(h);
    expect(h.requests).toHaveLength(2);
  });

  it("says once that it left the wait when a click finds room for a batch call", async () => {
    const { h, id } = await bigOfferCapped();
    h.runtime.offers.requestReanalysis(id);
    await cycle(h);
    expect((await statusOf(h, id)).status).toBe("waiting-for-cap");
    const [first] = h.requests;
    if (first === undefined) throw new Error("not read");
    const { spend: ledger } = h.runtime.analysis;
    const realtime = ledger.estimateMicros(first, { batch: false }) ?? 0;
    const batched = ledger.estimateMicros(first, { batch: true }) ?? 0;
    const cap = (ledger.spentUsd() * 1e6 + (realtime + batched) / 2) / 1e6;
    const current = (await h.json("GET", "/settings/analysis")).body;
    const from = h.events.length;
    await h.json("PUT", "/settings/analysis", {
      ...current,
      monthlySpendCapUsd: Math.round(cap * 1e6) / 1e6,
    });

    expect((await h.json("POST", `/offers/${id}/reanalyze`)).status).toBe(202);
    await h.runtime.analysis.idle();
    for (let i = 0; i < 2; i++) await cycle(h);

    expect((await statusOf(h, id)).status).toBe("in-batch");
    expect(progressOf(h, id, from)).toEqual(["in-batch"]);
  });

  it("is refused up front, and nothing is kept, when a click finds room for neither call", async () => {
    const { h, id } = await bigOfferCapped();

    const click = await h.json("POST", `/offers/${id}/reanalyze`);
    await h.runtime.analysis.idle();

    expect(click).toMatchObject({ status: 409, body: { type: "spend-cap-reached" } });
    expect(owed(h, id)).toBeNull();
    expect(h.requests).toHaveLength(1);
  });

  it("still waits for the cap after a restart, and sends nothing", async () => {
    const before = await bigOfferCapped();
    before.h.runtime.offers.requestReanalysis(before.id);
    await cycle(before.h);
    before.h.runtime.close();

    // Its first sweep runs, and says so, before the harness listens.
    const h = boot({ dataDir: before.h.dataDir, start: before.h.clock.now });
    await h.runtime.analysis.idle();
    expect((await statusOf(h, before.id)).status).toBe("waiting-for-cap");
    await cycle(h);
    await cycle(h);

    expect((await statusOf(h, before.id)).status).toBe("waiting-for-cap");
    expect(progressOf(h, before.id)).toEqual([]);
    expect(h.requests).toHaveLength(0);
    await poll(h);
    expect(h.batch.submissions).toHaveLength(0);
  });
  async function newBigOffer(h: Boot, repeats?: number) {
    big(h, 9000002, repeats);
    const from = h.events.length;
    await crawlOffers(h, 1, 9000002);
    return { id: await offerId(h, 9000002), from };
  }
  const offerId = async (h: Boot, adId: number) => {
    const { items } = (await h.json("GET", "/offers")).body as {
      items: { id: number; url: string }[];
    };
    const offer = items.find(({ url }) => url.includes(`.${adId}.html`));
    if (offer === undefined) throw new Error(`no Offer for ${adId}`);
    return offer.id;
  };

  async function expectWaiting(h: Boot, id: number, from: number) {
    const { resetsAt } = await spend(h);
    expect(await statusOf(h, id)).toEqual({
      status: "waiting-for-cap",
      next: "raise-cap",
      reason: null,
      at: resetsAt,
      willRead: false,
    });
    for (let i = 0; i < 3; i++) await cycle(h);
    await poll(h);
    expect(progressOf(h, id, from)).toEqual(["waiting-for-cap"]);
    expect((await statusOf(h, id)).status).toBe("waiting-for-cap");
    expect(submittedBig(h)).toHaveLength(0);
  }

  it("waits for the cap, rather than being queued for a batch, when new in batch-only mode", async () => {
    const { h } = await bigOfferCapped();
    await change(h, { batchOnly: true });
    const { id, from } = await newBigOffer(h);

    await expectWaiting(h, id, from);
    expect(h.requests).toHaveLength(1);
  });

  it("waits for the cap, rather than being queued for a batch, as a backfill", async () => {
    const { h } = await bigOfferCapped();
    const spent = (await spend(h)).spentUsd;
    await change(h, {
      monthlySpendCapUsd: Math.round((spent + nominalUsd(h, MEDIUM, false) * 1.05) * 1e6) / 1e6,
    });
    expect(h.runtime.analysis.spend.fitsRealtime()).toBe(true);
    const { id, from } = await newBigOffer(h, 7000);
    h.clock.now += 3 * HOUR;

    await expectWaiting(h, id, from);
    expect(h.requests).toHaveLength(1);
  });

  it("waits for the cap, rather than being queued for a batch, when there is no room for a realtime call", async () => {
    const { h } = await bigOfferCapped();
    expect(h.runtime.analysis.spend.fitsRealtime()).toBe(false);
    const { id, from } = await newBigOffer(h);

    await expectWaiting(h, id, from);
    expect(h.requests).toHaveLength(1);
  });

  it("leaves the wait for a batch once its batch call fits, and says so once", async () => {
    const { h } = await bigOfferCapped();
    await change(h, { batchOnly: true });
    const { id, from } = await newBigOffer(h);
    await cycle(h);
    expect(progressOf(h, id, from)).toEqual(["waiting-for-cap"]);

    await change(h, { monthlySpendCapUsd: 5 });
    await cycle(h);
    expect(progressOf(h, id, from)).toEqual(["waiting-for-cap", "in-batch"]);
    await poll(h);
    expect(submittedBig(h)).toHaveLength(1);

    h.batch.complete();
    await poll(h);
    expect((await statusOf(h, id)).status).toBe("analyzed");
    expect(h.requests).toHaveLength(1);
  });

  it("still waits for the cap after a restart, and sends nothing, when new in batch-only mode", async () => {
    const before = await bigOfferCapped();
    await change(before.h, { batchOnly: true });
    const { id } = await newBigOffer(before.h);
    before.h.runtime.close();

    const h = boot({ dataDir: before.h.dataDir, start: before.h.clock.now });
    await h.runtime.analysis.idle();
    expect((await statusOf(h, id)).status).toBe("waiting-for-cap");
    await cycle(h);
    await cycle(h);

    expect((await statusOf(h, id)).status).toBe("waiting-for-cap");
    expect(progressOf(h, id)).toEqual([]);
    expect(h.requests).toHaveLength(0);
    await poll(h);
    expect(h.batch.submissions).toHaveLength(0);
  });

  it("still queues a smaller Offer of the same sweep whose batch call fits", async () => {
    const { h } = await bigOfferCapped();
    await change(h, { batchOnly: true });
    big(h, 9000002);
    const from = h.events.length;
    await crawlOffers(h, 2, 9000002);
    await poll(h);

    expect(progressOf(h, await offerId(h, 9000002), from)).toEqual(["waiting-for-cap"]);
    expect((await statusOf(h, await offerId(h, 9000003))).status).toBe("in-batch");
    expect(h.batch.submissions.flat()).toHaveLength(1);
    expect(submittedBig(h)).toHaveLength(0);
  });
});

describe("a realtime call in flight", () => {
  it("leaves the cap ok, and Re-analyse open, when the headroom pays for it but not for a batch call on top", async () => {
    const realtime = fakeProvider([anmeldungOk], { usage: usage() });
    const waiting: (() => void)[] = [];
    let open = true;
    const h = bootOffers({
      analysis: {
        providerFor: () => ({
          async analyse(request) {
            if (!open) await new Promise<void>((resolve) => waiting.push(resolve));
            return realtime.provider.analyse(request);
          },
        }),
        batchProviderFor: () => fakeBatchProvider([anmeldungOk]).provider,
        sleep: async () => {},
      },
    });
    expect((await h.call("PUT", "/secrets/anthropic", { value: KEY })).status).toBe(200);
    h.site.cards = h.freshCards([9000001]);
    await h.addSearch();
    await h.crawl();
    await h.runtime.analysis.idle();
    const [first] = realtime.requests;
    const [clicked] = (await h.json("GET", "/offers")).body.items as { id: number }[];
    if (first === undefined || clicked === undefined) throw new Error("not read");
    const { spend: ledger } = h.runtime.analysis;
    const call = ledger.estimateMicros(first, { batch: false }) ?? 0;
    const batch = nominalUsd(h, { model: "claude-haiku-5-5", effort: "medium" }, true);
    const cap = ledger.spentUsd() + call / 1e6 + batch / 2;
    const current = (await h.json("GET", "/settings/analysis")).body;
    const capped = { ...current, monthlySpendCapUsd: Math.round(cap * 1e6) / 1e6 };
    expect((await h.json("PUT", "/settings/analysis", capped)).status).toBe(200);
    await h.runtime.analysis.idle();

    open = false;
    h.site.cards = h.freshCards([9000001, 9000002]);
    await h.crawl();
    for (let i = 0; i < 200 && waiting.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(waiting).toHaveLength(1);

    const during = (await h.json("GET", "/analysis")).body.spend;
    const click = await h.json("POST", `/offers/${clicked.id}/reanalyze`);
    open = true;
    for (const resolve of waiting.splice(0)) resolve();
    await h.runtime.analysis.idle();

    expect(during.state).toBe("ok");
    expect(click.status).toBe(202);
    expect(realtime.requests).toHaveLength(3);
    expect(
      h.events.filter((e) => e.type === "spend-cap-reached" || e.type === "spend-cap-cleared"),
    ).toEqual([]);
  });
});

describe("a new month", () => {
  it("clears the cap on /events, so a warning does not outlive the month", async () => {
    // Each call really costs $0.0076; the cap pays for one.
    const h = boot({
      usage: usage({ inputTokens: 1000, outputTokens: 15_000 }),
      start: Date.parse("2026-11-30T08:00:00Z"),
    });
    await setKey(h);
    await change(h, { monthlySpendCapUsd: 0.0095 });
    await crawlOffers(h, 2);
    expect(await spend(h)).toMatchObject({ state: "reached", month: "2026-11" });
    expect(capEvents(h)).toEqual([
      expect.objectContaining({ type: "spend-cap-reached", state: "reached", month: "2026-11" }),
    ]);

    h.clock.now = Date.parse("2026-12-01T09:00:00Z");
    h.runtime.analysis.sweep();

    expect(capEvents(h)).toEqual([
      expect.objectContaining({ type: "spend-cap-reached" }),
      expect.objectContaining({ type: "spend-cap-cleared", state: "ok", month: "2026-12" }),
    ]);
    expect((await spend(h)).resetsAt).toBe("2026-12-31T23:00:00.000Z");
  });
});
