import type { AnalysisProvider, AnalysisRequest, ModelFacts } from "@wg-hunt/core";
import { fakeBatchProvider } from "@wg-hunt/core/analysis/testing";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { parseStoredAnalysis } from "../src/analysis/record.js";
import { offers } from "../src/db/schema.js";
import {
  anmeldungOk,
  type Boot,
  boot,
  change,
  crawlOffers,
  doubtful,
  MINUTE,
  offerOf,
  poll,
  setKey,
  usage,
} from "./analysis-harness.js";
import {
  type AdSpec,
  adPage,
  ingestAds,
  OTHER_ROOM_TEXT,
  photo,
  ROOM_TEXT,
} from "./dedupe-harness.js";
import { bootOffers } from "./offers-harness.js";

function holdableProvider() {
  const requests: AnalysisRequest[] = [];
  let gate: Promise<void> | undefined;
  let open = () => {};
  const provider: AnalysisProvider = {
    async analyse(request) {
      requests.push(request);
      await gate;
      return { output: anmeldungOk, usage: usage() };
    },
  };
  return {
    provider,
    requests,
    hold() {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release() {
      open();
      gate = undefined;
    },
  };
}
type Api = ReturnType<typeof holdableProvider>;

function bootWith(realtime: Api, after?: Boot) {
  return boot({
    ...(after && { dataDir: after.dataDir, start: after.clock.now }),
    sameProviders: { realtime, batch: after?.batch ?? fakeBatchProvider([anmeldungOk]) },
  });
}

function restart(before: Boot, realtime: Api = holdableProvider()) {
  before.runtime.close();
  return { h: bootWith(realtime, before), api: realtime };
}

type Harness = Pick<Boot, "runtime" | "call" | "json">;
const click = (h: Harness, id: number) => h.call("POST", `/offers/${id}/reanalyze`);
const statusOf = async (h: Harness, id: number) =>
  (await h.json("GET", `/offers/${id}`)).body.analysisStatus.status;
const rowOf = (h: Harness, id: number) =>
  h.runtime.db.select().from(offers).where(eq(offers.id, id)).get();
const owedSince = (h: Harness, id: number) => rowOf(h, id)?.reanalyzeRequestedAt;

async function clickQueuedBehindARead() {
  const api = holdableProvider();
  const h = bootWith(api);
  await setKey(h);
  const [first, second] = (await crawlOffers(h, 2)).map((offer) => offer.id) as [number, number];
  api.hold();
  expect((await click(h, first)).status).toBe(202);
  h.clock.now += 1000;
  expect((await click(h, second)).status).toBe(202);
  expect(await statusOf(h, second)).toBe("queued");
  return { h, api, first, second };
}

describe("a Re-analyse click that was answered 202", () => {
  it("is still owed after a restart, and is read once", async () => {
    const before = await clickQueuedBehindARead();
    const { first, second } = before;
    const held = holdableProvider();
    held.hold();

    const { h, api } = restart(before.h, held);

    expect(await statusOf(h, first)).toBe("reading");
    expect(await statusOf(h, second)).toBe("queued");

    api.release();
    await h.runtime.analysis.idle();
    expect(api.requests).toHaveLength(2);
    expect(await statusOf(h, first)).toBe("analyzed");
    expect(await statusOf(h, second)).toBe("analyzed");

    h.runtime.analysis.sweep();
    await h.runtime.analysis.idle();
    const later = restart(h);
    await later.h.runtime.analysis.idle();
    expect(api.requests).toHaveLength(2);
    expect(later.api.requests).toHaveLength(0);
  });

  it("stops being owed in the write that saves its analysis or records its failure", async () => {
    const h = boot();
    await setKey(h);
    const [offer] = await crawlOffers(h, 1);
    const id = offer?.id as number;
    const stored = rowOf(h, id);
    const facts = JSON.parse(stored?.modelFacts ?? "null") as ModelFacts;
    const run = parseStoredAnalysis(stored?.analysis ?? null).run;
    if (run === undefined) throw new Error("no stored analysis");

    h.runtime.offers.requestReanalysis(id);
    expect(owedSince(h, id)).toEqual(new Date(h.clock.now));
    h.runtime.offers.saveAnalysis(id, facts, run);
    expect(owedSince(h, id)).toBeNull();

    h.runtime.offers.requestReanalysis(id);
    h.runtime.offers.failAnalysis(id, "refused");
    expect(owedSince(h, id)).toBeNull();
    expect(await statusOf(h, id)).toBe("kept-previous");
  });

  it("keeps the first click's time when the Offer is clicked again", async () => {
    const { h, second } = await clickQueuedBehindARead();
    const since = owedSince(h, second);

    h.clock.now += 1000;
    expect((await click(h, second)).status).toBe(202);

    expect(owedSince(h, second)).toEqual(since);
  });

  it("waits out the spend cap across a restart, and is read once there is room", async () => {
    const before = await clickQueuedBehindARead();
    const { second } = before;
    await change(before.h, { monthlySpendCapUsd: 0 });
    before.api.release();
    await before.h.runtime.analysis.idle();
    expect(before.api.requests).toHaveLength(3);
    expect(await statusOf(before.h, second)).toBe("waiting-for-cap");

    const { h, api } = restart(before.h);

    expect(await statusOf(h, second)).toBe("waiting-for-cap");
    await h.runtime.analysis.idle();
    expect(api.requests).toHaveLength(0);

    await change(h, { monthlySpendCapUsd: 5 });
    await h.runtime.analysis.idle();
    expect(api.requests).toHaveLength(1);
    expect(await statusOf(h, second)).toBe("analyzed");
    expect(owedSince(h, second)).toBeNull();
  });

  it("waits for a key that was cleared after the 202, instead of being dropped", async () => {
    const { h, api, second } = await clickQueuedBehindARead();
    expect((await h.call("DELETE", "/secrets/anthropic")).status).toBe(204);
    api.release();
    await h.runtime.analysis.idle();

    expect(await statusOf(h, second)).toBe("waiting-for-key");
    expect(api.requests).toHaveLength(3);

    await setKey(h);
    await h.runtime.analysis.idle();
    expect(api.requests).toHaveLength(4);
    expect(await statusOf(h, second)).toBe("analyzed");
  });

  it("waits for a batch that holds its Offer, and ends with the batch's result", async () => {
    const h = boot();
    await setKey(h);
    await change(h, { batchOnly: true });
    const [offer] = await crawlOffers(h, 1);
    const id = offer?.id as number;
    // As a merge can leave it: owed a click's read while a batch holds the Offer's request.
    h.runtime.offers.requestReanalysis(id);

    h.runtime.analysis.sweep();
    await h.runtime.analysis.idle();
    expect(h.requests).toHaveLength(0);
    expect(owedSince(h, id)).not.toBeNull();
    expect(await statusOf(h, id)).toBe("in-batch");

    await poll(h);
    h.batch.complete();
    await poll(h);
    expect(await statusOf(h, id)).toBe("analyzed");
    expect(owedSince(h, id)).toBeNull();
    expect(h.requests).toHaveLength(0);
  });

  it("is the batch's once its first pass escalates, and a restart reads nothing again", async () => {
    const before = boot({ script: [anmeldungOk, doubtful] });
    await setKey(before);
    const [offer] = await crawlOffers(before, 1);
    const id = offer?.id as number;

    expect((await click(before, id)).status).toBe(202);
    await before.runtime.analysis.idle();
    expect(owedSince(before, id)).toBeNull();
    expect(await statusOf(before, id)).toBe("in-batch");
    before.runtime.close();

    const h = boot({
      dataDir: before.dataDir,
      start: before.clock.now,
      sameProviders: {
        realtime: { provider: before.provider, requests: before.requests },
        batch: before.batch,
      },
    });
    await poll(h);
    h.batch.complete();
    await poll(h);

    expect(h.requests).toHaveLength(2);
    expect(h.batch.submissions.flat()).toHaveLength(1);
    expect((await offerOf(h, id)).analysis.escalated).toBe(true);
  });
});

function ingestStored(h: Pick<Boot, "runtime" | "clock">, ...specs: AdSpec[]) {
  for (const spec of specs) {
    h.runtime.snapshots.write("wg-gesucht", String(spec.adId), adPage(spec));
  }
  return ingestAds(h as ReturnType<typeof bootOffers>, ...specs);
}

/** The sentence the scripted answer quotes: with it on the page, the first pass is final. */
const QUOTED = "Anmeldung ist möglich.";
/** Three rooms dedupe keeps apart. */
const ROOMS: AdSpec[] = [
  { adId: 9000001, roomSize: 18, text: `${ROOM_TEXT} ${QUOTED}` },
  { adId: 9000002, roomSize: 12, text: `${OTHER_ROOM_TEXT} ${QUOTED}`, images: [photo(40)] },
  { adId: 9000003, roomSize: 25, text: `Ein ganz anderer Text. ${QUOTED}`, images: [photo(50)] },
];
const idOf = async (h: Harness, adId: number) =>
  (await h.json("GET", `/offers/lookup?adId=${adId}`)).body.id as number;

describe("an owed Re-analyse click through a merge and a split", () => {
  it("is read on the Offer that took its Offer in", async () => {
    const api = holdableProvider();
    const h = bootWith(api);
    await setKey(h);
    ingestStored(h, ...ROOMS);
    await h.runtime.analysis.idle();
    expect(api.requests).toHaveLength(3);
    const [first, second, third] = [
      await idOf(h, 9000001),
      await idOf(h, 9000002),
      await idOf(h, 9000003),
    ];
    api.hold();
    expect((await click(h, third)).status).toBe(202);
    expect((await click(h, second)).status).toBe(202);

    expect((await h.json("POST", `/offers/${first}/merge`, { offerId: second })).status).toBe(200);

    expect(await statusOf(h, first)).toBe("queued");
    api.release();
    await h.runtime.analysis.idle();
    h.runtime.analysis.sweep();
    await h.runtime.analysis.idle();
    expect(api.requests).toHaveLength(5);
    expect(await statusOf(h, first)).toBe("analyzed");
    expect(owedSince(h, first)).toBeNull();
  });

  it("carries the earlier click over a merge, and leaves a split-off Offer owed nothing", async () => {
    // No key: nothing is read, so the clicks stay as they are set.
    const h = bootOffers();
    ingestStored(h, ...ROOMS.slice(0, 2));
    const [first, second] = [await idOf(h, 9000001), await idOf(h, 9000002)];
    const [early, late] = [new Date(1_000), new Date(2_000)];
    const { db } = h.runtime;
    db.update(offers).set({ reanalyzeRequestedAt: late }).where(eq(offers.id, first)).run();
    db.update(offers).set({ reanalyzeRequestedAt: early }).where(eq(offers.id, second)).run();

    await h.json("POST", `/offers/${first}/merge`, { offerId: second });
    expect(owedSince(h, first)).toEqual(early);

    const split = await h.json("POST", `/offers/${first}/split`, { adId: "9000002" });
    expect(split.status).toBe(201);
    expect(owedSince(h, split.body.id)).toBeNull();
    expect(owedSince(h, first)).toEqual(early);
  });
});

const refuseWrites = (h: Harness) => h.runtime.db.$client.pragma("query_only = ON");

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(check()).toBe(true);
}

async function threeCycles(h: Pick<Boot, "runtime" | "clock">) {
  for (let cycle = 0; cycle < 3; cycle++) {
    h.clock.now += 5 * MINUTE;
    h.runtime.analysis.sweep();
    await h.runtime.analysis.idle();
  }
}

describe("a call whose outcome the database would not store", () => {
  it("is not sent again for a click by the same process, and is read once after a restart", async () => {
    const api = holdableProvider();
    const h = bootWith(api);
    await setKey(h);
    const [offer] = await crawlOffers(h, 1);
    const id = offer?.id as number;
    api.hold();
    expect((await click(h, id)).status).toBe(202);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    refuseWrites(h);
    api.release();
    await h.runtime.analysis.idle();
    const sent = api.requests.length;
    expect(sent).toBeGreaterThan(1);
    expect(owedSince(h, id)).not.toBeNull();

    await threeCycles(h);
    expect(api.requests).toHaveLength(sent);
    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines.filter((line) => line.includes(`Offer ${id} stopped`))).toEqual([
      `Analysis of Offer ${id} stopped on an internal error; it is not sent again before a restart or a click`,
    ]);
    log.mockRestore();

    const later = restart(h);
    await later.h.runtime.analysis.idle();
    expect(later.api.requests).toHaveLength(1);
    expect(await statusOf(later.h, id)).toBe("analyzed");
    expect(owedSince(later.h, id)).toBeNull();
  });

  it("is not sent again for a new Offer either", async () => {
    const api = holdableProvider();
    const h = bootWith(api);
    await setKey(h);
    api.hold();
    h.site.cards = h.freshCards([9000001]);
    await h.addSearch();
    await h.crawl();
    await waitFor(() => api.requests.length === 1);
    refuseWrites(h);
    api.release();
    await h.runtime.analysis.idle();
    const sent = api.requests.length;

    await threeCycles(h);

    expect(api.requests).toHaveLength(sent);
  });

  it("says so on a clicked Offer, which keeps its earlier reading and waits for another click", async () => {
    const api = holdableProvider();
    const h = bootWith(api);
    await setKey(h);
    const [offer] = await crawlOffers(h, 1);
    const id = offer?.id as number;
    api.hold();
    expect((await click(h, id)).status).toBe(202);
    refuseWrites(h);
    api.release();
    await h.runtime.analysis.idle();
    h.runtime.db.$client.pragma("query_only = OFF");

    expect((await offerOf(h, id)).analysisStatus).toEqual({
      status: "kept-previous",
      next: "reanalyze",
      reason: "outcome_not_stored",
      at: null,
      willRead: false,
    });
    expect((await h.json("GET", "/analysis")).body.awaiting).toBe(0);

    expect((await click(h, id)).status).toBe(202);
    await h.runtime.analysis.idle();
    expect(await statusOf(h, id)).toBe("analyzed");
  });

  it("says so on a new Offer, which waits for a click instead of counting as queued", async () => {
    const api = holdableProvider();
    const h = bootWith(api);
    await setKey(h);
    api.hold();
    h.site.cards = h.freshCards([9000001]);
    await h.addSearch();
    await h.crawl();
    await waitFor(() => api.requests.length === 1);
    refuseWrites(h);
    api.release();
    await h.runtime.analysis.idle();
    h.runtime.db.$client.pragma("query_only = OFF");
    const id = await idOf(h, 9000001);

    expect((await offerOf(h, id)).analysisStatus).toEqual({
      status: "needs-click",
      next: "reanalyze",
      reason: "outcome_not_stored",
      at: null,
      willRead: false,
    });
    const overview = (await h.json("GET", "/analysis")).body;
    expect(overview.awaiting).toBe(0);
    expect(overview.byStatus).toMatchObject({ "needs-click": 1, queued: 0 });
  });

  it("is not sent as a batch either, once the Offer has waited long enough to be a backfill", async () => {
    const api = holdableProvider();
    const h = bootWith(api);
    await setKey(h);
    api.hold();
    h.site.cards = h.freshCards([9000001]);
    await h.addSearch();
    await h.crawl();
    await waitFor(() => api.requests.length === 1);
    refuseWrites(h);
    api.release();
    await h.runtime.analysis.idle();
    h.runtime.db.$client.pragma("query_only = OFF");
    const sent = api.requests.length;
    const id = await idOf(h, 9000001);

    h.clock.now += 3 * 60 * MINUTE;
    h.runtime.analysis.sweep();
    await h.runtime.analysis.idle();
    await poll(h);

    expect(h.batch.submissions.flat()).toHaveLength(0);
    expect(api.requests).toHaveLength(sent);
    expect((await offerOf(h, id)).analysisStatus).toMatchObject({
      status: "needs-click",
      reason: "outcome_not_stored",
    });
  });

  it("is sent once more when the seeker clicks again", async () => {
    const api = holdableProvider();
    const h = bootWith(api);
    await setKey(h);
    const [offer] = await crawlOffers(h, 1);
    const id = offer?.id as number;
    api.hold();
    expect((await click(h, id)).status).toBe(202);
    refuseWrites(h);
    api.release();
    await h.runtime.analysis.idle();
    const sent = api.requests.length;
    h.runtime.db.$client.pragma("query_only = OFF");
    await threeCycles(h);
    expect(api.requests).toHaveLength(sent);

    expect((await click(h, id)).status).toBe(202);
    await h.runtime.analysis.idle();

    expect(api.requests).toHaveLength(sent + 1);
    expect(await statusOf(h, id)).toBe("analyzed");
    expect(owedSince(h, id)).toBeNull();
  });
});
