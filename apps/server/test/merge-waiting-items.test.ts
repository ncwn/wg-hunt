import type { AnalysisProvider, BatchRequest } from "@wg-hunt/core";
import { fakeBatchProvider, fakeProvider } from "@wg-hunt/core/analysis/testing";
import { describe, expect, it, vi } from "vitest";
import { carryWaiting } from "../src/analysis/batch-state.js";
import { analysisItems, analysisUsage, offers } from "../src/db/schema.js";
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

/** Posted with the same words, then split: Offers a batch reads the same words for. */
async function sameWords(
  count: number,
  batchScript: BatchScript,
  size = 100,
  script?: BootOptions["script"],
) {
  const h = boot({ batchScript, size, ...(script && { script }) });
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

describe("a merge while the survivor's realtime read is out", () => {
  it("drops the answer when the absorbed Offer had already read the same words", async () => {
    const scripted = fakeProvider([anmeldungOk, doubtful]);
    let arrived = 0;
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const provider: AnalysisProvider = {
      async analyse(request) {
        if (arrived++ === 1) await gate;
        return scripted.provider.analyse(request);
      },
    };
    const h = boot({
      sameProviders: { realtime: { ...scripted, provider }, batch: fakeBatchProvider([]) },
    });
    const words = { title: "Zimmer in Mitte", text: `${ROOM_TEXT} ${QUOTED}` };
    ingestStored(h, { adId: 9000001, ...words }, { adId: 9000002, ...words });
    const room = await idOf(h, 9000001);
    const split = await h.json("POST", `/offers/${room}/split`, { adId: "9000002" });
    const reading = split.body.id as number;
    await setKey(h);
    h.runtime.analysis.sweep();
    await vi.waitFor(() => expect(arrived).toBe(2));
    const finished = (await offerOf(h, room)).analysis;
    expect(finished.analyzedAt).not.toBe(null);

    await merge(h, reading, room);
    open();
    await h.runtime.analysis.idle();

    expect(scripted.requests).toHaveLength(2);
    const end = await offerOf(h, reading);
    expect(end.analysis).toEqual(finished);
    expect(end.analysisStatus.status).toBe("analyzed");
    expect(h.runtime.db.select().from(analysisItems).all()).toEqual([]);
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
