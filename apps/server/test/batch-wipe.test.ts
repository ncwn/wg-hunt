import { ANALYSIS_PREFIX, ProviderError } from "@wg-hunt/core";
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
} from "./analysis-harness.js";

const DAY = 24 * 60 * MINUTE;
const runOf = async (h: Boot, id: number) => (await h.json("GET", `/analysis/runs/${id}`)).body;
const reserved = (h: Boot) => h.runtime.analysis.spend.reservedMicros();
const count = (h: Boot, table: string) =>
  (h.runtime.db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

async function startedRun(h: Boot, offers = 2) {
  await setKey(h);
  await crawlOffers(h, offers);
  await change(h, { model: "claude-sonnet-5-5", effort: "medium" });
  const { body: run } = await h.json("POST", "/analysis/runs");
  return run;
}

describe("Offers deleted while a batch is out", () => {
  it("still counts the batch's usage when a wipe deleted the Offers, and keeps the ledger and the batch row", async () => {
    const h = boot();
    const run = await startedRun(h);
    await poll(h);
    const spentBefore = (await status(h)).spend.spentUsd;
    const usageRows = count(h, "analysis_usage");
    expect(h.runtime.analysis.spend.reservedMicros()).toBeGreaterThan(0);

    const wiped = await h.json("POST", "/storage/wipe", { confirm: "delete all Offer data" });

    expect(wiped.status).toBe(200);
    expect(count(h, "offers")).toBe(0);
    expect(count(h, "analysis_items")).toBe(0);
    expect(count(h, "analysis_usage")).toBe(usageRows);
    expect(count(h, "analysis_batches")).toBe(1);
    expect(reserved(h)).toBeGreaterThan(0);

    h.batch.complete();
    await poll(h);

    // Two results of 1,000 input and 200 output tokens at Sonnet 5.5's $2 / $10, at half price.
    expect((await status(h)).spend.spentUsd).toBeCloseTo(spentBefore + 2 * 0.002, 9);
    expect(reserved(h)).toBe(0);
    expect(count(h, "analysis_batches")).toBe(1);
    expect(h.runtime.db.$client.prepare("SELECT state FROM analysis_batches").get()).toEqual({
      state: "ended",
    });
    expect(await runOf(h, run.id)).toMatchObject({
      status: "stopped",
      stopReason: "interrupted",
      counts: { total: 2, dropped: 2, pending: 0 },
    });
    expect((await runOf(h, run.id)).actualCostUsd).toBeCloseTo(2 * 0.002, 9);
    expect(count(h, "offers")).toBe(0);
  });

  it("does the same when only some Offers were deleted, as the nightly prune does", async () => {
    const h = boot();
    const run = await startedRun(h, 2);
    await poll(h);
    const spentBefore = (await status(h)).spend.spentUsd;
    const [kept, gone] = (await h.json("GET", "/offers")).body.items as { id: number }[];
    // What the prune does to an Offer: the row goes, and the items cascade.
    h.runtime.db.$client.prepare("DELETE FROM offers WHERE id = ?").run(gone?.id);
    h.runtime.retention.prune();
    expect(count(h, "analysis_batches")).toBe(1);

    h.batch.complete();
    await poll(h);

    expect((await status(h)).spend.spentUsd).toBeCloseTo(spentBefore + 2 * 0.002, 9);
    expect(await runOf(h, run.id)).toMatchObject({
      status: "succeeded",
      counts: { total: 2, applied: 1, dropped: 1 },
    });
    expect((await offerOf(h, kept?.id as number)).analysis.model).toBe("claude-sonnet-5-5");
  });

  it("never lets the nightly prune touch the spend ledger or a batch in flight", async () => {
    const h = boot();
    await startedRun(h);
    await poll(h);
    const before = [count(h, "analysis_usage"), count(h, "analysis_batches")];

    for (let night = 0; night < 3; night++) {
      h.clock.now += DAY;
      h.runtime.retention.prune();
    }

    expect([count(h, "analysis_usage"), count(h, "analysis_batches")]).toEqual(before);
  });
});

describe("one send of unknown outcome at a time", () => {
  it("sends no second batch while the first may exist", async () => {
    const h = boot({ size: 1 });
    h.batch.control.failSubmit = new ProviderError("timeout");
    await startedRun(h, 2);
    await poll(h);
    h.batch.control.failSubmit = undefined;

    // Within the grace period the first send is still unresolved, so the second request waits.
    await poll(h);
    await poll(h);
    expect(h.batch.submissions).toHaveLength(0);

    // Known not to exist after the grace: both go out, one batch at a time.
    h.clock.now += 11 * MINUTE;
    await poll(h);
    expect(h.batch.submissions.map((batch) => batch.length)).toEqual([1, 1]);
  });

  it("does not take someone else's batch of the same size for its own", async () => {
    const h = boot();
    h.batch.control.failSubmit = new ProviderError("timeout");
    const run = await startedRun(h, 2);
    await poll(h);
    const held = reserved(h);
    expect(held).toBeGreaterThan(0);
    const before = (await status(h)).spend.spentUsd;
    h.batch.control.failSubmit = undefined;
    // A foreign batch with as many requests appears, and is adopted by what it holds...
    const request = {
      model: "claude-sonnet-5-5",
      effort: "medium" as const,
      prefix: ANALYSIS_PREFIX,
      userTurn: "x",
    };
    await h.batch.provider.submit([
      { customId: "foreign-1", request },
      { customId: "foreign-2", request },
    ]);
    await poll(h);
    h.batch.complete();

    await poll(h);

    expect((await status(h)).spend.spentUsd).toBeCloseTo(before + held / 1e6, 9);
    expect(reserved(h)).toBe(0);
    expect(await runOf(h, run.id)).toMatchObject({ status: "failed", counts: { failed: 2 } });
  });
});

describe("a batch that outlives the key", () => {
  const noKey = async (h: Boot) => {
    expect((await h.call("DELETE", "/secrets/anthropic")).status).toBe(204);
  };

  it("gives up an unresolved send after 29 days even with no key", async () => {
    const h = boot();
    h.batch.control.failSubmit = new ProviderError("network");
    await startedRun(h);
    await poll(h);
    const held = reserved(h);
    await noKey(h);

    h.clock.now += 29 * DAY;
    await poll(h);

    expect(reserved(h)).toBe(0);
    expect((await status(h)).spend.spentUsd).toBeCloseTo(held / 1e6, 9);
  });

  it("gives up a batch in flight after 29 days even with no key", async () => {
    const h = boot();
    await startedRun(h);
    await poll(h);
    const held = reserved(h);
    await noKey(h);

    h.clock.now += 29 * DAY;
    await poll(h);

    expect(reserved(h)).toBe(0);
    expect((await status(h)).spend.spentUsd).toBeCloseTo(held / 1e6, 9);
  });
});
