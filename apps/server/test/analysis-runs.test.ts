import { ProviderError } from "@wg-hunt/core";
import {
  fakeBatchProvider,
  fakeProvider,
  outputWith,
  sure,
  unsure,
} from "@wg-hunt/core/analysis/testing";
import { describe, expect, it } from "vitest";
import { tempDataDir } from "./helpers.js";
import { bootOffers, MINUTE } from "./offers-harness.js";

const KEY = "sk-ant-api03-test-key-do-not-leak-0123456789";

const anmeldungOk = outputWith({
  anmeldung: { value: "possible", ...sure("Anmeldung ist möglich") },
});
const doubtful = outputWith({
  anmeldung: { value: "conditional", ...unsure("Anmeldung ist möglich") },
});

type Usage = Parameters<typeof fakeProvider>[1] extends { usage?: infer U } | undefined ? U : never;

function boot(
  options: {
    script?: Parameters<typeof fakeProvider>[0];
    batchScript?: Parameters<typeof fakeBatchProvider>[0];
    usage?: Usage;
    batchUsage?: Usage;
    size?: number;
  } = {},
) {
  const realtime = fakeProvider(options.script ?? [anmeldungOk], {
    ...(options.usage && { usage: options.usage }),
  });
  const batch = fakeBatchProvider(options.batchScript ?? [anmeldungOk], {
    ...(options.batchUsage && { usage: options.batchUsage }),
  });
  const h = bootOffers({
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

const settingsOf = async (h: Boot) => (await h.json("GET", "/settings/analysis")).body;
async function change(h: Boot, patch: Record<string, unknown>) {
  const res = await h.json("PUT", "/settings/analysis", { ...(await settingsOf(h)), ...patch });
  expect(res.status).toBe(200);
}
/** Another analysis version than the default, Haiku 5.5 at medium. */
const useSonnet = (h: Boot) => change(h, { model: "claude-sonnet-5-5", effort: "medium" });

async function analysedOffers(h: Boot, count: number) {
  const ids = Array.from({ length: count }, (_, i) => 9000001 + i);
  h.site.cards = h.freshCards(ids);
  await h.addSearch();
  await h.crawl();
  await h.runtime.analysis.idle();
  const list = (await h.json("GET", "/offers")).body.items as { id: number }[];
  expect(list).toHaveLength(count);
  return list.map((offer) => offer.id);
}

const status = async (h: Boot) => (await h.json("GET", "/analysis")).body;
const offerOf = async (h: Boot, id: number) => (await h.json("GET", `/offers/${id}`)).body;
const startRun = (h: Boot) => h.json("POST", "/analysis/runs");
const poll = (h: Boot) => h.runtime.analysis.pollBatches();

describe("the analysis version", () => {
  it("is the same for every result made with the same settings, so nothing is outdated", async () => {
    const h = boot();
    await setKey(h);
    await analysedOffers(h, 2);

    const now = await status(h);

    expect(now.version).toMatch(/^[0-9a-f]{16}$/);
    expect(now.olderVersion).toEqual({ count: 0, estimatedCostUsd: 0 });
  });

  it("marks existing results outdated when the model changes, with a cost estimate, and re-runs nothing", async () => {
    const h = boot();
    await setKey(h);
    await analysedOffers(h, 2);
    const before = await status(h);
    const calls = h.requests.length;

    await useSonnet(h);
    await h.runtime.analysis.idle();
    await poll(h);

    const now = await status(h);
    expect(now.version).not.toBe(before.version);
    expect(now.olderVersion.count).toBe(2);
    // Per Offer, as a batch (half price): 2,000 input and 3,000 cache-read tokens and 1,400 output
    // tokens at Sonnet 5.5's $2 / $10, plus a fifth of the escalation pass at Haiku 5.5, high effort:
    // 2,000, 3,000 and 3,400 tokens at $0.10 / $0.01 / $0.50.
    const sonnet = (2000 * 2 + 3000 * 0.2 + 1400 * 10) / 1e6 / 2;
    const haikuHigh = (2000 * 0.1 + 3000 * 0.01 + 3400 * 0.5) / 1e6 / 2;
    expect(now.olderVersion.estimatedCostUsd).toBeCloseTo(2 * (sonnet + 0.2 * haikuHigh), 8);
    expect(h.requests).toHaveLength(calls);
    expect(h.batch.submissions).toHaveLength(0);
    expect(
      (await offerOf(h, (await h.json("GET", "/offers")).body.items[0].id)).analysis.model,
    ).toBe("claude-haiku-5-5");
  });

  it("is on each Offer's analysis, with whether it differs from the current settings'", async () => {
    const h = boot();
    await setKey(h);
    const [id] = await analysedOffers(h, 1);
    const current = (await status(h)).version;

    expect((await offerOf(h, id as number)).analysis).toMatchObject({
      state: "analyzed",
      analysisVersion: current,
      olderVersion: false,
    });

    await useSonnet(h);
    expect((await offerOf(h, id as number)).analysis).toMatchObject({
      analysisVersion: current,
      olderVersion: true,
    });
    expect((await offerOf(h, id as number)).analysisStatus).toMatchObject({
      status: "older-version",
      next: "start-run",
      willRead: false,
    });
    expect((await status(h)).byStatus["older-version"]).toBe(1);
  });

  it("is null and not outdated on an Offer nothing has read yet", async () => {
    const h = boot();
    const [id] = await analysedOffers(h, 1);
    expect((await offerOf(h, id as number)).analysis).toMatchObject({
      state: "pending",
      analysisVersion: null,
      olderVersion: false,
    });
  });

  it("marks results outdated when only the effort changes, but not when only the escalation or the cap does", async () => {
    const h = boot();
    await setKey(h);
    await analysedOffers(h, 1);

    await change(h, { escalation: null, monthlySpendCapUsd: 9, batchOnly: true });
    expect((await status(h)).olderVersion.count).toBe(0);

    await change(h, { effort: "high" });
    expect((await status(h)).olderVersion.count).toBe(1);
  });

  it("does not call a result stored before versions existed outdated while its settings still match", async () => {
    const h = boot();
    await setKey(h);
    const [id] = await analysedOffers(h, 1);
    // Strip the stamp, as an Offer analysed by the previous release has it.
    const row = h.runtime.db.$client
      .prepare("select analysis from offers where id = ?")
      .get(id) as { analysis: string };
    const stored = JSON.parse(row.analysis);
    delete stored.run.analysisVersion;
    h.runtime.db.$client
      .prepare("update offers set analysis = ? where id = ?")
      .run(JSON.stringify(stored), id);

    expect((await status(h)).olderVersion.count).toBe(0);
    await useSonnet(h);
    expect((await status(h)).olderVersion.count).toBe(1);
  });

  it("stamps the version on the stored analysis", async () => {
    const h = boot();
    await setKey(h);
    await analysedOffers(h, 1);
    const version = (await status(h)).version;

    const rows = h.runtime.db.$client.prepare("select analysis from offers").all() as {
      analysis: string;
    }[];

    expect(JSON.parse(rows[0]?.analysis ?? "{}").run.analysisVersion).toBe(version);
  });
});

describe("POST /analysis/runs", () => {
  it("answers 202 with a run, sends the outdated Offers as a batch and keeps their facts until it succeeds", async () => {
    const h = boot();
    await setKey(h);
    const ids = await analysedOffers(h, 2);
    await useSonnet(h);

    const started = await startRun(h);
    await poll(h);

    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({
      status: "running",
      counts: { total: 2, pending: 2, applied: 0 },
      stopReason: null,
    });
    expect(started.body.estimatedCostUsd).toBeGreaterThan(0);
    expect(h.batch.submissions).toHaveLength(1);
    expect(h.batch.submissions[0]?.map((r) => [r.request.model, r.request.effort])).toEqual([
      ["claude-sonnet-5-5", "medium"],
      ["claude-sonnet-5-5", "medium"],
    ]);
    for (const id of ids) {
      const offer = await offerOf(h, id);
      expect(offer.analysisState).toBe("analyzed");
      expect(offer.analysis.model).toBe("claude-haiku-5-5");
    }
    const running = await h.json("GET", `/analysis/runs/${started.body.id}`);
    expect(running.body).toMatchObject({ status: "running", finishedAt: null });
    expect((await status(h)).activeRunId).toBe(started.body.id);
  });

  it("applies the results when the batch ends, and the Offers are then on the new analysis", async () => {
    const h = boot({
      batchUsage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    await setKey(h);
    const ids = await analysedOffers(h, 2);
    await useSonnet(h);
    const { body: run } = await startRun(h);
    await poll(h);

    h.batch.complete();
    await poll(h);

    const done = (await h.json("GET", `/analysis/runs/${run.id}`)).body;
    expect(done).toMatchObject({
      status: "succeeded",
      counts: { total: 2, applied: 2, pending: 0, failed: 0 },
    });
    expect(done.finishedAt).not.toBeNull();
    for (const id of ids) {
      expect((await offerOf(h, id)).analysis).toMatchObject({
        model: "claude-sonnet-5-5",
        effort: "medium",
      });
    }
    const after = await status(h);
    expect(after.olderVersion.count).toBe(0);
    expect(after.activeRunId).toBeNull();
    // The batch's usage at Sonnet 5.5's $2 / $10 per MTok, half price: 1,000 in and 200 out each.
    expect(done.actualCostUsd).toBeCloseTo(2 * ((1000 * 2 + 200 * 10) / 1e6 / 2), 8);
  });

  it("announces the run's progress on /events", async () => {
    const h = boot();
    await setKey(h);
    await analysedOffers(h, 1);
    await useSonnet(h);

    await startRun(h);
    await poll(h);
    h.batch.complete();
    await poll(h);

    const progress = h.events.filter((event) => event.type === "analysis-run-progress");
    expect(progress.at(0)?.data).toMatchObject({ status: "running", done: 0, total: 1 });
    expect(progress.at(-1)?.data).toMatchObject({ status: "succeeded", done: 1, total: 1 });
  });

  it("leaves the previous facts current when the request fails, and says so", async () => {
    const h = boot({ batchScript: [new ProviderError("overloaded")] });
    await setKey(h);
    const [id] = await analysedOffers(h, 1);
    const before = (await offerOf(h, id as number)).facts.anmeldung;
    await useSonnet(h);
    const { body: run } = await startRun(h);
    await poll(h);

    h.batch.complete();
    await poll(h);

    const done = (await h.json("GET", `/analysis/runs/${run.id}`)).body;
    expect(done).toMatchObject({ status: "failed", counts: { failed: 1, applied: 0 } });
    const offer = await offerOf(h, id as number);
    expect(offer.analysisState).toBe("analyzed");
    expect(offer.analysis).toMatchObject({ model: "claude-haiku-5-5" });
    expect(offer.analysisStatus.reason).toBe("overloaded");
    expect(offer.facts.anmeldung).toEqual(before);
    expect((await status(h)).olderVersion.count).toBe(1);
  });

  it("applies the requests that succeeded and keeps the old facts of those that did not", async () => {
    const h = boot({
      batchScript: (call) => (call === 0 ? anmeldungOk : new ProviderError("server_error")),
    });
    await setKey(h);
    const ids = await analysedOffers(h, 2);
    await useSonnet(h);
    const { body: run } = await startRun(h);
    await poll(h);

    h.batch.complete();
    await poll(h);

    const done = (await h.json("GET", `/analysis/runs/${run.id}`)).body;
    expect(done).toMatchObject({ status: "partial", counts: { applied: 1, failed: 1 } });
    const models = await Promise.all(ids.map(async (id) => (await offerOf(h, id)).analysis.model));
    expect(models.sort()).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
  });

  it("bills a refused or cut-off request in a batch: its tokens were used", async () => {
    const usage = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const h = boot({ batchScript: [new ProviderError("truncated", usage)] });
    await setKey(h);
    await analysedOffers(h, 1);
    const spentBefore = (await status(h)).spend.spentUsd;
    await useSonnet(h);
    await startRun(h);
    await poll(h);

    h.batch.complete();
    await poll(h);

    const spent = (await status(h)).spend.spentUsd - spentBefore;
    expect(spent).toBeCloseTo((1000 * 2 + 500 * 10) / 1e6 / 2, 8);
  });

  it("throws away a result for words that changed while the batch ran", async () => {
    const h = boot();
    await setKey(h);
    const [id] = await analysedOffers(h, 1);
    await useSonnet(h);
    const { body: run } = await startRun(h);
    await poll(h);

    const { adapterFixture } = await import("./fixtures/search-pages.js");
    const { wgGesuchtSource } = await import("@wg-hunt/core/sources/wg-gesucht");
    const html = adapterFixture("flatshare").replace(
      "Anmeldung ist möglich.",
      "Anmeldung ist möglich. Neu: Mindestmietdauer 3 Monate.",
    );
    const parsed = wgGesuchtSource.parseOffer(html, {
      firstSeen: new Date(h.clock.now),
      category: "flatshare-room",
    });
    if (parsed.outcome !== "parsed") throw new Error("unreadable");
    h.runtime.snapshots.write("wg-gesucht", "9000001", html);
    h.runtime.offers.ingest({
      source: "wg-gesucht",
      adId: "9000001",
      fetchedAt: h.clock.now + 5 * MINUTE,
      card: {
        adId: "9000001",
        path: "/wg-zimmer-in-Teststadt-Mitte.9000001.html",
        title: "Zimmer 9000001",
        advertiser: { name: "Anna", kind: "private" },
      },
      parsed,
    });
    h.batch.complete();
    await poll(h);

    const done = (await h.json("GET", `/analysis/runs/${run.id}`)).body;
    expect(done.counts).toMatchObject({ dropped: 1, applied: 0 });
    expect(id).toBeDefined();
  });

  it("reads the escalation pass in a second batch of the same run", async () => {
    const h = boot({ batchScript: [doubtful, anmeldungOk] });
    await setKey(h);
    const [id] = await analysedOffers(h, 1);
    await useSonnet(h);
    const { body: run } = await startRun(h);
    await poll(h);
    h.batch.complete();
    await poll(h);

    const between = (await h.json("GET", `/analysis/runs/${run.id}`)).body;
    expect(between).toMatchObject({
      status: "running",
      counts: { total: 1, pending: 1, applied: 0 },
    });
    expect((await offerOf(h, id as number)).analysis).toMatchObject({
      model: "claude-haiku-5-5",
      escalated: false,
    });
    expect(h.batch.submissions).toHaveLength(2);
    expect(h.batch.submissions[1]?.[0]?.request).toMatchObject({
      model: "claude-haiku-5-5",
      effort: "high",
    });

    h.batch.complete();
    await poll(h);

    expect((await h.json("GET", `/analysis/runs/${run.id}`)).body.status).toBe("succeeded");
    const offer = await offerOf(h, id as number);
    expect(offer.analysis).toMatchObject({ model: "claude-sonnet-5-5", escalated: true });
    expect(offer.facts.anmeldung).toMatchObject({ confidence: { status: "confident" } });
  });

  it("keeps the previous facts, and does not call the Offer applied, when its escalation fails", async () => {
    const h = boot({
      batchScript: (call) => (call === 0 ? doubtful : new ProviderError("overloaded")),
    });
    await setKey(h);
    const [id] = await analysedOffers(h, 1);
    const before = (await offerOf(h, id as number)).facts.anmeldung;
    await useSonnet(h);
    const { body: run } = await startRun(h);
    await poll(h);
    h.batch.complete();
    await poll(h);

    h.batch.complete();
    await poll(h);

    const done = (await h.json("GET", `/analysis/runs/${run.id}`)).body;
    expect(done).toMatchObject({ status: "failed", counts: { failed: 1, applied: 0, pending: 0 } });
    const offer = await offerOf(h, id as number);
    expect(offer.analysis).toMatchObject({ model: "claude-haiku-5-5" });
    expect(offer.analysisStatus.reason).toBe("overloaded");
    expect(offer.facts.anmeldung).toEqual(before);
    expect((await status(h)).olderVersion.count).toBe(1);
  });

  it("holds the previous facts of a single Re-analyse too until its escalation has answered", async () => {
    const h = boot({ script: [anmeldungOk, doubtful], batchScript: [anmeldungOk] });
    await setKey(h);
    const [id] = await analysedOffers(h, 1);
    const before = (await offerOf(h, id as number)).facts.anmeldung;

    await h.json("POST", `/offers/${id}/reanalyze`);
    await h.runtime.analysis.idle();
    await poll(h);

    expect(h.batch.submissions).toHaveLength(1);
    expect((await offerOf(h, id as number)).facts.anmeldung).toEqual(before);

    h.batch.complete();
    await poll(h);

    expect((await offerOf(h, id as number)).analysis.escalated).toBe(true);
  });

  it("sends a big run as several batches of at most the batch size", async () => {
    const h = boot({ size: 2 });
    await setKey(h);
    await analysedOffers(h, 5);
    await useSonnet(h);

    await startRun(h);
    await poll(h);

    expect(h.batch.submissions.map((requests) => requests.length)).toEqual([2, 2, 1]);
  });

  it("starts nothing by itself: only the call starts a run", async () => {
    const h = boot();
    await setKey(h);
    await analysedOffers(h, 2);
    await useSonnet(h);

    h.runtime.analysis.sweep();
    await h.runtime.analysis.idle();
    await poll(h);
    h.clock.now += 24 * 60 * MINUTE;
    h.runtime.analysis.sweep();
    await poll(h);

    expect(h.batch.submissions).toHaveLength(0);
  });

  it("answers 409 nothing-to-reanalyze when nothing is outdated, and starts no run", async () => {
    const h = boot();
    await setKey(h);
    await analysedOffers(h, 1);

    const refused = await startRun(h);

    expect(refused.status).toBe(409);
    expect(refused.body.type).toBe("nothing-to-reanalyze");
    expect((await status(h)).activeRunId).toBeNull();
    expect(h.events.filter((event) => event.type === "analysis-run-progress")).toEqual([]);
    expect(h.batch.submissions).toHaveLength(0);
  });

  it("answers 409 no-api-key without a key", async () => {
    const h = boot();
    const refused = await startRun(h);
    expect(refused.status).toBe(409);
    expect(refused.body.type).toBe("no-api-key");
  });

  it("answers 409 api-key-refused while the API refuses the key, and sends nothing", async () => {
    // The second Offer's read is refused, after the first was read.
    const h = boot({ script: [anmeldungOk, new ProviderError("unauthorized")] });
    await setKey(h);
    await analysedOffers(h, 2);
    await useSonnet(h);
    expect((await status(h)).key).toBe("refused");

    const refused = await startRun(h);

    expect(refused.status).toBe(409);
    expect(refused.body.type).toBe("api-key-refused");
    expect((await status(h)).activeRunId).toBeNull();
    expect(h.batch.submissions).toHaveLength(0);
  });

  it("answers 409 analysis-run-active while a run is going", async () => {
    const h = boot();
    await setKey(h);
    await analysedOffers(h, 1);
    await useSonnet(h);
    await startRun(h);
    await poll(h);

    const second = await startRun(h);

    expect(second.status).toBe(409);
    expect(second.body.type).toBe("analysis-run-active");
    expect(h.batch.submissions).toHaveLength(1);
  });

  it("answers 404 for a run that does not exist", async () => {
    const h = boot();
    expect((await h.json("GET", "/analysis/runs/99")).status).toBe(404);
  });

  it("leaves Stale Offers out", async () => {
    const h = boot();
    await setKey(h);
    await analysedOffers(h, 2);
    // A week and a day later nobody has Bumped either Offer: both are Stale.
    h.clock.now += 8 * 24 * 60 * MINUTE;
    await useSonnet(h);

    expect((await status(h)).olderVersion.count).toBe(0);
    const refused = await startRun(h);
    expect(refused.body.type).toBe("nothing-to-reanalyze");
    expect(h.batch.submissions).toHaveLength(0);
  });
});

describe("a restart while a batch is out", () => {
  it("picks the batch up where it was left and applies its results", async () => {
    const batch = fakeBatchProvider([anmeldungOk]);
    const realtime = fakeProvider([anmeldungOk]);
    const dataDir = tempDataDir();
    const options = {
      providerFor: () => realtime.provider,
      batchProviderFor: () => batch.provider,
      sleep: async () => {},
    };
    const first = bootOffers({ dataDir, analysis: options });
    expect((await first.call("PUT", "/secrets/anthropic", { value: KEY })).status).toBe(200);
    first.site.cards = first.freshCards([9000001]);
    await first.addSearch();
    await first.crawl();
    await first.runtime.analysis.idle();
    const current = (await first.json("GET", "/settings/analysis")).body;
    await first.json("PUT", "/settings/analysis", { ...current, model: "claude-sonnet-5-5" });
    const { body: run } = await first.json("POST", "/analysis/runs");
    await first.runtime.analysis.pollBatches();
    expect(batch.submissions).toHaveLength(1);
    first.runtime.close();

    const second = bootOffers({ dataDir, start: first.clock.now, analysis: options });
    batch.complete();
    await second.runtime.analysis.pollBatches();

    expect(batch.submissions).toHaveLength(1);
    const done = (await second.json("GET", `/analysis/runs/${run.id}`)).body;
    expect(done).toMatchObject({ status: "succeeded", counts: { applied: 1 } });
    const [offer] = (await second.json("GET", "/offers")).body.items;
    expect((await second.json("GET", `/offers/${offer.id}`)).body.analysis.model).toBe(
      "claude-sonnet-5-5",
    );
  });
});
