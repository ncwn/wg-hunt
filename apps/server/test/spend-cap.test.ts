import { ANALYSIS_PREFIX, ProviderError } from "@wg-hunt/core";
import {
  fakeBatchProvider,
  fakeProvider,
  outputWith,
  sure,
  unsure,
} from "@wg-hunt/core/analysis/testing";
import { describe, expect, it } from "vitest";
import { tempDataDir } from "./helpers.js";
import { bootOffers } from "./offers-harness.js";

const KEY = "sk-ant-api03-test-key-do-not-leak-0123456789";

const anmeldungOk = outputWith({
  anmeldung: { value: "possible", ...sure("Anmeldung ist möglich") },
});
const doubtful = outputWith({
  anmeldung: { value: "conditional", ...unsure("Anmeldung ist möglich") },
});

type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens?: number;
};
const usage = (over: Partial<TokenUsage> = {}): TokenUsage => ({
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...over,
});

function boot(
  options: {
    script?: Parameters<typeof fakeProvider>[0];
    batchScript?: Parameters<typeof fakeBatchProvider>[0];
    usage?: TokenUsage;
    batchUsage?: TokenUsage;
    size?: number;
    start?: number;
  } = {},
) {
  const realtime = fakeProvider(options.script ?? [anmeldungOk], {
    usage: options.usage ?? usage(),
  });
  const batch = fakeBatchProvider(options.batchScript ?? [anmeldungOk], {
    usage: options.batchUsage ?? usage(),
  });
  const h = bootOffers({
    ...(options.start !== undefined && { start: options.start }),
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
}
const status = async (h: Boot) => (await h.json("GET", "/analysis")).body;
const poll = (h: Boot) => h.runtime.analysis.pollBatches();
const capEvents = (h: Boot) => h.events.filter((event) => event.type === "spend-cap-reached");

async function crawlOffers(h: Boot, count: number) {
  const ids = Array.from({ length: count }, (_, i) => 9000001 + i);
  h.site.cards = h.freshCards(ids);
  await h.addSearch();
  await h.crawl();
  await h.runtime.analysis.idle();
  return (await h.json("GET", "/offers")).body.items as { id: number; analysisState: string }[];
}
const states = (offers: { analysisState: string }[]) => offers.map((o) => o.analysisState).sort();

describe("what a call is counted at", () => {
  it("counts the tokens a call used at the price table's rates, in this month", async () => {
    const h = boot();
    await setKey(h);

    await crawlOffers(h, 1);

    // 1,000 input and 200 output tokens at Haiku 5.5's $0.10 / $0.50 per million.
    expect((await status(h)).spend).toMatchObject({
      month: "2026-11",
      spentUsd: 0.0002,
      capUsd: 5,
      state: "ok",
    });
  });

  it("counts input, output with its thinking, cache writes and cache reads", async () => {
    const h = boot({
      usage: usage({
        inputTokens: 2000,
        outputTokens: 1600,
        thinkingTokens: 1200,
        cacheReadTokens: 3000,
        cacheWriteTokens: 4000,
      }),
    });
    await setKey(h);

    await crawlOffers(h, 1);

    // Thinking is inside the 1,600 output tokens. Prices per million tokens: input 0.10,
    // output 0.50, cache write 1.25 times and cache read 0.1 times the input price.
    const expected = (2000 * 0.1 + 4000 * 0.125 + 3000 * 0.01 + 1600 * 0.5) / 1e6;
    expect((await status(h)).spend.spentUsd).toBeCloseTo(expected, 9);
  });

  it("counts a Batch API call at half price", async () => {
    const h = boot({ batchUsage: usage({ inputTokens: 1000, outputTokens: 2000 }) });
    await setKey(h);
    await change(h, { batchOnly: true });

    await crawlOffers(h, 1);
    await poll(h);
    h.batch.complete();
    await poll(h);

    expect((await status(h)).spend.spentUsd).toBeCloseTo((1000 * 0.1 + 2000 * 0.5) / 1e6 / 2, 9);
  });

  it("counts a request over 100,000 input tokens at the long-prompt rate, output included", async () => {
    const h = boot({
      usage: usage({ inputTokens: 90_000, cacheReadTokens: 20_000, outputTokens: 1000 }),
    });
    await setKey(h);

    await crawlOffers(h, 1);

    // 110,000 input tokens in all: input 0.50 and cache read 0.05, output 2.50 per million.
    const expected = (90_000 * 0.5 + 20_000 * 0.05 + 1000 * 2.5) / 1e6;
    expect((await status(h)).spend.spentUsd).toBeCloseTo(expected, 9);
  });

  it("bills a cut-off answer, and does not try it again: those tokens were used", async () => {
    const h = boot({ script: [new ProviderError("truncated", usage({ outputTokens: 16_000 }))] });
    await setKey(h);

    const [offer] = await crawlOffers(h, 1);

    expect(h.requests).toHaveLength(1);
    expect(offer?.analysisState).toBe("failed");
    expect((await status(h)).spend.spentUsd).toBeCloseTo((1000 * 0.1 + 16_000 * 0.5) / 1e6, 9);
  });

  it("counts nothing for a call the API answered with an error: that bills nothing", async () => {
    const h = boot({ script: [new ProviderError("overloaded")] });
    await setKey(h);

    await crawlOffers(h, 1);

    expect((await status(h)).spend.spentUsd).toBe(0);
  });
});

describe("when the cap is reached", () => {
  it("makes no model call, leaves new Offers pending, says so on /events, and crawling goes on", async () => {
    const h = boot();
    await setKey(h);
    await change(h, { monthlySpendCapUsd: 0.001 });

    const offers = await crawlOffers(h, 3);

    expect(h.requests).toHaveLength(0);
    expect(states(offers)).toEqual(["pending", "pending", "pending"]);
    const now = await status(h);
    expect(now.spend).toMatchObject({ state: "reached", spentUsd: 0, capUsd: 0.001 });
    expect(now.awaiting).toBe(0);
    expect(now.byStatus["waiting-for-cap"]).toBe(3);
    const one = (await h.json("GET", `/offers/${offers[0]?.id}`)).body;
    expect(one.analysisStatus).toEqual({
      status: "waiting-for-cap",
      next: "raise-cap",
      reason: null,
      // The start of December in Berlin.
      at: "2026-11-30T23:00:00.000Z",
      willRead: false,
    });
    h.runtime.analysis.sweep();
    expect(capEvents(h)).toHaveLength(1);
    expect(capEvents(h)[0]?.data).toMatchObject({ month: "2026-11", capUsd: 0.001 });
    expect(offers).toHaveLength(3);
  });

  it("checks before each call, so the call that would pass the cap is never sent", async () => {
    // Each call really costs $0.0076. The cap pays for the first, and what is left cannot pay for
    // the second one's worst case.
    const h = boot({ usage: usage({ inputTokens: 1000, outputTokens: 15_000 }) });
    await setKey(h);
    await change(h, { monthlySpendCapUsd: 0.0095 });

    const offers = await crawlOffers(h, 3);

    expect(h.requests).toHaveLength(1);
    expect(states(offers)).toEqual(["analyzed", "pending", "pending"]);
    expect((await status(h)).spend.spentUsd).toBeCloseTo(0.0076, 9);
  });

  it("stops further spend after a call that used more than it was reserved", async () => {
    const h = boot({ usage: usage({ inputTokens: 3_000_000, outputTokens: 0 }) });
    await setKey(h);
    await change(h, { monthlySpendCapUsd: 0.1 });

    const offers = await crawlOffers(h, 3);

    expect(h.requests).toHaveLength(1);
    expect(states(offers)).toEqual(["analyzed", "pending", "pending"]);
    const now = await status(h);
    expect(now.spend.spentUsd).toBeGreaterThan(0.1);
    expect(now.spend.state).toBe("reached");
    expect(capEvents(h)).toHaveLength(1);
    h.runtime.analysis.sweep();
    await h.runtime.analysis.idle();
    expect(h.requests).toHaveLength(1);
  });

  it("lets the waiting Offers through in the new month, as a backfill, with the cap fresh", async () => {
    // Crawled on the last day of November; each call really costs $0.0076.
    const h = boot({
      usage: usage({ inputTokens: 1000, outputTokens: 15_000 }),
      start: Date.parse("2026-11-30T08:00:00Z"),
    });
    await setKey(h);
    await change(h, { monthlySpendCapUsd: 0.0095 });
    const offers = await crawlOffers(h, 2);
    expect(states(offers)).toEqual(["analyzed", "pending"]);
    expect(capEvents(h).map((event) => (event.data as { state: string }).state)).toEqual([
      "reached",
    ]);

    // 23:30 UTC on the 30th is already 1 December in Berlin: the month's spend is zero again.
    h.clock.now = Date.parse("2026-11-30T23:30:00Z");
    expect((await status(h)).spend).toMatchObject({ month: "2026-12", spentUsd: 0 });
    h.runtime.analysis.sweep();
    await h.runtime.analysis.idle();
    await poll(h);
    h.batch.complete();
    await poll(h);

    // The Offer had waited more than two hours, so it went through the Batch API.
    expect(h.batch.submissions.flat()).toHaveLength(1);
    expect(states((await h.json("GET", "/offers")).body.items)).toEqual(["analyzed", "analyzed"]);
    expect((await status(h)).spend).toMatchObject({ month: "2026-12" });
  });

  it("does not start over a minute early", async () => {
    const h = boot({ start: Date.parse("2026-11-30T08:00:00Z") });
    await setKey(h);
    await change(h, { monthlySpendCapUsd: 0.0095 });
    await crawlOffers(h, 1);
    h.clock.now = Date.parse("2026-11-30T22:59:00Z");

    expect((await status(h)).spend.month).toBe("2026-11");
  });

  it("resumes when the cap is raised", async () => {
    const h = boot();
    await setKey(h);
    await change(h, { monthlySpendCapUsd: 0.001 });
    await crawlOffers(h, 2);
    expect(h.requests).toHaveLength(0);

    await change(h, { monthlySpendCapUsd: 5 });
    await h.runtime.analysis.idle();

    expect(h.requests).toHaveLength(2);
    expect(states((await h.json("GET", "/offers")).body.items)).toEqual(["analyzed", "analyzed"]);
  });

  it("refuses Re-analyse on one Offer with problem+json spend-cap-reached", async () => {
    const h = boot();
    await setKey(h);
    const [offer] = await crawlOffers(h, 1);
    await change(h, { monthlySpendCapUsd: 0 });

    const refused = await h.json("POST", `/offers/${offer?.id}/reanalyze`);

    expect(refused.status).toBe(409);
    expect(refused.body.type).toBe("spend-cap-reached");
    expect(h.requests).toHaveLength(1);
  });

  it("refuses a re-analysis run with problem+json spend-cap-reached, and sends nothing", async () => {
    const h = boot();
    await setKey(h);
    await crawlOffers(h, 1);
    await change(h, { model: "claude-sonnet-5-5", effort: "medium", monthlySpendCapUsd: 0 });

    const refused = await h.json("POST", "/analysis/runs");

    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ type: "spend-cap-reached", status: 409 });
    expect(h.batch.submissions).toHaveLength(0);
    expect(capEvents(h)).toHaveLength(1);
  });

  it("never lets the key into a response or an event", async () => {
    const h = boot();
    await setKey(h);
    await change(h, { monthlySpendCapUsd: 0 });
    await crawlOffers(h, 1);
    const refused = await h.json("POST", "/analysis/runs");

    const everything = JSON.stringify([refused.body, await status(h), h.events]);

    expect(everything).not.toContain("do-not-leak");
  });
});

describe("the cap and the Batch API", () => {
  // Sonnet 5.5 batch calls that really cost $0.075 each: 15,000 output tokens at half of $10.
  const BIG = usage({ inputTokens: 0, outputTokens: 15_000 });

  async function fiveOutdated(options: { cap: number; size: number; usage?: TokenUsage }) {
    const h = boot({
      size: options.size,
      batchUsage: options.usage ?? BIG,
      start: Date.parse("2026-11-30T08:00:00Z"),
    });
    await setKey(h);
    const offers = await crawlOffers(h, 5);
    expect(offers).toHaveLength(5);
    await change(h, {
      model: "claude-sonnet-5-5",
      effort: "medium",
      escalation: null,
      monthlySpendCapUsd: options.cap,
    });
    return h;
  }

  it("reserves each batch's worst case first and stops sending when the cap is spent, mid-run", async () => {
    // A request's worst case is about $0.087 (half of $0.175). The cap pays for a batch of two,
    // the actual cost of which ($0.15) then leaves too little for another request.
    const h = await fiveOutdated({ cap: 0.2, size: 2 });

    const { body: run } = await h.json("POST", "/analysis/runs");
    await poll(h);

    expect(h.batch.submissions.map((batch) => batch.length)).toEqual([2]);
    expect((await h.json("GET", `/analysis/runs/${run.id}`)).body.counts).toMatchObject({
      pending: 5,
    });

    h.batch.complete();
    await poll(h);

    expect(h.batch.submissions).toHaveLength(1);
    const done = (await h.json("GET", `/analysis/runs/${run.id}`)).body;
    expect(done).toMatchObject({
      status: "stopped",
      stopReason: "spend-cap-reached",
      counts: { total: 5, applied: 2, capped: 3, pending: 0 },
    });
    const now = await status(h);
    expect(now.spend.state).toBe("reached");
    expect(now.spend.spentUsd).toBeCloseTo(0.001 + 0.15, 4);
    expect(capEvents(h).map((event) => (event.data as { state: string }).state)).toEqual([
      "waiting-for-in-flight",
      "reached",
    ]);
    expect(now.olderVersion.count).toBe(3);
  });

  it("announces a run the cap stopped once", async () => {
    const h = await fiveOutdated({ cap: 0.2, size: 2 });
    await h.json("POST", "/analysis/runs");
    await poll(h);

    h.batch.complete();
    await poll(h);

    const statuses = h.events
      .filter((event) => event.type === "analysis-run-progress")
      .map((event) => (event.data as { status: string }).status);
    expect(statuses.filter((status) => status === "stopped")).toHaveLength(1);
  });

  it("sends the rest once the batches in flight have given back what they reserved", async () => {
    const h = await fiveOutdated({ cap: 0.3, size: 2, usage: usage() });
    const { body: run } = await h.json("POST", "/analysis/runs");

    await poll(h);
    const firstWave = h.batch.submissions.map((batch) => batch.length);
    h.batch.complete();
    await poll(h);
    h.batch.complete();
    await poll(h);
    h.batch.complete();
    await poll(h);

    // Three requests' worst cases fill the cap; the other two wait for those to be paid for.
    expect(firstWave).toEqual([2, 1]);
    expect(h.batch.submissions.flat()).toHaveLength(5);
    const done = (await h.json("GET", `/analysis/runs/${run.id}`)).body;
    expect(done).toMatchObject({ status: "succeeded", counts: { applied: 5, capped: 0 } });
  });

  it("starts over in the next month: a new run sends what the old one could not", async () => {
    const h = await fiveOutdated({ cap: 0.2, size: 2 });
    await h.json("POST", "/analysis/runs");
    await poll(h);
    h.batch.complete();
    await poll(h);
    expect((await status(h)).olderVersion.count).toBe(3);
    expect((await h.json("POST", "/analysis/runs")).status).toBe(409);

    h.clock.now = Date.parse("2026-12-01T09:00:00Z");
    expect((await status(h)).spend).toMatchObject({
      month: "2026-12",
      spentUsd: 0,
      state: "ok",
    });
    const second = await h.json("POST", "/analysis/runs");
    await poll(h);

    expect(second.status).toBe(202);
    expect(second.body.counts.total).toBe(3);
    expect(h.batch.submissions.map((batch) => batch.length)).toEqual([2, 2]);
    h.batch.complete();
    await poll(h);
    const done = (await h.json("GET", `/analysis/runs/${second.body.id}`)).body;
    expect(done).toMatchObject({ status: "stopped", counts: { applied: 2, capped: 1 } });
    expect((await status(h)).spend.spentUsd).toBeCloseTo(0.15, 4);
  });

  it("holds back an escalation the cap cannot pay for, and the first pass stands", async () => {
    // The first pass costs $0.0076; the cap leaves less than the escalation batch's worst case.
    const h = boot({
      script: [doubtful],
      usage: usage({ inputTokens: 1000, outputTokens: 15_000 }),
    });
    await setKey(h);
    const probe = h.runtime.analysis.spend.estimateMicros(
      {
        model: "claude-haiku-5-5",
        effort: "high",
        prefix: ANALYSIS_PREFIX,
        userTurn: "x".repeat(2000),
      },
      { batch: true },
    );
    expect(probe).toBeGreaterThan(3000);
    await change(h, { monthlySpendCapUsd: 0.011 });

    const [offer] = await crawlOffers(h, 1);
    await poll(h);

    expect(offer?.analysisState).toBe("analyzed");
    expect(h.batch.submissions).toHaveLength(0);
    expect(capEvents(h).map((event) => (event.data as { state: string }).state)).toEqual([
      "reached",
    ]);
    const detail = (await h.json("GET", `/offers/${offer?.id}`)).body;
    expect(detail.analysis.escalated).toBe(false);
    expect(detail.facts.anmeldung.confidence.status).toBe("doubtful");
  });
});

describe("a batch that may have been sent when the process stopped", () => {
  it("is counted at its worst case, since its real cost can never be read back", async () => {
    const options = { sleep: async () => {} };
    const dataDir = tempDataDir();
    const first = bootOffers({ dataDir, analysis: options });
    await first.call("PUT", "/secrets/anthropic", { value: KEY });
    first.site.cards = first.freshCards([9000001]);
    await first.addSearch();
    await first.crawl();
    first.runtime.db.$client
      .prepare(
        "insert into analysis_batches (state, reservedMicros, requestCount, createdAt) values ('submitting', 123456, 1, 0)",
      )
      .run();
    first.runtime.close();

    const second = bootOffers({ dataDir, start: first.clock.now, analysis: options });

    const spend = (await second.json("GET", "/analysis")).body.spend;
    expect(spend.spentUsd).toBeCloseTo(0.123456, 9);
  });
});
