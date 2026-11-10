import { ProviderError } from "@wg-hunt/core";
import { describe, expect, it } from "vitest";
import {
  type Boot,
  boot,
  change,
  crawlOffers,
  MINUTE,
  poll,
  setKey,
  usage,
} from "./analysis-harness.js";

const DAY = 24 * 60 * MINUTE;
const runOf = async (h: Boot, id: number) => (await h.json("GET", `/analysis/runs/${id}`)).body;
const activeRunId = async (h: Boot) => (await h.json("GET", "/analysis")).body.activeRunId;
const wipe = (h: Boot) => h.json("POST", "/storage/wipe", { confirm: "delete all Offer data" });

async function startedRun(h: Boot, offers = 2, patch: Record<string, unknown> = {}) {
  await setKey(h);
  await crawlOffers(h, offers);
  await change(h, { model: "claude-sonnet-5-5", effort: "medium", ...patch });
  const { body: run } = await h.json("POST", "/analysis/runs");
  await poll(h);
  return run as { id: number };
}

describe("a run's outcome is written down when it settles", () => {
  it("keeps a finished run's status, counts and finish time after its Offers are wiped", async () => {
    const h = boot();
    const run = await startedRun(h);
    h.batch.complete();
    await poll(h);
    const settled = await runOf(h, run.id);
    expect(settled).toMatchObject({
      status: "succeeded",
      counts: { total: 2, applied: 2, pending: 0 },
    });

    h.clock.now += 5 * MINUTE;
    expect((await wipe(h)).status).toBe(200);
    await poll(h);

    expect(await runOf(h, run.id)).toEqual(settled);
  });

  it("keeps a finished run's counts when the nightly prune deletes its Offers later", async () => {
    const h = boot();
    const run = await startedRun(h);
    h.batch.complete();
    await poll(h);
    const settled = await runOf(h, run.id);

    h.runtime.db.$client.prepare("DELETE FROM offers").run();
    h.clock.now += 8 * DAY;
    h.runtime.retention.prune();
    await poll(h);

    expect(await runOf(h, run.id)).toEqual(settled);
  });

  it("says a wipe interrupted a run that was still going, and nothing later changes that", async () => {
    const h = boot();
    const run = await startedRun(h);
    h.clock.now += 3 * MINUTE;
    const wipedAt = new Date(h.clock.now).toISOString();

    expect((await wipe(h)).status).toBe(200);

    const interrupted = await runOf(h, run.id);
    expect(interrupted).toMatchObject({
      status: "stopped",
      stopReason: "interrupted",
      finishedAt: wipedAt,
      counts: { total: 2, applied: 0, dropped: 2, pending: 0 },
    });
    expect(await activeRunId(h)).toBeNull();

    h.clock.now += 10 * MINUTE;
    h.batch.complete();
    await poll(h);
    const later = await runOf(h, run.id);
    expect(later).toMatchObject({ ...interrupted, actualCostUsd: expect.any(Number) });
    expect(later.actualCostUsd).toBeGreaterThan(0);
  });

  it("keeps the Offers a run had already finished when a wipe interrupts the rest", async () => {
    const h = boot({ size: 1 });
    const run = await startedRun(h);
    h.batch.complete("batch-1");
    await poll(h);
    expect(await runOf(h, run.id)).toMatchObject({ counts: { applied: 1, pending: 1 } });

    await wipe(h);

    expect(await runOf(h, run.id)).toMatchObject({
      status: "stopped",
      stopReason: "interrupted",
      counts: { total: 2, applied: 1, dropped: 1, pending: 0 },
    });
  });

  it("counts an Offer deleted during a run as dropped, and settles the run at once", async () => {
    const h = boot();
    const run = await startedRun(h);
    const [, gone] = (await h.json("GET", "/offers")).body.items as { id: number }[];
    h.runtime.db.$client.prepare("DELETE FROM offers WHERE id = ?").run(gone?.id);

    h.batch.complete();
    await poll(h);

    expect(await runOf(h, run.id)).toMatchObject({
      status: "succeeded",
      stopReason: null,
      counts: { total: 2, applied: 1, dropped: 1, pending: 0 },
    });
  });

  it("settles a run whose last waiting Offer was deleted, without waiting for a batch", async () => {
    const h = boot();
    const run = await startedRun(h, 1);
    h.runtime.db.$client.prepare("DELETE FROM offers").run();

    expect(await runOf(h, run.id)).toMatchObject({
      status: "succeeded",
      counts: { total: 1, dropped: 1, pending: 0 },
    });
    expect(await activeRunId(h)).toBeNull();
  });

  it("announces how many Offers were applied, so a run whose Offers all went says so", async () => {
    const h = boot();
    const run = await startedRun(h, 1);
    h.runtime.db.$client.prepare("DELETE FROM offers").run();
    await poll(h);

    const progress = h.events.filter((event) => event.type === "analysis-run-progress");
    expect(progress.at(-1)?.data).toMatchObject({
      runId: run.id,
      status: "succeeded",
      applied: 0,
      done: 1,
      total: 1,
    });
  });

  it("announces an interrupted run only once the wipe has committed", async () => {
    const h = boot();
    const run = await startedRun(h);
    h.runtime.db.$client
      .prepare(
        "CREATE TRIGGER fail_wipe BEFORE DELETE ON search_matches BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END",
      )
      .run();
    const before = h.events.length;

    expect((await wipe(h)).status).toBe(500);
    await Promise.resolve();

    expect(await runOf(h, run.id)).toMatchObject({ status: "running", stopReason: null });
    const stopped = h.events
      .slice(before)
      .filter((event) => event.type === "analysis-run-progress" && event.data.status !== "running");
    expect(stopped).toEqual([]);

    h.runtime.db.$client.prepare("DROP TRIGGER fail_wipe").run();
    expect((await wipe(h)).status).toBe(200);
    await Promise.resolve();
    const announced = h.events
      .slice(before)
      .filter((event) => event.type === "analysis-run-progress")
      .map((event) => event.data);
    expect(announced).toEqual([
      expect.objectContaining({ runId: run.id, status: "stopped", stopReason: "interrupted" }),
    ]);
  });

  it("lists the error kinds of the Offers that failed", async () => {
    const h = boot({
      batchScript: (call) =>
        call === 0
          ? new ProviderError("overloaded")
          : call === 1
            ? new ProviderError("overloaded")
            : new ProviderError("server_error"),
    });
    const run = await startedRun(h, 3);
    h.batch.complete();
    await poll(h);

    expect(await runOf(h, run.id)).toMatchObject({
      status: "failed",
      stopReason: null,
      counts: { failed: 3 },
      errorKinds: { overloaded: 2, server_error: 1 },
    });
  });

  it("has no error kinds when nothing failed", async () => {
    const h = boot();
    const run = await startedRun(h, 1);
    h.batch.complete();
    await poll(h);
    expect((await runOf(h, run.id)).errorKinds).toEqual({});
  });
});

describe("a run stopped by the spend cap", () => {
  // Sonnet 5.5 batch requests that really cost $0.075 each.
  const BIG = usage({ inputTokens: 0, outputTokens: 15_000 });

  it("says the cap stopped it when the cap cancels its only batch and nothing is left queued", async () => {
    const h = boot({ batchUsage: BIG, start: Date.parse("2026-11-30T08:00:00Z") });
    const run = await startedRun(h, 2, { escalation: null, monthlySpendCapUsd: 1 });
    expect(h.batch.submissions.map((batch) => batch.length)).toEqual([2]);

    await change(h, { monthlySpendCapUsd: 0.05 });
    await poll(h);
    expect(h.batch.canceled).toEqual(["batch-1"]);
    h.batch.complete();
    await poll(h);

    const done = await runOf(h, run.id);
    expect(done).toMatchObject({
      status: "stopped",
      stopReason: "spend-cap-reached",
      counts: { total: 2, failed: 0, capped: 2, pending: 0 },
    });
    expect(done.finishedAt).not.toBeNull();
  });
});

describe("the batch loop's wake-up", () => {
  it("looks again right after the current pass when it is woken during one", async () => {
    const h = boot();
    await startedRun(h, 1);
    const batch = h.runtime.analysis.batch;
    const provider = h.batch.provider;
    const original = provider.status.bind(provider);
    let looks = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.status = async (id) => {
      looks++;
      if (looks === 1) await gate;
      return original(id);
    };

    batch.kick();
    // Woken while the pass is waiting on the API: the wake-up must not be lost.
    await Promise.resolve();
    batch.kick();
    release();
    await batch.idle();

    expect(looks).toBe(2);
  });
});
