import type { AnalysisProvider } from "@wg-hunt/core";
import { fakeBatchProvider, fakeProvider, type Scripted } from "@wg-hunt/core/analysis/testing";
import { describe, expect, it } from "vitest";
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

/** Posted twice with the same words, then split: two Offers a batch reads the same words for. */
async function twins(batchScript: Scripted[], size = 100) {
  const h = boot({ batchScript, size });
  const words = { title: "Zimmer in Mitte", text: `${ROOM_TEXT} ${QUOTED}` };
  ingestStored(h, { adId: 9000001, ...words }, { adId: 9000002, ...words });
  const room = await idOf(h, 9000001);
  const split = await h.json("POST", `/offers/${room}/split`, { adId: "9000002" });
  expect(split.status).toBe(201);
  await change(h, { batchOnly: true });
  await setKey(h);
  await h.runtime.analysis.idle();
  return { h, room, other: split.body.id as number };
}

describe("a merge of two Offers a batch is reading the same words for", () => {
  it("escalates the words once, though both first passes ask for it", async () => {
    const { h, room, other } = await twins([doubtful, doubtful, anmeldungOk]);
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
  for (const [late, answer] of [
    ["is sure", anmeldungOk],
    ["asks for an escalation", doubtful],
  ] as const) {
    it(`keeps the escalated result when the other first pass ends late and ${late}`, async () => {
      const { h, room, other } = await twins([doubtful, anmeldungOk, answer, anmeldungOk], 1);
      await merge(h, room, other);
      await poll(h);
      h.batch.complete("batch-1");
      await poll(h);
      h.batch.complete("batch-3");
      await poll(h);
      expect((await offerOf(h, room)).analysis.escalated).toBe(true);

      h.batch.complete("batch-2");
      await poll(h);

      const end = await offerOf(h, room);
      expect(end.analysis.escalated).toBe(true);
      expect(end.analysisStatus.status).toBe("analyzed");
      expect(h.batch.submissions).toHaveLength(3);
      expect(waiting(h)).toEqual([]);
      // The late answer was billed all the same.
      const billed = h.runtime.db.select().from(analysisUsage).all();
      expect(billed.filter((row) => row.batch)).toHaveLength(3);
    });
  }
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
    const carry = (words: string | null = "shown") =>
      db.$client.transaction(() => carryWaiting(db, taken.id, kept.id, words))();
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
});
