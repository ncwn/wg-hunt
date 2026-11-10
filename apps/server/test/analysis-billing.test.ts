import { type AnalysisProvider, type AnalysisRequest, ProviderError } from "@wg-hunt/core";
import { fakeBatchProvider, fakeProvider, type Scripted } from "@wg-hunt/core/analysis/testing";
import { describe, expect, it } from "vitest";
import { analysisItems } from "../src/db/schema.js";
import {
  anmeldungOk,
  type Boot,
  boot,
  change,
  doubtful,
  editedPage,
  KEY,
  MINUTE,
  offerOf,
  poll,
  recheck,
  setKey,
  status,
} from "./analysis-harness.js";
import { bootOffers } from "./offers-harness.js";

function gatedBoot(script: Scripted[] = [anmeldungOk]) {
  const fake = fakeProvider(script);
  const waiting: (() => void)[] = [];
  let open = false;
  const gated: AnalysisProvider = {
    async analyse(request: AnalysisRequest) {
      if (!open) await new Promise<void>((resolve) => waiting.push(resolve));
      return fake.provider.analyse(request);
    },
  };
  const batch = fakeBatchProvider([anmeldungOk]);
  const h = bootOffers({
    analysis: {
      providerFor: () => gated,
      batchProviderFor: () => batch.provider,
      sleep: async () => {},
    },
  });
  return {
    ...h,
    requests: fake.requests,
    batch,
    inFlight: () => waiting.length,
    async release() {
      open = true;
      for (const resolve of waiting.splice(0)) resolve();
      await h.runtime.analysis.idle();
    },
    close() {
      open = false;
    },
    step() {
      for (const resolve of waiting.splice(0)) resolve();
    },
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await settle();
  expect(check()).toBe(true);
}

async function crawlGated(h: ReturnType<typeof gatedBoot>, ids: number[]) {
  expect((await h.call("PUT", "/secrets/anthropic", { value: KEY })).status).toBe(200);
  h.site.cards = h.freshCards(ids);
  await h.addSearch();
  await h.crawl();
  await waitFor(() => h.inFlight() === 1);
  const list = (await h.json("GET", "/offers")).body.items as { id: number; title: string }[];
  return list;
}

const batchOnly = async (h: { json: Boot["json"] }, on: boolean) => {
  const current = (await h.json("GET", "/settings/analysis")).body;
  expect((await h.json("PUT", "/settings/analysis", { ...current, batchOnly: on })).status).toBe(
    200,
  );
};

async function crawlBackfill(h: Boot) {
  await setKey(h);
  h.site.cards = [{ id: 9000001, age: "3 Tage", title: "Zimmer 9000001" }];
  await h.addSearch();
  await h.crawl();
  await h.runtime.analysis.idle();
  await poll(h);
  expect(h.batch.submissions).toHaveLength(1);
  const [offer] = (await h.json("GET", "/offers")).body.items as { id: number }[];
  if (offer === undefined) throw new Error("no Offer");
  return offer;
}

async function sweepAt(h: Boot, at: number) {
  h.clock.now = at;
  h.runtime.analysis.sweep();
  await h.runtime.analysis.idle();
  await poll(h);
}

describe("a click on Re-analyse while the Offer is being read", () => {
  it("is served by the read in flight and leaves nothing behind to force a later read", async () => {
    const h = gatedBoot();
    const offers = await crawlGated(h, [9000001, 9000002]);
    expect(offers).toHaveLength(2);
    // The sweep queues Offers in id order: the first one's call is the one out.
    const [first, second] = [...offers].sort((a, b) => a.id - b.id);
    if (first === undefined || second === undefined) throw new Error("no Offers");
    expect(h.runtime.analysis.batch.heldBy(first.id)).toBe("realtime");
    expect((await h.json("POST", `/offers/${first.id}/reanalyze`)).status).toBe(202);
    h.step();
    await waitFor(() => h.inFlight() === 1);
    expect((await offerOf(h as unknown as Boot, first.id)).analysisState).toBe("analyzed");

    const adId = Number(h.runtime.offers.analysisJob(first.id)?.adId);
    recheck(h as unknown as Boot, editedPage(), adId);
    h.runtime.analysis.sweep();
    await settle();
    await batchOnly(h, true);
    h.runtime.analysis.sweep();
    await settle();
    await h.release();
    await h.runtime.analysis.pollBatches();

    expect(h.requests).toHaveLength(2);
    expect(h.batch.submissions.flat()).toHaveLength(1);
  });
});

describe("a click on Re-analyse for an Offer a batch holds", () => {
  it("is refused instead of paying for a realtime read on top of the batch request", async () => {
    const h = boot();
    const offer = await crawlBackfill(h);

    const res = await h.json("POST", `/offers/${offer.id}/reanalyze`);
    await h.runtime.analysis.idle();

    expect(res.status).toBe(409);
    expect(res.body.type).toBe("analysis-in-batch");
    expect(h.requests).toHaveLength(0);
  });
});

describe("an Offer being read in realtime", () => {
  it("is not also queued for a batch when 'batch only' is switched on", async () => {
    const h = gatedBoot();
    await crawlGated(h, [9000001]);

    await batchOnly(h, true);
    h.runtime.analysis.sweep();
    await h.runtime.analysis.pollBatches();
    await h.release();
    await h.runtime.analysis.pollBatches();

    expect(h.requests).toHaveLength(1);
    expect(h.batch.submissions).toHaveLength(0);
  });

  it("is left out of a re-analysis run started while it is out", async () => {
    const h = gatedBoot();
    const [offer] = await crawlGated(h, [9000001]);
    if (offer === undefined) throw new Error("no Offer");
    await h.release();
    await change(h as unknown as Boot, { model: "claude-sonnet-5-5", effort: "medium" });

    h.close();
    expect((await h.json("POST", `/offers/${offer.id}/reanalyze`)).status).toBe(202);
    await waitFor(() => h.inFlight() === 1);
    await h.json("POST", "/analysis/runs");
    await h.runtime.analysis.pollBatches();
    await h.release();
    await h.runtime.analysis.pollBatches();

    expect(h.batch.submissions).toHaveLength(0);
    expect(h.requests).toHaveLength(2);
  });
});

describe("an escalation pass that is lost", () => {
  it("is sent again once its backoff is over when its request failed", async () => {
    const h = boot({
      script: [doubtful],
      batchScript: (call) => (call === 0 ? new ProviderError("server_error") : anmeldungOk),
    });
    await setKey(h);
    h.site.cards = h.freshCards([9000001]);
    await h.addSearch();
    await h.crawl();
    await h.runtime.analysis.idle();
    const [offer] = (await h.json("GET", "/offers")).body.items as { id: number }[];
    if (offer === undefined) throw new Error("no Offer");
    await poll(h);
    h.batch.complete();
    await poll(h);
    expect((await offerOf(h, offer.id)).analysis.escalated).toBe(false);

    await sweepAt(h, h.clock.now + 11 * MINUTE);
    expect(h.batch.submissions).toHaveLength(2);
    expect(h.batch.submissions[1]?.map((r) => r.request.effort)).toEqual(["high"]);
    h.batch.complete();
    await poll(h);

    expect((await offerOf(h, offer.id)).analysis.escalated).toBe(true);
    expect(h.requests).toHaveLength(1);
  });

  it("is sent again when there is room after the cap stopped it", async () => {
    const h = boot({ script: [doubtful] });
    await setKey(h);
    h.site.cards = h.freshCards([9000001]);
    await h.addSearch();
    await h.crawl();
    await h.runtime.analysis.idle();
    const [offer] = (await h.json("GET", "/offers")).body.items as { id: number }[];
    if (offer === undefined) throw new Error("no Offer");
    expect(h.batch.submissions).toHaveLength(1);
    const spent = (await status(h)).spend.spentUsd as number;
    await change(h, { monthlySpendCapUsd: spent + 0.000001 });
    await poll(h);
    expect(h.batch.canceled).toEqual(["batch-1"]);
    h.batch.complete();
    await poll(h);

    await change(h, { monthlySpendCapUsd: 20 });
    await sweepAt(h, h.clock.now + MINUTE);

    expect(h.batch.submissions).toHaveLength(2);
    expect(h.batch.submissions[1]?.map((r) => r.request.effort)).toEqual(["high"]);
    h.batch.complete();
    await poll(h);
    expect((await offerOf(h, offer.id)).analysis.escalated).toBe(true);
    expect(h.requests).toHaveLength(1);
  });

  it("says so once it will not be sent again", async () => {
    const h = boot({ script: [doubtful], batchScript: [new ProviderError("server_error")] });
    await setKey(h);
    h.site.cards = h.freshCards([9000001]);
    await h.addSearch();
    await h.crawl();
    await h.runtime.analysis.idle();
    const [offer] = (await h.json("GET", "/offers")).body.items as { id: number }[];
    if (offer === undefined) throw new Error("no Offer");
    for (let i = 0; i < 8; i++) {
      await poll(h);
      h.batch.complete();
      await poll(h);
      await sweepAt(h, h.clock.now + 7 * 60 * MINUTE);
    }

    // Five attempts, then it waits for the seeker.
    expect(h.batch.submissions).toHaveLength(5);
    const job = h.runtime.offers.analysisJob(offer.id);
    expect(job?.escalation).not.toBeNull();
    expect((await offerOf(h, offer.id)).analysisStatus.status).toBe("escalation-lost");
  });

  it("says so once re-sending it keeps failing before anything is sent", async () => {
    const h = boot({ script: [doubtful], batchScript: [new ProviderError("server_error")] });
    await setKey(h);
    h.site.cards = h.freshCards([9000001]);
    await h.addSearch();
    await h.crawl();
    await h.runtime.analysis.idle();
    const [offer] = (await h.json("GET", "/offers")).body.items as { id: number }[];
    if (offer === undefined) throw new Error("no Offer");
    await poll(h);
    h.batch.complete();
    await poll(h);
    // The seeker moves to another model and drops the old one from the price table: the escalation
    // owed at the old one can no longer be priced, so it fails at no cost each time it is queued.
    const current = (await h.json("GET", "/settings/analysis")).body;
    await change(h, {
      model: "claude-sonnet-5-5",
      effort: "medium",
      escalation: null,
      prices: (current.prices as { model: string }[]).filter(
        (price) => price.model !== "claude-haiku-5-5",
      ),
    });
    const rows = () => h.runtime.db.select().from(analysisItems).all().length;
    for (let i = 0; i < 10; i++) await sweepAt(h, h.clock.now + 7 * 60 * MINUTE);
    const after = rows();
    for (let i = 0; i < 3; i++) await sweepAt(h, h.clock.now + 7 * 60 * MINUTE);

    expect(rows()).toBe(after);
    expect(h.batch.submissions).toHaveLength(1);
    expect((await offerOf(h, offer.id)).analysisStatus.status).toBe("escalation-lost");
  });

  it("says so once the cap keeps stopping it though smaller calls still fit", async () => {
    const h = boot({ script: [doubtful] });
    await setKey(h);
    // The first pass ($0.009 at worst) fits under the cap; the escalation at Opus ($0.16) never does.
    await change(h, {
      escalation: { model: "claude-opus-5-5", effort: "high" },
      monthlySpendCapUsd: 0.05,
    });
    h.site.cards = h.freshCards([9000001]);
    await h.addSearch();
    await h.crawl();
    await h.runtime.analysis.idle();
    const [offer] = (await h.json("GET", "/offers")).body.items as { id: number }[];
    if (offer === undefined) throw new Error("no Offer");
    for (let i = 0; i < 10; i++) await sweepAt(h, h.clock.now + 3 * 60 * MINUTE);

    expect(h.batch.submissions).toHaveLength(0);
    const job = h.runtime.offers.analysisJob(offer.id);
    expect(job?.escalation).not.toBeNull();
    expect((await offerOf(h, offer.id)).analysisStatus.status).toBe("escalation-lost");
  });
});

describe("a backfill whose batch request failed", () => {
  it("is retried through the Batch API, at half the price, not in realtime", async () => {
    const h = boot({
      batchScript: (call) => (call === 0 ? new ProviderError("server_error") : anmeldungOk),
    });
    const offer = await crawlBackfill(h);
    h.batch.complete();
    await poll(h);
    expect((await offerOf(h, offer.id)).analysisState).toBe("failed");

    await sweepAt(h, h.clock.now + 11 * MINUTE);

    expect(h.requests).toHaveLength(0);
    expect(h.batch.submissions).toHaveLength(2);
  });
});

describe("clicks on Re-analyse when the cap stops the worker", () => {
  it("are kept and read once there is room, not dropped after their 202", async () => {
    // The first two reads, then the cap stops the first click.
    const h = boot({
      script: [anmeldungOk, anmeldungOk, new ProviderError("spend_cap_reached"), anmeldungOk],
    });
    await setKey(h);
    h.site.cards = h.freshCards([9000001, 9000002]);
    await h.addSearch();
    await h.crawl();
    await h.runtime.analysis.idle();
    const offers = (await h.json("GET", "/offers")).body.items as { id: number }[];
    expect(h.requests).toHaveLength(2);

    for (const offer of offers) expect(h.runtime.analysis.reanalyze(offer.id)).toBe("queued");
    await h.runtime.analysis.idle();
    expect(h.requests).toHaveLength(4);

    await sweepAt(h, h.clock.now + 5 * MINUTE);

    expect(h.requests).toHaveLength(5);
  });

  it("let the Offers behind a click too big for what is left be read", async () => {
    // The first read, then the cap turns the click away each time it comes up (as it does a long
    // Offer whose worst case is more than is left), while a typical new Offer still fits.
    const cap = new ProviderError("spend_cap_reached");
    const h = boot({ script: [anmeldungOk, cap, cap, anmeldungOk, anmeldungOk] });
    await setKey(h);
    h.site.cards = h.freshCards([9000001]);
    await h.addSearch();
    await h.crawl();
    await h.runtime.analysis.idle();
    const [clicked] = (await h.json("GET", "/offers")).body.items as {
      id: number;
      analysisState: string;
    }[];
    if (clicked === undefined) throw new Error("no Offer");

    expect(h.runtime.analysis.reanalyze(clicked.id)).toBe("queued");
    await h.runtime.analysis.idle();
    expect(h.requests).toHaveLength(2);

    h.site.cards = h.freshCards([9000001, 9000002]);
    await h.crawl();
    await h.runtime.analysis.idle();

    expect(h.requests).toHaveLength(4);
    const list = (await h.json("GET", "/offers")).body.items as {
      id: number;
      analysisState: string;
    }[];
    expect(list.find((offer) => offer.id !== clicked.id)?.analysisState).toBe("analyzed");

    await sweepAt(h, h.clock.now + 5 * MINUTE);
    expect(h.requests).toHaveLength(5);
  });
});

describe("the escalation a Re-analyse click paid for", () => {
  it("is not dropped without a word when the cap stops it before its batch goes out", async () => {
    const h: Boot = boot({
      script: (call) => {
        if (call === 1) {
          h.runtime.analysis.spend.record({
            model: "claude-haiku-5-5",
            effort: "medium",
            batch: false,
            usage: { inputTokens: 1e9, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          });
        }
        return call === 0 ? anmeldungOk : doubtful;
      },
    });
    await setKey(h);
    h.site.cards = h.freshCards([9000001]);
    await h.addSearch();
    await h.crawl();
    await h.runtime.analysis.idle();
    const [offer] = (await h.json("GET", "/offers")).body.items as { id: number }[];
    const id = offer?.id as number;

    expect((await h.call("POST", `/offers/${id}/reanalyze`)).status).toBe(202);
    await h.runtime.analysis.idle();
    await poll(h);

    expect(h.requests).toHaveLength(2);
    expect(h.batch.submissions).toHaveLength(0);
    const body = await offerOf(h, id);
    expect(body.facts.anmeldung.value).toBe("possible");
    expect(body.analysisStatus).toMatchObject({
      status: "kept-previous",
      reason: "spend_cap_reached",
      next: "raise-cap",
    });
  });

  it("is not dropped without a word when a lowered cap cancels its batch", async () => {
    const h = boot({ script: [anmeldungOk, doubtful] });
    await setKey(h);
    h.site.cards = h.freshCards([9000001]);
    await h.addSearch();
    await h.crawl();
    await h.runtime.analysis.idle();
    const [offer] = (await h.json("GET", "/offers")).body.items as { id: number }[];
    const id = offer?.id as number;

    expect((await h.call("POST", `/offers/${id}/reanalyze`)).status).toBe(202);
    await h.runtime.analysis.idle();
    expect(h.requests).toHaveLength(2);
    expect(h.batch.submissions).toHaveLength(1);

    const spent = (await status(h)).spend.spentUsd as number;
    await change(h, { monthlySpendCapUsd: spent + 0.000001 });
    await poll(h);
    expect(h.batch.canceled).toEqual(["batch-1"]);
    h.batch.complete();
    await poll(h);

    const body = await offerOf(h, id);
    expect(body.facts.anmeldung.value).toBe("possible");
    expect(body.analysisStatus).toMatchObject({
      status: "kept-previous",
      reason: "spend_cap_reached",
      next: "raise-cap",
    });

    await change(h, { monthlySpendCapUsd: 20 });
    await sweepAt(h, h.clock.now + MINUTE);
    expect(h.batch.submissions).toHaveLength(1);
    expect((await offerOf(h, id)).analysisStatus).toMatchObject({
      status: "kept-previous",
      reason: "spend_cap_reached",
      next: "reanalyze",
    });
  });
});

describe("a Re-analyse click sent as a batch on an Offer that stores an escalation", () => {
  it("is paid for once, though its escalation does not fit", async () => {
    const h = boot({ script: [doubtful], batchScript: [doubtful] });
    await setKey(h);
    // The first pass fits under the cap; the escalation at Opus never does.
    await change(h, {
      escalation: { model: "claude-opus-5-5", effort: "high" },
      monthlySpendCapUsd: 0.05,
    });
    h.site.cards = h.freshCards([9000001]);
    await h.addSearch();
    await h.crawl();
    await h.runtime.analysis.idle();
    const [offer] = (await h.json("GET", "/offers")).body.items as { id: number }[];
    const id = offer?.id as number;
    for (let i = 0; i < 10; i++) await sweepAt(h, h.clock.now + 3 * 60 * MINUTE);
    expect((await offerOf(h, id)).analysisStatus.status).toBe("escalation-lost");
    const [first] = h.requests;
    if (first === undefined) throw new Error("not read");
    const { spend } = h.runtime.analysis;
    const realtime = spend.estimateMicros(first, { batch: false }) ?? 0;
    const batched = spend.estimateMicros(first, { batch: true }) ?? 0;
    const cap = (spend.spentUsd() * 1e6 + (realtime + batched) / 2) / 1e6;
    await change(h, { monthlySpendCapUsd: Math.round(cap * 1e6) / 1e6 });
    expect((await status(h)).spend.state).toBe("ok");

    expect((await h.call("POST", `/offers/${id}/reanalyze`)).status).toBe(202);
    await h.runtime.analysis.idle();
    await poll(h);
    expect(h.batch.submissions).toHaveLength(1);
    h.batch.complete();
    await poll(h);
    expect(h.runtime.offers.analysisJob(id)?.reanalyzeRequestedAt).toBeNull();

    for (let i = 0; i < 3; i++) {
      await sweepAt(h, h.clock.now + 5 * MINUTE);
      h.batch.complete();
      await poll(h);
    }
    expect(h.batch.submissions).toHaveLength(1);
    expect(h.requests).toHaveLength(1);
    expect((await offerOf(h, id)).analysisStatus.status).toBe("escalation-lost");
  });
});

describe("a batch request that failed for words the Offer no longer has", () => {
  it("is dropped without counting as a failed attempt on the new words", async () => {
    const h = boot({ batchScript: [new ProviderError("server_error")] });
    const offer = await crawlBackfill(h);

    recheck(h, editedPage());
    await h.runtime.analysis.idle();
    h.batch.complete();
    await poll(h);

    const job = h.runtime.offers.analysisJob(offer.id);
    expect(job?.state).toBe("pending");
    expect(job?.failure).toBeNull();
  });
});
