import type { AnalysisProvider } from "@wg-hunt/core";
import { fakeBatchProvider, fakeProvider } from "@wg-hunt/core/analysis/testing";
import { describe, expect, it } from "vitest";
import { carryWaiting } from "../src/analysis/batch-state.js";
import { analysisItems, analysisRuns, offers } from "../src/db/schema.js";
import {
  anmeldungOk,
  type Boot,
  boot,
  change,
  doubtful,
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
          contentHash: "same-words",
          plan: "{}",
          createdAt: new Date(h.clock.now),
          ...item,
        })
        .returning()
        .get().id;
    const carry = () => db.$client.transaction(() => carryWaiting(db, taken.id, kept.id))();
    const left = () =>
      db
        .select()
        .from(analysisItems)
        .all()
        .map((item) => ({ id: item.id, offerId: item.offerId }));
    return { h, kept: kept.id, taken: taken.id, add, carry, left };
  }

  it("drops a queued request for words another of its requests already carries", () => {
    const { kept, taken, add, carry, left } = twoOffers();
    const mine = add(kept, {});
    add(taken, {});
    const otherWords = add(taken, { contentHash: "other-words" });
    const escalation = add(taken, { stage: 2 });

    carry();

    expect(left()).toEqual([mine, otherWords, escalation].map((id) => ({ id, offerId: kept })));
  });

  it("keeps the request that was sent over its queued twin", () => {
    const { kept, taken, add, carry, left } = twoOffers();
    add(kept, {});
    const sent = add(taken, { state: "submitted" });

    carry();

    expect(left()).toEqual([{ id: sent, offerId: kept }]);
  });

  it("keeps a run's queued request, which the run still counts", () => {
    const { h, kept, taken, add, carry, left } = twoOffers();
    const runId = h.runtime.db
      .insert(analysisRuns)
      .values({
        createdAt: new Date(h.clock.now),
        analysisVersion: "v",
        estimatedCostMicros: 0,
        offerCount: 1,
      })
      .returning()
      .get().id;
    const mine = add(kept, { state: "submitted" });
    const inRun = add(taken, { runId });

    carry();

    expect(left()).toEqual([mine, inRun].map((id) => ({ id, offerId: kept })));
  });

  it("leaves requests that are no longer waiting to go with the absorbed Offer", () => {
    const { kept, taken, add, carry, left } = twoOffers();
    add(taken, { state: "applied" });
    const mine = add(kept, {});

    carry();

    expect(left().filter((item) => item.offerId === kept)).toEqual([{ id: mine, offerId: kept }]);
  });
});
