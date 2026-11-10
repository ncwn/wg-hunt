import { ProviderError } from "@wg-hunt/core";
import { describe, expect, it } from "vitest";
import {
  type Boot,
  boot,
  crawlOffers,
  editedPage,
  MINUTE,
  recheck,
  setKey,
  status,
  usage,
} from "./analysis-harness.js";

async function sweepAt(h: Boot, from: number, minutes: number) {
  h.clock.now = from + minutes * MINUTE;
  h.runtime.analysis.sweep();
  await h.runtime.analysis.idle();
  return h.requests.length;
}

describe("an Offer the model refused or cut off", () => {
  it.each(["truncated", "refused"] as const)(
    "is not sent again for being %s, however long it waits, because every try is billed",
    async (kind) => {
      const h = boot({ script: [new ProviderError(kind, usage({ outputTokens: 16_000 }))] });
      await setKey(h);
      const [offer] = await crawlOffers(h, 1);
      expect(offer?.analysisState).toBe("failed");
      const first = h.requests.length;
      const from = h.clock.now;

      expect(await sweepAt(h, from, 11)).toBe(first);
      expect(await sweepAt(h, from, 6 * 60)).toBe(first);
      expect(await sweepAt(h, from, 3 * 24 * 60)).toBe(first);
    },
  );

  it("is read again when the seeker clicks Re-analyse", async () => {
    const h = boot({ script: [new ProviderError("truncated", usage({ outputTokens: 16_000 }))] });
    await setKey(h);
    const [offer] = await crawlOffers(h, 1);
    const first = h.requests.length;

    await h.json("POST", `/offers/${offer?.id}/reanalyze`);
    await h.runtime.analysis.idle();

    expect(h.requests.length).toBeGreaterThan(first);
  });

  it("is read again when the Advertiser has changed the words", async () => {
    const h = boot({ script: [new ProviderError("truncated", usage({ outputTokens: 16_000 }))] });
    await setKey(h);
    await crawlOffers(h, 1);
    const first = h.requests.length;
    await sweepAt(h, h.clock.now, 60);
    expect(h.requests.length).toBe(first);

    recheck(h, editedPage());
    await h.runtime.analysis.idle();

    expect(h.requests.length).toBeGreaterThan(first);
  });
});

describe("an Offer whose calls failed for another reason", () => {
  it("waits twice as long after each attempt, and stops after five", async () => {
    const h = boot({
      script: [new ProviderError("server_error")],
      batchScript: [new ProviderError("server_error")],
    });
    await setKey(h);
    const [offer] = await crawlOffers(h, 1);
    expect(offer?.analysisState).toBe("failed");
    // The first call and its three retries.
    expect(h.requests).toHaveLength(4);
    const from = h.clock.now;

    // The next attempt is not due for 10 minutes, then 20, 40 and 80.
    expect(await sweepAt(h, from, 8)).toBe(4);
    expect(await sweepAt(h, from, 12)).toBe(8);
    expect(await sweepAt(h, from, 12 + 18)).toBe(8);
    expect(await sweepAt(h, from, 12 + 22)).toBe(12);
    expect(await sweepAt(h, from, 34 + 38)).toBe(12);
    expect(await sweepAt(h, from, 34 + 42)).toBe(16);
    expect(await sweepAt(h, from, 76 + 78)).toBe(16);
    // By the fifth attempt the Offer is hours old: a backfill, retried at the batch price.
    expect(await sweepAt(h, from, 76 + 82)).toBe(16);
    await h.runtime.analysis.pollBatches();
    expect(h.batch.submissions).toHaveLength(1);
    h.batch.complete();
    await h.runtime.analysis.pollBatches();
    // Five attempts in a row: it waits for the seeker.
    expect(await sweepAt(h, from, 24 * 60)).toBe(16);
    expect(await sweepAt(h, from, 3 * 24 * 60)).toBe(16);
    await h.runtime.analysis.pollBatches();
    expect(h.batch.submissions).toHaveLength(1);
    expect((await status(h)).counts.failed).toBe(1);
  });

  it("tries a refused key again at every sweep, since that costs nothing", async () => {
    const h = boot({ script: [new ProviderError("unauthorized")] });
    await setKey(h);
    await crawlOffers(h, 1);
    expect(h.requests).toHaveLength(1);

    expect(await sweepAt(h, h.clock.now, 1)).toBe(2);
    expect(await sweepAt(h, h.clock.now, 1)).toBe(3);
  });
});

describe("a call that timed out or lost its connection", () => {
  const worst = (h: Boot) =>
    h.runtime.analysis.spend.estimateMicros(h.requests[0] as never, { batch: false }) ?? 0;

  it.each(["timeout", "network"] as const)(
    "is counted at its reserved worst case on %s, since it may have been billed",
    async (kind) => {
      const h = boot({ script: [new ProviderError(kind)] });
      await setKey(h);

      await crawlOffers(h, 1);

      expect(h.requests).toHaveLength(4);
      expect(worst(h)).toBeGreaterThan(5000);
      expect((await status(h)).spend.spentUsd).toBeCloseTo((4 * worst(h)) / 1e6, 9);
    },
  );

  it("is not counted when the API answered with an error: that bills nothing", async () => {
    const h = boot({ script: [new ProviderError("overloaded")] });
    await setKey(h);

    await crawlOffers(h, 1);

    expect(h.requests).toHaveLength(4);
    expect((await status(h)).spend.spentUsd).toBe(0);
  });

  it("takes the spend to the cap in the end, so a flaky connection cannot spend without limit", async () => {
    const h = boot({ script: [new ProviderError("timeout")] });
    await setKey(h);
    const current = (await h.json("GET", "/settings/analysis")).body;
    // Room for two worst cases and not for a third.
    await h.json("PUT", "/settings/analysis", { ...current, monthlySpendCapUsd: 0.02 });

    await crawlOffers(h, 1);

    expect(h.requests).toHaveLength(2);
    const now = await status(h);
    expect(now.spend.spentUsd).toBeLessThanOrEqual(0.02);
    expect(now.spend.spentUsd).toBeGreaterThan(0.015);
  });
});
