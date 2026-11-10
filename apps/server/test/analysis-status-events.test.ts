import { ProviderError } from "@wg-hunt/core";
import { describe, expect, it } from "vitest";
import { loadAnalysisSettings, saveAnalysisSettings } from "../src/analysis-settings.js";
import {
  anmeldungOk,
  type Boot,
  boot,
  change,
  crawlOffers,
  poll,
  setKey,
  status,
} from "./analysis-harness.js";

const last = (h: Boot) => snapshots(h).at(-1);

async function inBatch() {
  const h = boot();
  await setKey(h);
  await change(h, { batchOnly: true });
  await crawlOffers(h, 1);
  await poll(h);
  expect(h.batch.submissions).toHaveLength(1);
  return h;
}

const snapshots = (h: Boot) =>
  h.events
    .filter((event) => event.type === "analysis-status-changed")
    .map((event) => JSON.parse(JSON.stringify(event.data)));

describe("analysis-status-changed", () => {
  it("is published once when the analysis settings change, carrying GET /analysis", async () => {
    const h = boot();
    await setKey(h);
    await crawlOffers(h, 2);
    h.events.length = 0;

    await change(h, { model: "claude-sonnet-5-5", effort: "medium" });

    const sent = snapshots(h);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(await status(h));
    expect(sent[0].olderVersion.count).toBeGreaterThan(0);
  });

  it("is not published again when the same settings are saved again", async () => {
    const h = boot();
    await setKey(h);
    await crawlOffers(h, 1);
    await change(h, { model: "claude-sonnet-5-5", effort: "medium" });
    h.events.length = 0;

    await change(h, {});

    expect(snapshots(h)).toEqual([]);
  });
});

describe("analysis-status-changed for the key", () => {
  it("is published when the key is saved and when it is cleared", async () => {
    const h = boot();

    await setKey(h);
    expect(last(h)).toMatchObject({ key: "present" });

    expect((await h.call("DELETE", "/secrets/anthropic")).status).toBe(204);
    expect(last(h)).toMatchObject({ key: "absent" });
    expect(last(h)).toEqual(await status(h));
  });

  it("is published when the API refuses the key, and when a key is saved after that", async () => {
    let refuse = true;
    const h = boot({ script: () => (refuse ? new ProviderError("unauthorized") : anmeldungOk) });
    await setKey(h);
    h.events.length = 0;

    await crawlOffers(h, 1);
    expect(last(h)).toMatchObject({ key: "refused" });

    refuse = false;
    await setKey(h);
    expect(last(h)).toMatchObject({ key: "present" });
  });

  it("is published when a batch poll is refused, and when one goes through after a refusal", async () => {
    const h = await inBatch();
    h.events.length = 0;

    h.batch.control.failStatus = new ProviderError("unauthorized");
    await poll(h);
    expect(last(h)).toMatchObject({ key: "refused" });

    h.batch.control.failStatus = undefined;
    await poll(h);
    expect(last(h)).toMatchObject({ key: "present" });
  });
});

describe("analysis-status-changed for the cap", () => {
  it("is published when the cap is lowered through the API", async () => {
    const h = boot();
    await setKey(h);
    h.events.length = 0;

    await change(h, { monthlySpendCapUsd: 0 });

    expect(last(h)).toMatchObject({ spend: { state: "reached", capUsd: 0 } });
  });

  it("is published when the ledger finds the cap state changed", async () => {
    const h = boot();
    await setKey(h);
    const db = h.runtime.db;
    saveAnalysisSettings(db, { ...loadAnalysisSettings(db), monthlySpendCapUsd: 0 });
    h.events.length = 0;

    h.runtime.analysis.sweep();
    await h.runtime.analysis.idle();

    expect(last(h)).toMatchObject({ spend: { state: "reached" } });
  });
});

async function startedRun(h: Boot) {
  await setKey(h);
  await crawlOffers(h, 2);
  await change(h, { model: "claude-sonnet-5-5", effort: "medium" });
  h.events.length = 0;
  const started = await h.json("POST", "/analysis/runs");
  expect(started.status).toBe(202);
  return started.body as { id: number };
}

describe("analysis-status-changed for a run", () => {
  it("is published when a run starts and when it finishes", async () => {
    const h = boot();
    const run = await startedRun(h);
    expect(last(h)).toMatchObject({ activeRunId: run.id });

    await poll(h);
    h.batch.complete();
    await poll(h);

    expect(last(h)).toMatchObject({ activeRunId: null, olderVersion: { count: 0 } });
    expect(last(h)).toEqual(await status(h));
  });

  it("is published once a wipe has interrupted the run", async () => {
    const h = boot();
    await startedRun(h);
    await poll(h);
    h.events.length = 0;

    const wiped = await h.json("POST", "/storage/wipe", { confirm: "delete all Offer data" });

    expect(wiped.status).toBe(200);
    expect(last(h)).toMatchObject({ activeRunId: null });
  });
});
