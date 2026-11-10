import { ERROR_KINDS, PROVIDER_ERROR_KINDS, ProviderError, policyOf } from "@wg-hunt/core";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createBatchState } from "../src/analysis/batch-state.js";
import { MAX_ATTEMPTS, mayRetry } from "../src/analysis/retry.js";
import { analysisBatches, analysisItems } from "../src/db/schema.js";
import {
  anmeldungOk,
  type Boot,
  boot,
  change,
  crawlOffers,
  doubtful,
  MINUTE,
  poll,
  setKey,
  usage,
} from "./analysis-harness.js";

const DAY = 24 * 60 * MINUTE;
const runOf = async (h: Boot, id: number) => (await h.json("GET", `/analysis/runs/${id}`)).body;
const reserved = (h: Boot) => h.runtime.analysis.spend.reservedMicros();
const batches = (h: Boot) => h.runtime.db.select().from(analysisBatches).all();
const items = (h: Boot) => h.runtime.db.select().from(analysisItems).all();

async function startedRun(h: Boot, count = 2) {
  await setKey(h);
  const offers = await crawlOffers(h, count);
  await change(h, { model: "claude-sonnet-5-5", effort: "medium" });
  const { body: run } = await h.json("POST", "/analysis/runs");
  return { run, offers };
}

describe("a batch canceled because the cap was lowered", () => {
  // Sonnet 5.5 batch requests that really cost $0.075 each.
  const BIG = usage({ inputTokens: 0, outputTokens: 15_000 });

  it("is canceling until it ends, and its unfinished requests are capped, not failed", async () => {
    const h = boot({ size: 2, batchUsage: BIG, start: Date.parse("2026-11-30T08:00:00Z") });
    await setKey(h);
    const offers = await crawlOffers(h, 2);
    await change(h, {
      model: "claude-sonnet-5-5",
      effort: "medium",
      escalation: null,
      monthlySpendCapUsd: 0.2,
    });
    const { body: run } = await h.json("POST", "/analysis/runs");
    await poll(h);
    await change(h, { monthlySpendCapUsd: 0.05 });
    await poll(h);

    expect(batches(h)).toMatchObject([{ state: "canceling", endReason: null }]);

    h.batch.complete();
    await poll(h);

    expect(batches(h)).toMatchObject([{ state: "ended", endReason: "completed" }]);
    expect(await runOf(h, run.id)).toMatchObject({
      status: "stopped",
      stopReason: "spend-cap-reached",
      counts: { capped: 2, failed: 0 },
    });
    for (const offer of offers) {
      expect(h.runtime.offers.analysisJob(offer.id)?.failure).toBeNull();
    }
  });

  it("leaves the Offer as it was when the request was a run's escalation", async () => {
    // The run's first pass needs an escalation, which goes out as a second batch.
    const h = boot({ batchScript: [doubtful] });
    const { run, offers } = await startedRun(h, 1);
    await poll(h);
    h.batch.complete();
    await poll(h);
    expect(h.batch.submissions).toHaveLength(2);

    const spent = (await h.json("GET", "/analysis")).body.spend.spentUsd as number;
    await change(h, { monthlySpendCapUsd: spent + 0.000001 });
    await poll(h);
    expect(h.batch.canceled).toEqual(["batch-2"]);
    h.batch.complete();
    await poll(h);

    expect(await runOf(h, run.id)).toMatchObject({
      status: "stopped",
      stopReason: "spend-cap-reached",
      counts: { capped: 1, failed: 0 },
    });
    const id = offers[0]?.id as number;
    expect(h.runtime.offers.analysisJob(id)?.failure).toBeNull();
    expect((await h.json("GET", `/offers/${id}`)).body.analysisStatus).toMatchObject({
      status: "older-version",
      reason: null,
    });
  });
});

describe("looking at a batch in flight", () => {
  it("counts rejections from a fresh start after a look that worked", async () => {
    const h = boot();
    await startedRun(h);
    await poll(h);
    h.batch.control.failStatus = new ProviderError("rejected");
    for (let i = 0; i < 4; i++) await poll(h);

    h.batch.control.failStatus = undefined;
    h.batch.control.failResults = new ProviderError("rejected");
    h.batch.complete();
    await poll(h);

    expect(reserved(h)).toBeGreaterThan(0);
    expect(batches(h)).toMatchObject([{ state: "in_progress", checkFailures: 1 }]);
  });
});

describe("how a batch ended", () => {
  it("says completed when its results were read", async () => {
    const h = boot();
    await startedRun(h);
    await poll(h);
    h.batch.complete();
    await poll(h);
    expect(batches(h)).toMatchObject([{ state: "ended", endReason: "completed" }]);
  });

  it("says never_created when a send of unknown outcome is known not to have made one", async () => {
    const h = boot();
    h.batch.control.failSubmit = new ProviderError("network");
    await startedRun(h);
    await poll(h);
    h.clock.now += 11 * MINUTE;
    h.batch.control.failSubmit = undefined;
    await poll(h);
    expect(batches(h)[0]).toMatchObject({ state: "ended", endReason: "never_created" });
    expect(batches(h)[1]).toMatchObject({ state: "in_progress" });
  });

  it("says send_refused when the API refused the send", async () => {
    const h = boot();
    h.batch.control.failSubmit = new ProviderError("unauthorized");
    await startedRun(h);
    await poll(h);
    expect(batches(h)).toMatchObject([{ state: "ended", endReason: "send_refused" }]);
  });

  it("says given_up when its results can never be read", async () => {
    const h = boot();
    await startedRun(h);
    await poll(h);
    h.clock.now += 29 * DAY;
    await poll(h);
    expect(batches(h)).toMatchObject([{ state: "ended", endReason: "given_up" }]);
  });
});

describe("ended batches", () => {
  it("are forgotten a week after they ended; a run's items stay", async () => {
    const h = boot();
    const { run } = await startedRun(h);
    await poll(h);
    h.batch.complete();
    await poll(h);
    expect(batches(h)).toHaveLength(1);

    h.clock.now += 6 * DAY;
    await poll(h);
    expect(batches(h)).toHaveLength(1);

    h.clock.now += 2 * DAY;
    await poll(h);
    expect(batches(h)).toHaveLength(0);
    expect(items(h).map((item) => item.batchId)).toEqual([null, null]);
    expect(await runOf(h, run.id)).toMatchObject({ status: "succeeded", counts: { applied: 2 } });
  });

  it("do not pile up while a refused key turns every send away", async () => {
    const h = boot();
    await setKey(h);
    await change(h, { batchOnly: true });
    h.batch.control.failSubmit = new ProviderError("unauthorized");
    await crawlOffers(h, 1);
    let sends = 0;
    for (let day = 0; day < 10; day++) {
      for (let look = 0; look < 4; look++) {
        h.clock.now += 6 * 60 * MINUTE;
        h.runtime.analysis.sweep();
        await h.runtime.analysis.idle();
        await poll(h);
        sends++;
      }
    }
    const left = batches(h);
    expect(left.length).toBeGreaterThan(0);
    expect(left.length).toBeLessThan(sends);
    for (const batch of left) {
      expect(batch.endReason).toBe("send_refused");
      expect(h.clock.now - (batch.endedAt?.getTime() ?? 0)).toBeLessThanOrEqual(7 * DAY);
    }
  });
});

describe("starting a send", () => {
  it("writes the batch and its items together, or not at all", async () => {
    const h = boot();
    await setKey(h);
    const offers = await crawlOffers(h, 2);
    await change(h, { batchOnly: true });
    const { batch } = h.runtime.analysis;
    const settings = (await h.json("GET", "/settings/analysis")).body;
    batch.enqueue(h.runtime.offers.analysisJobs(), { plan: batch.planOf(settings) });
    const queued = items(h);
    expect(queued.map((item) => item.state)).toEqual(["queued", "queued"]);
    const state = createBatchState({
      db: h.runtime.db,
      clock: () => h.clock.now,
      offers: h.runtime.offers,
    });
    const [first, second] = queued;
    if (first === undefined || second === undefined) throw new Error("two items");
    expect(state.moveItem(second, { to: "dropped" })).toBe(true);

    expect(() =>
      state.beginSend({ items: [first, second], reservedMicros: 10, requests: [] }),
    ).toThrow();

    expect(batches(h)).toHaveLength(0);
    expect(
      h.runtime.db.select().from(analysisItems).where(eq(analysisItems.id, first.id)).get(),
    ).toMatchObject({ state: "queued", batchId: null });
    expect(offers).toHaveLength(2);
  });

  it("refuses a move from a state that does not allow it", async () => {
    const h = boot();
    await setKey(h);
    await crawlOffers(h, 1);
    const { batch } = h.runtime.analysis;
    const settings = (await h.json("GET", "/settings/analysis")).body;
    batch.enqueue(h.runtime.offers.analysisJobs(), { plan: batch.planOf(settings) });
    const [item] = items(h);
    if (item === undefined) throw new Error("one item");
    const state = createBatchState({
      db: h.runtime.db,
      clock: () => h.clock.now,
      offers: h.runtime.offers,
    });
    expect(state.moveItem(item, { to: "applied" })).toBe(false);
    expect(state.moveItem(item, { to: "dropped" })).toBe(true);
    expect(state.moveItem(item, { to: "queued" })).toBe(false);
  });
});

describe("the error-kind table", () => {
  it("has a policy for every kind a provider can report", () => {
    for (const kind of PROVIDER_ERROR_KINDS) expect(ERROR_KINDS[kind]).toBeDefined();
    expect(ERROR_KINDS.no_stored_page).toBeDefined();
    expect(ERROR_KINDS.unreadable_page).toBeDefined();
  });

  it("never counts an attempt for what is not a failure of the Offer", () => {
    for (const policy of Object.values(ERROR_KINDS)) {
      if (policy.perOffer === "not-a-failure" || policy.perOffer === "free") {
        expect(policy.countsAsAttempt).toBe(false);
      }
    }
  });

  it("treats a kind it does not know (an older row) as one that backs off", () => {
    expect(policyOf("something_old").perOffer).toBe("backoff");
  });

  it("lets an Offer whose model was not priced be read once the price table knows it", () => {
    const failure = { kind: "unpriced", at: 0, attempts: MAX_ATTEMPTS + 3, contentHash: "h" };
    expect(mayRetry({ failure, contentHash: "h" }, 1)).toBe(true);
  });
});

describe("a refused, cut-off or unusable answer", () => {
  it.each(["refused", "truncated", "invalid_response"] as const)(
    "is not tried again within the call when %s, since every try is billed",
    async (kind) => {
      const h = boot({ script: [new ProviderError(kind, usage({ outputTokens: 16_000 }))] });
      await setKey(h);
      await crawlOffers(h, 1);
      expect(h.requests).toHaveLength(1);
    },
  );
});

describe("settling an item", () => {
  it("is reported once, whichever way it settles", async () => {
    const h = boot();
    await setKey(h);
    await crawlOffers(h, 3);
    const { batch } = h.runtime.analysis;
    const settings = (await h.json("GET", "/settings/analysis")).body;
    batch.enqueue(h.runtime.offers.analysisJobs(), { plan: batch.planOf(settings) });
    const settled: string[] = [];
    const state = createBatchState({
      db: h.runtime.db,
      clock: () => h.clock.now,
      offers: h.runtime.offers,
      onSettled: (item) => settled.push(`${item.id}:${item.state}`),
    });
    const [a, b, c] = items(h);
    if (a === undefined || b === undefined || c === undefined) throw new Error("three items");

    state.moveItem(a, { to: "dropped" });
    state.moveItem(a, { to: "dropped" });
    const sent = state.beginSend({ items: [b, c], reservedMicros: 10, requests: [] });
    expect(settled).toEqual([`${a.id}:dropped`]);
    state.moveItem(b, { to: "failed", kind: "canceled" });
    state.moveBatch(sent, { to: "ended", reason: "given_up", kind: "expired" });

    expect(settled).toEqual([`${a.id}:dropped`, `${b.id}:capped`, `${c.id}:failed`]);
  });

  it.each([
    ["the cap stopped it", { to: "capped" }],
    ["its batch was canceled", { to: "failed", kind: "canceled" }],
    ["its send met the cap", { to: "failed", kind: "spend_cap_reached" }],
  ] as const)("as capped tells the Offer of a click's escalation, when %s", async (_, move) => {
    // A click on an analyzed Offer whose first pass needs an escalation: the Offer keeps its result.
    const h = boot({ script: [anmeldungOk, doubtful] });
    await setKey(h);
    const [offer] = await crawlOffers(h, 1);
    const id = offer?.id as number;
    expect(h.runtime.analysis.reanalyze(id)).toBe("queued");
    await h.runtime.analysis.idle();
    const [item] = items(h);
    if (item === undefined) throw new Error("one item");
    expect(item).toMatchObject({ offerId: id, stage: 2, runId: null, state: "submitted" });
    const state = createBatchState({
      db: h.runtime.db,
      clock: () => h.clock.now,
      offers: h.runtime.offers,
    });

    expect(state.moveItem(item, move)).toBe(true);

    expect(items(h)).toMatchObject([{ state: "capped" }]);
    expect(h.runtime.offers.analysisJob(id)).toMatchObject({
      state: "analyzed",
      failure: { kind: "spend_cap_reached" },
    });
  });
});
