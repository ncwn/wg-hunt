import { type AnalysisProvider, type BatchRequest, ProviderError } from "@wg-hunt/core";
import { fakeBatchProvider, fakeProvider, type Scripted } from "@wg-hunt/core/analysis/testing";
import { describe, expect, it, vi } from "vitest";
import { carryWaiting } from "../src/analysis/batch-state.js";
import { analysisItems, analysisUsage, offerAds, offers } from "../src/db/schema.js";
import {
  anmeldungOk,
  type Boot,
  boot,
  change,
  doubtful,
  MINUTE,
  offerOf,
  poll,
  setKey,
} from "./analysis-harness.js";
import {
  type AdSpec,
  adPage,
  ingestAds,
  OTHER_ROOM_TEXT,
  photo,
  ROOM_TEXT,
} from "./dedupe-harness.js";

/** The sentence the scripted answers quote. */
const QUOTED = "Anmeldung ist möglich.";
/** Two rooms dedupe keeps apart; the second is the most recently active, so a merge shows its page. */
const [KEPT, TAKEN] = [
  { adId: 9000001, roomSize: 18, text: `${ROOM_TEXT} ${QUOTED}` },
  { adId: 9000002, roomSize: 12, text: `${OTHER_ROOM_TEXT} ${QUOTED}`, images: [photo(40)] },
] as const satisfies AdSpec[];

function ingestStored(h: Boot, ...specs: AdSpec[]) {
  for (const spec of specs) {
    h.runtime.snapshots.write("wg-gesucht", String(spec.adId), adPage(spec));
  }
  return ingestAds(h, ...specs);
}

const idOf = async (h: Boot, adId: number) =>
  (await h.json("GET", `/offers/lookup?adId=${adId}`)).body.id as number;
const statusOf = async (h: Boot, id: number) => (await offerOf(h, id)).analysisStatus.status;
const waiting = (h: Boot) =>
  h.runtime.db
    .select()
    .from(analysisItems)
    .all()
    .filter((item) => item.state === "queued" || item.state === "submitted");
const merge = async (h: Boot, survivor: number, absorbed: number) =>
  expect((await h.json("POST", `/offers/${survivor}/merge`, { offerId: absorbed })).status).toBe(
    200,
  );

/** Both rooms read; the next realtime answer, a click's first pass, asks for an escalation. */
async function twoReadRooms() {
  const scripted = fakeProvider([anmeldungOk, anmeldungOk, doubtful]);
  let gate: Promise<void> | undefined;
  let open = () => {};
  const provider: AnalysisProvider = {
    async analyse(request) {
      await gate;
      return scripted.provider.analyse(request);
    },
  };
  const h = boot({
    sameProviders: {
      realtime: { ...scripted, provider },
      batch: fakeBatchProvider([anmeldungOk]),
    },
  });
  await setKey(h);
  ingestStored(h, KEPT, TAKEN);
  await h.runtime.analysis.idle();
  expect(scripted.requests).toHaveLength(2);
  return {
    h,
    kept: await idOf(h, KEPT.adId),
    taken: await idOf(h, TAKEN.adId),
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

const click = async (h: Boot, id: number) =>
  expect((await h.call("POST", `/offers/${id}/reanalyze`)).status).toBe(202);

async function endBatch(h: Boot) {
  await poll(h);
  h.batch.complete();
  await poll(h);
}

describe("a merge while a Re-analyse click's escalation waits on the absorbed Offer", () => {
  it("carries a request that is still queued to the survivor", async () => {
    const { h, kept, taken, hold, release } = await twoReadRooms();
    hold();
    await click(h, taken);
    // Without a key nothing is sent, so the escalation stays queued.
    expect((await h.call("DELETE", "/secrets/anthropic")).status).toBe(204);
    release();
    await h.runtime.analysis.idle();
    expect(waiting(h)).toMatchObject([{ offerId: taken, stage: 2, state: "queued" }]);

    await merge(h, kept, taken);

    expect(waiting(h)).toMatchObject([{ offerId: kept, stage: 2, state: "queued" }]);
    await setKey(h);
    await endBatch(h);
    expect(h.batch.submissions.flat()).toHaveLength(1);
    expect((await offerOf(h, kept)).analysis.escalated).toBe(true);
  });

  it("carries a request a batch already holds to the survivor", async () => {
    const { h, kept, taken } = await twoReadRooms();
    await click(h, taken);
    await h.runtime.analysis.idle();
    expect(waiting(h)).toMatchObject([{ offerId: taken, stage: 2, state: "submitted" }]);

    await merge(h, kept, taken);

    expect(await statusOf(h, kept)).toBe("in-batch");
    await endBatch(h);
    expect((await offerOf(h, kept)).analysis.escalated).toBe(true);
    expect(h.requests).toHaveLength(3);
    expect(h.batch.submissions.flat()).toHaveLength(1);
  });
});

describe("a merge while a batch reads the absorbed Offer's words", () => {
  it("does not send them again from the survivor", async () => {
    const h = boot();
    await setKey(h);
    ingestStored(h, KEPT);
    await h.runtime.analysis.idle();
    await change(h, { batchOnly: true });
    ingestStored(h, TAKEN);
    await h.runtime.analysis.idle();
    const [kept, taken] = [await idOf(h, KEPT.adId), await idOf(h, TAKEN.adId)];
    expect(waiting(h)).toMatchObject([{ offerId: taken, stage: 1, state: "submitted" }]);

    await merge(h, kept, taken);

    expect(await statusOf(h, kept)).toBe("in-batch");
    h.runtime.analysis.sweep();
    await h.runtime.analysis.idle();
    await endBatch(h);
    h.runtime.analysis.sweep();
    await h.runtime.analysis.idle();
    expect(h.batch.submissions.flat()).toHaveLength(1);
    expect(h.requests).toHaveLength(1);
    expect(await statusOf(h, kept)).toBe("analyzed");
    expect(h.runtime.offers.analysisJob(kept)?.wordsChanged).toBe(false);
  });
});

type BootOptions = NonNullable<Parameters<typeof boot>[0]>;
type BatchScript = NonNullable<BootOptions["batchScript"]>;

/** Offers a batch reads the same words for. */
async function sameWords(
  count: number,
  batchScript: BatchScript,
  size = 100,
  script?: BootOptions["script"],
) {
  const h = boot({ batchScript, size, ...(script && { script }) });
  const ids = await postedWithSameWords(h, count);
  await change(h, { batchOnly: true });
  await setKey(h);
  await h.runtime.analysis.idle();
  return { h, ids };
}

const billedBatchAnswers = (h: Boot) =>
  h.runtime.db
    .select()
    .from(analysisUsage)
    .all()
    .filter((row) => row.batch).length;

describe("a merge of two Offers a batch is reading the same words for", () => {
  it("escalates the words once, though both first passes ask for it", async () => {
    const { h, ids } = await sameWords(2, [doubtful, doubtful, anmeldungOk]);
    const [room, other] = ids as [number, number];
    expect(waiting(h)).toMatchObject([{ state: "submitted" }, { state: "submitted" }]);

    await merge(h, room, other);
    await endBatch(h);

    expect(h.batch.submissions.map((batch) => batch.length)).toEqual([2, 1]);
    await endBatch(h);
    expect((await offerOf(h, room)).analysis.escalated).toBe(true);
    expect(waiting(h)).toEqual([]);
  });
});

describe("a merge of two Offers whose same words are in two batches", () => {
  for (const merged of ["before either answer", "after the first one's escalation"] as const) {
    for (const [late, answer] of [
      ["is sure", anmeldungOk],
      ["asks for an escalation", doubtful],
    ] as const) {
      it(`keeps the escalated result: merged ${merged}, the other first pass ends late and ${late}`, async () => {
        const { h, ids } = await sameWords(2, [doubtful, anmeldungOk, answer, anmeldungOk], 1);
        const [room, other] = ids as [number, number];
        if (merged === "before either answer") await merge(h, room, other);
        await poll(h);
        h.batch.complete("batch-1");
        await poll(h);
        h.batch.complete("batch-3");
        await poll(h);
        if (merged !== "before either answer") await merge(h, room, other);
        expect((await offerOf(h, room)).analysis.escalated).toBe(true);

        h.batch.complete("batch-2");
        await poll(h);

        const end = await offerOf(h, room);
        expect(end.analysis.escalated).toBe(true);
        expect(end.analysisStatus.status).toBe("analyzed");
        expect(h.batch.submissions).toHaveLength(3);
        expect(waiting(h)).toEqual([]);
        // The late answer was billed all the same.
        expect(billedBatchAnswers(h)).toBe(3);
      });
    }
  }
});

describe("a merge into an Offer still waiting on words the absorbed one has finished reading", () => {
  for (const [late, answer] of [
    ["is sure", anmeldungOk],
    ["asks for an escalation", doubtful],
  ] as const) {
    it(`keeps the escalated result when the survivor's first pass ends late and ${late}`, async () => {
      const { h, ids } = await sameWords(2, [doubtful, anmeldungOk, answer], 1);
      const [room, other] = ids as [number, number];
      await poll(h);
      h.batch.complete("batch-2");
      await poll(h);
      h.batch.complete("batch-3");
      await poll(h);
      const finished = (await offerOf(h, other)).analysis;
      expect(finished.escalated).toBe(true);
      expect(waiting(h)).toMatchObject([{ offerId: room, stage: 1, state: "submitted" }]);

      await merge(h, room, other);

      expect((await offerOf(h, room)).analysis).toEqual(finished);
      expect(waiting(h)).toEqual([]);
      h.batch.complete("batch-1");
      await poll(h);
      h.runtime.analysis.sweep();
      await h.runtime.analysis.idle();
      await poll(h);
      const end = await offerOf(h, room);
      expect(end.analysis).toEqual(finished);
      expect(end.analysisStatus.status).toBe("analyzed");
      expect(h.batch.submissions).toHaveLength(3);
      expect(waiting(h)).toEqual([]);
      expect(billedBatchAnswers(h)).toBe(3);
    });
  }

  it("withdraws the survivor's waiting escalation when the absorbed Offer holds the final result", async () => {
    const { h, ids } = await sameWords(2, [doubtful, anmeldungOk, anmeldungOk], 1);
    const [room, other] = ids as [number, number];
    await poll(h);
    h.batch.complete("batch-1");
    await poll(h);
    h.batch.complete("batch-2");
    await poll(h);
    expect((await offerOf(h, room)).analysisStatus.status).not.toBe("analyzed");
    expect(waiting(h)).toMatchObject([{ offerId: room, stage: 2, state: "submitted" }]);
    const finished = (await offerOf(h, other)).analysis;

    await merge(h, room, other);

    expect((await offerOf(h, room)).analysis).toEqual(finished);
    expect(waiting(h)).toEqual([]);
    h.batch.complete("batch-3");
    await poll(h);
    h.runtime.analysis.sweep();
    await h.runtime.analysis.idle();
    await poll(h);
    const end = await offerOf(h, room);
    expect(end.analysis).toEqual(finished);
    expect(end.analysisStatus.status).toBe("analyzed");
    expect(h.batch.submissions).toHaveLength(3);
    expect(billedBatchAnswers(h)).toBe(3);
  });

  it("keeps a Re-analyse click's request on a survivor that had read as far", async () => {
    const { h, ids } = await sameWords(2, [anmeldungOk], 100, [doubtful]);
    const [room, other] = ids as [number, number];
    await endBatch(h);
    await click(h, room);
    await h.runtime.analysis.idle();
    expect(waiting(h)).toMatchObject([{ offerId: room, stage: 2, state: "submitted" }]);

    await merge(h, room, other);

    expect(waiting(h)).toMatchObject([{ offerId: room, stage: 2, state: "submitted" }]);
    await endBatch(h);
    expect((await offerOf(h, room)).analysis.escalated).toBe(true);
    expect(waiting(h)).toEqual([]);
  });
});

/** The realtime call numbered `held` (from 0) waits for `release`. */
function heldRealtime(script: Parameters<typeof fakeProvider>[0], held: number) {
  const scripted = fakeProvider(script);
  let arrived = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider: AnalysisProvider = {
    async analyse(request) {
      if (arrived++ === held) await gate;
      return scripted.provider.analyse(request);
    },
  };
  return {
    realtime: { ...scripted, provider },
    out: () => vi.waitFor(() => expect(arrived).toBeGreaterThan(held)),
    release: () => release(),
  };
}

/** One room posted `count` times with the same words, every post but the first split off. */
async function postedWithSameWords(h: Boot, count = 2) {
  const words = { title: "Zimmer in Mitte", text: `${ROOM_TEXT} ${QUOTED}` };
  const adIds = Array.from({ length: count }, (_, index) => 9000001 + index);
  ingestStored(h, ...adIds.map((adId) => ({ adId, ...words })));
  const room = await idOf(h, 9000001);
  const ids = [room];
  for (const adId of adIds.slice(1)) {
    const split = await h.json("POST", `/offers/${room}/split`, { adId: String(adId) });
    expect(split.status).toBe(201);
    ids.push(split.body.id as number);
  }
  return ids;
}

async function postedTwice(h: Boot) {
  const [room, other] = (await postedWithSameWords(h)) as [number, number];
  return { room, other };
}

describe("a merge while a realtime read is out", () => {
  const isEscalation = (request: BatchRequest) => request.request.effort === "high";
  const usageRows = (h: Boot, batch: boolean) =>
    h.runtime.db
      .select()
      .from(analysisUsage)
      .all()
      .filter((row) => row.batch === batch).length;
  const adHash = (h: Boot, adId: number) =>
    h.runtime.db
      .select()
      .from(offerAds)
      .all()
      .find((ad) => ad.adId === String(adId))?.contentHash;

  it("drops the survivor's answer when the absorbed Offer had already read the same words", async () => {
    const held = heldRealtime([anmeldungOk, doubtful], 1);
    const h = boot({ sameProviders: { realtime: held.realtime, batch: fakeBatchProvider([]) } });
    const { room, other: reading } = await postedTwice(h);
    await setKey(h);
    h.runtime.analysis.sweep();
    await held.out();
    const finished = (await offerOf(h, room)).analysis;
    expect(finished.analyzedAt).not.toBe(null);

    await merge(h, reading, room);
    held.release();
    await h.runtime.analysis.idle();

    expect(held.realtime.requests).toHaveLength(2);
    const end = await offerOf(h, reading);
    expect(end.analysis).toEqual(finished);
    expect(end.analysisStatus.status).toBe("analyzed");
    expect(h.runtime.db.select().from(analysisItems).all()).toEqual([]);
  });

  it("stores a click's read on the Offer that took the click over, and sends the words no more often", async () => {
    const held = heldRealtime([anmeldungOk], 0);
    const h = boot({
      size: 1,
      sameProviders: {
        realtime: held.realtime,
        batch: fakeBatchProvider([doubtful, anmeldungOk, anmeldungOk]),
      },
    });
    const { room, other } = await postedTwice(h);
    await change(h, { batchOnly: true });
    await setKey(h);
    await h.runtime.analysis.idle();
    await poll(h);
    h.batch.complete("batch-1");
    await poll(h);
    h.batch.complete("batch-2");
    await poll(h);
    expect(waiting(h)).toMatchObject([{ offerId: room, stage: 2, state: "submitted" }]);
    const finished = (await offerOf(h, other)).analysis;
    await click(h, other);
    await held.out();

    await merge(h, room, other);
    expect(waiting(h)).toEqual([]);
    expect(h.runtime.offers.analysisJob(room)?.reanalyzeRequestedAt).not.toBe(null);
    h.clock.now += MINUTE;
    held.release();
    await h.runtime.analysis.idle();

    const stored = await offerOf(h, room);
    expect(stored.analysis.analyzedAt).not.toBe(finished.analyzedAt);
    expect(stored.analysisStatus.status).toBe("analyzed");
    expect(h.runtime.offers.analysisJob(room)?.reanalyzeRequestedAt).toBe(null);
    h.runtime.analysis.sweep();
    await h.runtime.analysis.idle();
    await poll(h);
    const firstPasses = h.batch.submissions.flat().filter((request) => !isEscalation(request));
    expect(held.realtime.requests.length + firstPasses.length).toBe(3);
    expect(waiting(h)).toEqual([]);
  });

  for (const result of ["final", "escalated"] as const) {
    for (const [late, answer] of [
      ["sure", anmeldungOk],
      ["doubtful", doubtful],
    ] as const) {
      for (const survives of ["clicked", "inBatch"] as const) {
        it(`withdraws a first pass sent before a click whose read is out: ${result} result, ${late} late answer, ${survives} survives`, async () => {
          const firstPasses = result === "escalated" ? [doubtful, anmeldungOk] : [anmeldungOk];
          const held = heldRealtime([anmeldungOk], 0);
          const h = boot({
            size: 1,
            sameProviders: {
              realtime: held.realtime,
              batch: fakeBatchProvider([...firstPasses, answer]),
            },
          });
          const { room: clicked, other: inBatch } = await postedTwice(h);
          await change(h, { batchOnly: true });
          await setKey(h);
          await h.runtime.analysis.idle();
          await poll(h);
          h.batch.complete("batch-1");
          await poll(h);
          if (result === "escalated") {
            h.batch.complete("batch-3");
            await poll(h);
          }
          const before = (await offerOf(h, clicked)).analysis;
          expect(before.escalated).toBe(result === "escalated");
          expect(waiting(h)).toMatchObject([{ offerId: inBatch, stage: 1, state: "submitted" }]);
          await click(h, clicked);
          await held.out();
          const [survivor, absorbed] =
            survives === "clicked" ? [clicked, inBatch] : [inBatch, clicked];

          await merge(h, survivor, absorbed);

          expect(waiting(h)).toEqual([]);
          h.clock.now += MINUTE;
          held.release();
          await h.runtime.analysis.idle();
          const stored = (await offerOf(h, survivor)).analysis;
          expect(stored.analyzedAt).not.toBe(before.analyzedAt);
          expect(stored.escalated).toBe(false);
          expect(h.runtime.offers.analysisJob(survivor)?.reanalyzeRequestedAt).toBe(null);
          h.batch.complete("batch-2");
          await poll(h);
          h.runtime.analysis.sweep();
          await h.runtime.analysis.idle();
          await poll(h);

          expect((await offerOf(h, survivor)).analysis).toEqual(stored);
          const answers = h.batch.submissions.flat();
          expect(answers.filter(isEscalation)).toHaveLength(result === "escalated" ? 1 : 0);
          expect(held.realtime.requests).toHaveLength(1);
          expect(usageRows(h, false)).toBe(1);
          expect(usageRows(h, true)).toBe(answers.length);
          expect(waiting(h)).toEqual([]);
        });
      }
    }
  }

  it("stores the absorbed Offer's answer on a survivor that had read nothing", async () => {
    const held = heldRealtime([anmeldungOk], 0);
    const h = boot({ sameProviders: { realtime: held.realtime, batch: fakeBatchProvider([]) } });
    const { room, other } = await postedTwice(h);
    await setKey(h);
    h.runtime.analysis.sweep();
    await held.out();

    await merge(h, other, room);
    held.release();
    await h.runtime.analysis.idle();
    h.runtime.analysis.sweep();
    await h.runtime.analysis.idle();

    expect(await statusOf(h, other)).toBe("analyzed");
    expect(h.runtime.offers.analysisJob(other)?.wordsChanged).toBe(false);
    expect(held.realtime.requests).toHaveLength(1);
  });

  it("drops the survivor's answer when the merge brings a batch request for the same words", async () => {
    const held = heldRealtime([doubtful], 0);
    const h = boot({
      sameProviders: { realtime: held.realtime, batch: fakeBatchProvider([doubtful, anmeldungOk]) },
    });
    const words = { title: "Zimmer in Mitte", text: `${ROOM_TEXT} ${QUOTED}` };
    ingestStored(h, { adId: 9000001, ...words }, { adId: 9000002, ...words });
    const room = await idOf(h, 9000001);
    await change(h, { batchOnly: true });
    await setKey(h);
    await h.runtime.analysis.idle();
    await change(h, { batchOnly: false });
    const made = await h.json("POST", `/offers/${room}/split`, { adId: "9000002" });
    const reading = made.body.id as number;
    expect(waiting(h)).toMatchObject([{ offerId: room, stage: 1, state: "submitted" }]);
    h.runtime.analysis.sweep();
    await held.out();

    await merge(h, reading, room);
    expect(waiting(h)).toMatchObject([{ offerId: reading, stage: 1, state: "submitted" }]);
    held.release();
    await h.runtime.analysis.idle();
    expect(h.runtime.offers.analysisJob(reading)?.state).toBe("pending");
    await endBatch(h);
    await endBatch(h);

    expect((await offerOf(h, reading)).analysis.escalated).toBe(true);
    expect(h.batch.submissions.flat().filter(isEscalation)).toHaveLength(1);
    expect(waiting(h)).toEqual([]);
    expect(usageRows(h, false)).toBe(1);
    expect(usageRows(h, true)).toBe(2);
  });

  /**
   * Two Offers with the same words: `finished` holds the final result, `clicked` was refused and
   * has read nothing. A click on `clicked` is out, answered with `answer`.
   */
  async function clickOut(answer: Scripted) {
    const held = heldRealtime(
      (call) => [anmeldungOk, new ProviderError("refused"), answer][Math.min(call, 2)] as Scripted,
      2,
    );
    const h = boot({
      sameProviders: { realtime: held.realtime, batch: fakeBatchProvider([anmeldungOk]) },
    });
    const { room: finished, other: clicked } = await postedTwice(h);
    await setKey(h);
    await h.runtime.analysis.idle();
    expect(h.runtime.offers.analysisJob(clicked)).toMatchObject({ state: "failed", readDepth: 0 });
    expect(h.runtime.offers.analysisJob(finished)?.readDepth).toBe(2);
    expect(waiting(h)).toEqual([]);
    const result = (await offerOf(h, finished)).analysis;
    await click(h, clicked);
    await held.out();
    h.clock.now += MINUTE;
    return { h, held, finished, clicked, result };
  }

  for (const survives of ["clicked", "finished"] as const) {
    const other = survives === "clicked" ? "finished" : "clicked";

    it(`stores a click's read over the final result it was merged with: ${survives} survives`, async () => {
      const { h, held, result, ...ids } = await clickOut(anmeldungOk);

      await merge(h, ids[survives], ids[other]);
      held.release();
      await h.runtime.analysis.idle();

      const merged = ids[survives];
      const stored = await offerOf(h, merged);
      expect(stored.analysis.analyzedAt).not.toBe(result.analyzedAt);
      expect(stored.analysisStatus.status).toBe("analyzed");
      expect(h.runtime.offers.analysisJob(merged)?.reanalyzeRequestedAt).toBe(null);
      h.runtime.analysis.sweep();
      await h.runtime.analysis.idle();
      expect(held.realtime.requests).toHaveLength(3);
      expect(waiting(h)).toEqual([]);
    });

    it(`hands a click over to its escalation on the final result it was merged with: ${survives} survives`, async () => {
      const { h, held, result, ...ids } = await clickOut(doubtful);

      await merge(h, ids[survives], ids[other]);
      held.release();
      await h.runtime.analysis.idle();

      const merged = ids[survives];
      expect((await offerOf(h, merged)).analysis).toEqual(result);
      expect(h.runtime.offers.analysisJob(merged)?.reanalyzeRequestedAt).toBe(null);
      expect(waiting(h)).toMatchObject([{ offerId: merged, stage: 2 }]);
      h.runtime.analysis.sweep();
      await h.runtime.analysis.idle();
      expect(held.realtime.requests).toHaveLength(3);
      expect(h.batch.submissions.flat()).toHaveLength(1);
      expect(waiting(h)).toHaveLength(1);
    });
  }

  it("records a click's failed call on the Offer that absorbed the one it went out for", async () => {
    const { h, held, finished, clicked } = await clickOut(new ProviderError("truncated"));

    await merge(h, finished, clicked);
    held.release();
    await h.runtime.analysis.idle();

    expect(h.runtime.offers.analysisJob(finished)).toMatchObject({
      reanalyzeRequestedAt: null,
      failure: { kind: "truncated" },
    });
    expect((await offerOf(h, finished)).analysisStatus.status).not.toBe("reading");
    h.runtime.analysis.sweep();
    await h.runtime.analysis.idle();
    expect(held.realtime.requests).toHaveLength(3);
    expect(waiting(h)).toEqual([]);
  });

  for (const [kind, before] of [
    ["truncated", "failed"],
    ["invalid_response", "failed"],
    ["truncated", "analyzed"],
  ] as const) {
    it(`records no ${kind} on a survivor showing other words, ${before} before the merge`, async () => {
      const held = heldRealtime(
        (call) =>
          [
            anmeldungOk,
            before === "analyzed" ? anmeldungOk : new ProviderError("refused"),
            new ProviderError(kind),
            anmeldungOk,
          ][Math.min(call, 3)] as Scripted,
        2,
      );
      const h = boot({ sameProviders: { realtime: held.realtime, batch: fakeBatchProvider([]) } });
      await setKey(h);
      ingestStored(h, KEPT, TAKEN);
      await h.runtime.analysis.idle();
      const [clicked, shown] = [await idOf(h, KEPT.adId), await idOf(h, TAKEN.adId)];
      expect(h.runtime.offers.analysisJob(shown)?.state).toBe(before);
      await click(h, clicked);
      await held.out();

      await merge(h, shown, clicked);
      expect(h.runtime.offers.analysisJob(shown)?.adId).toBe(String(TAKEN.adId));
      h.clock.now += MINUTE;
      held.release();
      await h.runtime.analysis.idle();
      h.runtime.analysis.sweep();
      await h.runtime.analysis.idle();

      expect(h.runtime.offers.analysisJob(shown)).toMatchObject({
        state: "analyzed",
        wordsChanged: false,
        reanalyzeRequestedAt: null,
        failure: null,
      });
      expect((await offerOf(h, shown)).analysisStatus.status).toBe("analyzed");
      expect(held.realtime.requests).toHaveLength(4);
    });
  }

  it("drops a click's answer when the merged Offer shows other words", async () => {
    const held = heldRealtime([anmeldungOk, anmeldungOk, doubtful], 2);
    const h = boot({ sameProviders: { realtime: held.realtime, batch: fakeBatchProvider([]) } });
    await setKey(h);
    ingestStored(h, KEPT, TAKEN);
    await h.runtime.analysis.idle();
    const [kept, taken] = [await idOf(h, KEPT.adId), await idOf(h, TAKEN.adId)];
    const finished = (await offerOf(h, taken)).analysis;
    await click(h, kept);
    await held.out();

    await merge(h, kept, taken);
    held.release();
    await h.runtime.analysis.idle();

    const oldWords = adHash(h, KEPT.adId);
    expect((await offerOf(h, kept)).analysis).toEqual(finished);
    const stored = h.runtime.db.select().from(offers).all();
    expect(stored.map((row) => JSON.parse(row.analysis ?? "{}").run?.contentHash)).toEqual([
      adHash(h, TAKEN.adId),
    ]);
    const items = h.runtime.db.select().from(analysisItems).all();
    expect(items.filter((item) => item.contentHash === oldWords)).toEqual([]);
  });
});

describe("a merge of an Offer that owes a Re-analyse click with one that read further", () => {
  for (const survives of ["clicked", "finished"] as const) {
    const other = survives === "clicked" ? "finished" : "clicked";

    it(`keeps the click's request in a batch on the merged Offer: ${survives} survives`, async () => {
      const h = boot({
        script: (call) => (call === 1 ? new ProviderError("refused") : anmeldungOk),
        batchScript: [anmeldungOk],
      });
      const { room: finished, other: clicked } = await postedTwice(h);
      await setKey(h);
      await h.runtime.analysis.idle();
      expect(h.runtime.offers.analysisJob(clicked)).toMatchObject({
        state: "failed",
        readDepth: 0,
      });
      const [first] = h.requests;
      if (first === undefined) throw new Error("not read");
      // Room for the click's first pass as a batch, not as a realtime call.
      const { spend } = h.runtime.analysis;
      const realtime = spend.estimateMicros(first, { batch: false }) ?? 0;
      const batched = spend.estimateMicros(first, { batch: true }) ?? 0;
      const cap = (spend.spentUsd() * 1e6 + (realtime + batched) / 2) / 1e6;
      await change(h, { monthlySpendCapUsd: Math.round(cap * 1e6) / 1e6 });
      await click(h, clicked);
      await h.runtime.analysis.idle();
      expect(waiting(h)).toMatchObject([{ offerId: clicked, stage: 1, state: "submitted" }]);
      const ids = { finished, clicked };
      const result = (await offerOf(h, finished)).analysis;

      await merge(h, ids[survives], ids[other]);

      const merged = ids[survives];
      expect(waiting(h)).toMatchObject([{ offerId: merged, stage: 1, state: "submitted" }]);
      h.clock.now += MINUTE;
      await endBatch(h);
      const end = await offerOf(h, merged);
      expect(end.analysis.analyzedAt).not.toBe(result.analyzedAt);
      expect(end.analysisStatus.status).toBe("analyzed");
      expect(h.runtime.offers.analysisJob(merged)?.reanalyzeRequestedAt).toBe(null);
      h.runtime.analysis.sweep();
      await h.runtime.analysis.idle();
      await poll(h);
      expect(h.requests).toHaveLength(2);
      expect(h.batch.submissions.flat()).toHaveLength(1);
      expect(waiting(h)).toEqual([]);
    });
  }

  /**
   * Three Offers with the same words: `finished` holds the final result, a batch holds `inBatch`'s
   * first pass, and `owing` was refused and owes a click that waits with nothing sent.
   */
  async function owingClick() {
    const held = heldRealtime([anmeldungOk], 0);
    const h = boot({
      size: 1,
      sameProviders: {
        realtime: held.realtime,
        batch: fakeBatchProvider([anmeldungOk, new ProviderError("refused"), anmeldungOk]),
      },
    });
    const [owing, inBatch, finished] = (await postedWithSameWords(h, 3)) as [
      number,
      number,
      number,
    ];
    await change(h, { batchOnly: true });
    await setKey(h);
    await h.runtime.analysis.idle();
    await poll(h);
    h.batch.complete("batch-3");
    await poll(h);
    h.batch.complete("batch-1");
    await poll(h);
    expect(h.runtime.offers.analysisJob(finished)?.readDepth).toBe(2);
    expect(h.runtime.offers.analysisJob(owing)).toMatchObject({ state: "failed", readDepth: 0 });
    expect(waiting(h)).toMatchObject([{ offerId: inBatch, stage: 1, state: "submitted" }]);
    // Another room's read holds the realtime worker, so the click waits with nothing sent.
    await change(h, { batchOnly: false });
    ingestStored(h, { ...TAKEN, adId: 9000009 });
    h.runtime.analysis.sweep();
    await held.out();
    await click(h, owing);
    const result = (await offerOf(h, finished)).analysis;
    return { h, held, owing, inBatch, finished, result };
  }

  /** The batch's first pass answers on `merged`, ends the click, and nothing is sent again. */
  async function answeredOnce(
    { h, held, result }: Awaited<ReturnType<typeof owingClick>>,
    merged: number,
  ) {
    expect(waiting(h)).toMatchObject([{ offerId: merged, stage: 1, state: "submitted" }]);
    h.clock.now += MINUTE;
    held.release();
    await h.runtime.analysis.idle();
    h.batch.complete("batch-2");
    await poll(h);
    const end = await offerOf(h, merged);
    expect(end.analysis.analyzedAt).not.toBe(result.analyzedAt);
    expect(end.analysisStatus.status).toBe("analyzed");
    expect(h.runtime.offers.analysisJob(merged)?.reanalyzeRequestedAt).toBe(null);
    h.runtime.analysis.sweep();
    await h.runtime.analysis.idle();
    await poll(h);
    expect(held.realtime.requests).toHaveLength(1);
    expect(h.batch.submissions.flat()).toHaveLength(3);
    expect(waiting(h)).toEqual([]);
  }

  for (const survives of ["owing", "finished"] as const) {
    it(`keeps another Offer's request it took in while owing a click: ${survives} survives`, async () => {
      const setup = await owingClick();
      const { h, owing, inBatch, finished } = setup;
      await merge(h, owing, inBatch);
      expect(h.runtime.offers.analysisJob(owing)?.reanalyzeRequestedAt).not.toBe(null);
      expect(waiting(h)).toMatchObject([{ offerId: owing, stage: 1, state: "submitted" }]);
      const [survivor, absorbed] = survives === "owing" ? [owing, finished] : [finished, owing];

      await merge(h, survivor, absorbed);

      await answeredOnce(setup, survivor);
    });
  }

  for (const survives of ["inBatch", "owing"] as const) {
    it(`keeps the request of an Offer merged with one that took a click over: ${survives} survives`, async () => {
      const setup = await owingClick();
      const { h, owing, inBatch, finished } = setup;
      await merge(h, owing, finished);
      expect(waiting(h)).toMatchObject([{ offerId: inBatch, stage: 1, state: "submitted" }]);
      const [survivor, absorbed] = survives === "inBatch" ? [inBatch, owing] : [owing, inBatch];

      await merge(h, survivor, absorbed);

      await answeredOnce(setup, survivor);
    });
  }
});

describe("a split while a batch reads an Ad ID's words", () => {
  const isEscalation = (request: BatchRequest) => request.request.effort === "high";
  const split = async (h: Boot, id: number, adId: number) => {
    const made = await h.json("POST", `/offers/${id}/split`, { adId: String(adId) });
    expect(made.status).toBe(201);
    return made.body.id as number;
  };

  /** One Offer of both rooms, whose current Ad ID is TAKEN's, with its words in a batch. */
  async function mergedRoomInBatch(batchScript: BatchScript = [anmeldungOk]) {
    const h = boot({ batchScript });
    ingestStored(h, KEPT, TAKEN);
    const [room, other] = [await idOf(h, KEPT.adId), await idOf(h, TAKEN.adId)];
    await merge(h, room, other);
    await change(h, { batchOnly: true });
    await setKey(h);
    await h.runtime.analysis.idle();
    expect(waiting(h)).toMatchObject([{ offerId: room, stage: 1, state: "submitted" }]);
    return { h, room };
  }

  async function settle(h: Boot) {
    for (let round = 0; round < 3; round++) {
      h.runtime.analysis.sweep();
      await h.runtime.analysis.idle();
      await endBatch(h);
    }
  }

  it("moves the request with the leaving Ad ID, so its words are read once", async () => {
    const { h, room } = await mergedRoomInBatch();

    const made = await split(h, room, TAKEN.adId);

    expect(waiting(h)).toMatchObject([{ offerId: made, stage: 1, state: "submitted" }]);
    expect(await statusOf(h, made)).toBe("in-batch");
    h.runtime.analysis.sweep();
    await h.runtime.analysis.idle();
    await poll(h);
    expect(h.batch.submissions.flat()).toHaveLength(2);
    expect(waiting(h).map((item) => item.offerId)).toEqual([made, room]);
    await settle(h);
    expect(await statusOf(h, made)).toBe("analyzed");
    expect(await statusOf(h, room)).toBe("analyzed");
    expect(h.runtime.offers.analysisJob(room)?.wordsChanged).toBe(false);
    expect(h.batch.submissions.flat()).toHaveLength(2);
    expect(billedBatchAnswers(h)).toBe(2);
  });

  it("moves a waiting escalation with the first pass the new Offer takes over", async () => {
    const { h, room } = await mergedRoomInBatch([doubtful, anmeldungOk]);
    await endBatch(h);
    expect(h.runtime.offers.analysisJob(room)?.escalation).not.toBe(null);
    expect(waiting(h)).toMatchObject([{ offerId: room, stage: 2, state: "submitted" }]);

    const made = await split(h, room, TAKEN.adId);

    expect(h.runtime.offers.analysisJob(made)?.escalation).not.toBe(null);
    expect(waiting(h)).toMatchObject([{ offerId: made, stage: 2, state: "submitted" }]);
    await settle(h);
    expect(h.batch.submissions.flat().filter(isEscalation)).toHaveLength(1);
    expect((await offerOf(h, made)).analysis.escalated).toBe(true);
  });

  it("leaves a request for words the leaving Ad ID does not have", async () => {
    const { h, room } = await mergedRoomInBatch();

    const made = await split(h, room, KEPT.adId);

    expect(waiting(h)).toMatchObject([{ offerId: room, stage: 1, state: "submitted" }]);
    expect(await statusOf(h, made)).not.toBe("in-batch");
  });

  it("leaves the request when the Offer left behind still shows the same words", async () => {
    const h = boot();
    const words = { title: "Zimmer in Mitte", text: `${ROOM_TEXT} ${QUOTED}` };
    ingestStored(h, { adId: 9000001, ...words }, { adId: 9000002, ...words });
    const room = await idOf(h, 9000001);
    await change(h, { batchOnly: true });
    await setKey(h);
    await h.runtime.analysis.idle();
    expect(waiting(h)).toMatchObject([{ offerId: room, state: "submitted" }]);

    await split(h, room, 9000002);

    expect(waiting(h)).toMatchObject([{ offerId: room, state: "submitted" }]);
  });
});

function orders<T>(events: T[]): T[][] {
  if (events.length <= 1) return [events];
  return events.flatMap((event, index) =>
    orders([...events.slice(0, index), ...events.slice(index + 1)]).map((rest) => [event, ...rest]),
  );
}

describe("three Offers a batch each reads the same words for, two merged into the first", () => {
  const isEscalation = (request: BatchRequest) => request.request.effort === "high";
  const EVENTS = ["batch-1", "batch-2", "batch-3", "merge second", "merge third"] as const;
  const absorbedFirst = (order: readonly string[], batch: string, merged: string) =>
    order.indexOf(merged) < order.indexOf(batch);

  /**
   * What each order gives without any request carried over: an answer counts only when its Offer
   * still exists. The first Offer's first pass always asks for an escalation.
   */
  async function outcomeOf(order: readonly (typeof EVENTS)[number][], others: "doubtful" | "sure") {
    const { h, ids } = await sameWords(
      3,
      (_call, request) => {
        if (isEscalation(request)) return anmeldungOk;
        return others === "doubtful" || request.customId.startsWith("b1-") ? doubtful : anmeldungOk;
      },
      1,
    );
    const [first, second, third] = ids as [number, number, number];
    const ended = new Set<string>();
    const end = async (id: string) => {
      ended.add(id);
      h.batch.complete(id);
      await poll(h);
    };
    let escalated = false;
    let lost = false;
    for (const event of order) {
      if (event === "merge second") await merge(h, first, second);
      else if (event === "merge third") await merge(h, first, third);
      else await end(event);
      for (const id of h.batch.batchIds().slice(3)) if (!ended.has(id)) await end(id);
      const now = (await offerOf(h, first)).analysis?.escalated === true;
      lost ||= escalated && !now;
      escalated ||= now;
    }
    const answers = h.batch.submissions.flat();
    const outcome = {
      escalated: (await offerOf(h, first)).analysis?.escalated === true,
      lost,
      escalations: answers.filter(isEscalation).length,
      waiting: waiting(h).length,
      unbilled: answers.length - billedBatchAnswers(h),
    };
    h.runtime.close();
    return outcome;
  }

  it("escalates no more than without the merge, whenever the answers come", async () => {
    const wrong: unknown[] = [];
    for (const order of orders([...EVENTS])) {
      const early = (
        [
          ["batch-2", "merge second"],
          ["batch-3", "merge third"],
        ] as const
      ).filter(([batch, merged]) => !absorbedFirst(order, batch, merged));
      // Merged in before the survivor's own first pass answers, an Offer that already read the
      // words to the end withdraws that pass, and the escalation it would ask for.
      const ownFirstPass = early.every(([, merged]) => !absorbedFirst(order, "batch-1", merged));
      const wanted = {
        escalated: true,
        lost: false,
        escalations: early.length + (ownFirstPass ? 1 : 0),
        waiting: 0,
        unbilled: 0,
      };
      const outcome = await outcomeOf(order, "doubtful");
      if (JSON.stringify(outcome) !== JSON.stringify(wanted)) wrong.push({ order, outcome });
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  it("keeps the escalated result when the absorbed Offers' answers come late and are sure", async () => {
    const wrong: unknown[] = [];
    const lateAnswers = orders([...EVENTS]).filter(
      (order) =>
        absorbedFirst(order, "batch-2", "merge second") &&
        absorbedFirst(order, "batch-3", "merge third"),
    );
    expect(lateAnswers).toHaveLength(30);
    for (const order of lateAnswers) {
      const outcome = await outcomeOf(order, "sure");
      const wanted = { escalated: true, lost: false, escalations: 1, waiting: 0, unbilled: 0 };
      if (JSON.stringify(outcome) !== JSON.stringify(wanted)) wrong.push({ order, outcome });
    }
    expect(wrong).toEqual([]);
  }, 120_000);
});

describe("a merge while a batch reads words the survivor does not show", () => {
  it("leaves the survivor free to be read on a click", async () => {
    const h = boot();
    await setKey(h);
    await change(h, { batchOnly: true });
    ingestStored(h, TAKEN);
    await h.runtime.analysis.idle();
    // Fetched later, so its page stays the merged Offer's.
    h.clock.now += MINUTE;
    await change(h, { batchOnly: false });
    ingestStored(h, KEPT);
    await h.runtime.analysis.idle();
    const [kept, taken] = [await idOf(h, KEPT.adId), await idOf(h, TAKEN.adId)];
    expect(waiting(h)).toMatchObject([{ offerId: taken, state: "submitted" }]);
    expect(h.requests).toHaveLength(1);

    await merge(h, kept, taken);

    expect(await statusOf(h, kept)).toBe("analyzed");
    await click(h, kept);
    await h.runtime.analysis.idle();
    expect(h.requests).toHaveLength(2);
  });
});

describe("the waiting requests a survivor takes over", () => {
  function twoOffers() {
    const h = boot();
    ingestStored(h, KEPT, TAKEN);
    const { db } = h.runtime;
    const [kept, taken] = db.select({ id: offers.id }).from(offers).all();
    if (kept === undefined || taken === undefined) throw new Error("expected two Offers");
    const add = (offerId: number, item: Partial<typeof analysisItems.$inferInsert>) =>
      db
        .insert(analysisItems)
        .values({
          offerId,
          stage: 1,
          state: "queued",
          contentHash: "shown",
          plan: "{}",
          createdAt: new Date(h.clock.now),
          ...item,
        })
        .returning()
        .get().id;
    const carry = (
      words: string | null = "shown",
      keep: Parameters<typeof carryWaiting>[4] = { survivor: true, absorbed: true },
    ) => db.$client.transaction(() => carryWaiting(db, taken.id, kept.id, words, keep))();
    const left = () =>
      db
        .select()
        .from(analysisItems)
        .all()
        .map((item) => ({ id: item.id, offerId: item.offerId }));
    return { kept: kept.id, taken: taken.id, add, carry, left };
  }

  it("keeps the request that was sent over a queued one for the same words", () => {
    const { kept, taken, add, carry, left } = twoOffers();
    add(kept, {});
    const sent = add(taken, { state: "submitted" });

    carry();

    expect(left()).toEqual([{ id: sent, offerId: kept }]);
  });

  it("keeps an escalation over a first pass for the same words, and one of two sent", () => {
    const { kept, taken, add, carry, left } = twoOffers();
    add(kept, { state: "submitted" });
    add(taken, { state: "submitted" });
    const escalation = add(taken, { stage: 2 });

    carry();

    expect(left()).toEqual([{ id: escalation, offerId: kept }]);
  });

  it("leaves a request for words the merged Offer does not show, and a settled one, behind", () => {
    const { kept, taken, add, carry, left } = twoOffers();
    const otherWords = add(taken, { state: "submitted", contentHash: "not shown" });
    const settled = add(taken, { state: "applied" });
    const mine = add(kept, { contentHash: "mine" });

    carry();

    expect(left()).toEqual([
      { id: otherWords, offerId: taken },
      { id: settled, offerId: taken },
      { id: mine, offerId: kept },
    ]);
  });

  it("takes every waiting request when the merged Offer's words have no hash yet", () => {
    const { kept, taken, add, carry, left } = twoOffers();
    const one = add(taken, { contentHash: "one" });
    const other = add(taken, { state: "submitted", contentHash: "other" });

    carry(null);

    expect(left()).toEqual([one, other].map((id) => ({ id, offerId: kept })));
  });

  it("withdraws the survivor's requests for the words it has no use for, sent or not", () => {
    const { kept, taken, add, carry, left } = twoOffers();
    add(kept, { state: "submitted" });
    add(kept, { stage: 2 });
    const otherWords = add(kept, { contentHash: "not shown" });
    const absorbed = add(taken, { state: "submitted" });

    carry("shown", { survivor: false, absorbed: true });

    expect(left()).toEqual([
      { id: otherWords, offerId: kept },
      { id: absorbed, offerId: kept },
    ]);
  });

  it("leaves the absorbed Offer's requests behind when it has no use for them", () => {
    const { kept, taken, add, carry, left } = twoOffers();
    const mine = add(kept, {});
    const theirs = add(taken, { state: "submitted", stage: 2 });

    carry("shown", { survivor: true, absorbed: false });

    expect(left()).toEqual([
      { id: mine, offerId: kept },
      { id: theirs, offerId: taken },
    ]);
  });

  it("keeps neither side's requests for the words when it has a use for neither", () => {
    const { kept, taken, add, carry, left } = twoOffers();
    add(kept, { state: "submitted" });
    const theirs = add(taken, {});

    carry("shown", { survivor: false, absorbed: false });

    expect(left()).toEqual([{ id: theirs, offerId: taken }]);
  });
});
