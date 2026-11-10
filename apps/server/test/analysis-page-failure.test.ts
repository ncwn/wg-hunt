import { rmSync } from "node:fs";
import { join } from "node:path";
import { ProviderError, type SourceAdapter } from "@wg-hunt/core";
import { wgGesuchtSource } from "@wg-hunt/core/sources/wg-gesucht";
import { describe, expect, it } from "vitest";
import { createSnapshotStore } from "../src/crawl/snapshots.js";
import { createOffers } from "../src/offers/offers.js";
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
  recheck as storeFetched,
} from "./analysis-harness.js";
import { type AdSpec, adPage, fetchedAd, ROOM_TEXT } from "./dedupe-harness.js";
import { adapterFixture, offerHtml, withOwnPhotos } from "./fixtures/search-pages.js";
import type { bootOffers } from "./offers-harness.js";

const AD = 9000001;
const current = { status: "analyzed", next: "none", reason: null, at: null, willRead: false };

const losePage = (h: Boot, adId = AD) =>
  rmSync(join(h.dataDir, "offer-pages", "wg-gesucht", `${adId}.html.gz`));
const garblePage = (h: Boot) =>
  h.runtime.snapshots.write("wg-gesucht", String(AD), "<html><body><p>Wartung</p></body></html>");

const modelCalls = (h: Boot) => h.requests.length + h.batch.submissions.flat().length;

const announced = (h: Boot, offerId: number, from = 0) =>
  h.events
    .slice(from)
    .filter((event) => event.type === "analysis-progress" && event.data.offerId === offerId)
    .map((event) => (event.data as { status: { status: string } }).status.status);

async function recheck(h: Boot, offerId: number) {
  expect((await h.call("POST", `/offers/${offerId}/recheck`)).status).toBe(202);
  await h.crawl();
  await h.runtime.analysis.idle();
  expect((await offerOf(h, offerId)).recheck).toMatchObject({ state: "idle" });
}

async function sweepAt(h: Boot, at: number) {
  h.clock.now = at;
  h.runtime.analysis.sweep();
  await h.runtime.analysis.idle();
  await poll(h);
}

describe("an analyzed Offer whose stored page cannot be read", () => {
  it.each([
    ["no_stored_page", (h: Boot) => losePage(h)],
    ["unreadable_page", garblePage],
  ] as const)(
    "says Recheck after a Re-analyse failed with %s, and is current again once a Recheck stored the page",
    async (kind, spoil) => {
      const h = boot();
      await setKey(h);
      const [offer] = await crawlOffers(h, 1);
      const id = offer?.id as number;
      spoil(h);

      expect((await h.call("POST", `/offers/${id}/reanalyze`)).status).toBe(202);
      await h.runtime.analysis.idle();

      const failed = await offerOf(h, id);
      expect(failed.analysisState).toBe("analyzed");
      expect(failed.analysisStatus).toEqual({
        status: "kept-previous",
        next: "recheck",
        reason: kind,
        at: null,
        willRead: false,
      });
      expect(modelCalls(h)).toBe(1);

      const before = h.events.length;
      await recheck(h, id);

      const after = await offerOf(h, id);
      expect(after.analysisState).toBe("analyzed");
      expect(after.analysisStatus).toEqual(current);
      expect(modelCalls(h)).toBe(1);
      expect(announced(h, id, before)).toEqual(["analyzed"]);
      expect((await h.json("GET", "/analysis")).body.byStatus).toMatchObject({
        analyzed: 1,
        "kept-previous": 0,
      });
    },
  );

  it("says Recheck after a re-analysis run failed on it, and waits for a run again once the page is stored", async () => {
    const h = boot();
    await setKey(h);
    const [offer] = await crawlOffers(h, 1);
    const id = offer?.id as number;
    // Another model: the Offer is on an older analysis, which a run reads again.
    await change(h, { model: "claude-sonnet-5-5", effort: "medium" });
    losePage(h);

    const run = await h.json("POST", "/analysis/runs");
    expect(run.status).toBe(202);
    await poll(h);

    expect((await offerOf(h, id)).analysisStatus).toMatchObject({
      status: "kept-previous",
      next: "recheck",
      reason: "no_stored_page",
    });
    expect((await h.json("GET", `/analysis/runs/${run.body.id}`)).body).toMatchObject({
      status: "failed",
      counts: { failed: 1, applied: 0 },
    });

    await recheck(h, id);

    expect((await offerOf(h, id)).analysisStatus).toMatchObject({
      status: "older-version",
      next: "start-run",
      reason: null,
    });
    expect(modelCalls(h)).toBe(1);
  });

  it("keeps a failure that was not about the page when a Recheck stores the page", async () => {
    const h = boot({ script: (call) => (call === 0 ? anmeldungOk : new ProviderError("refused")) });
    await setKey(h);
    const [offer] = await crawlOffers(h, 1);
    const id = offer?.id as number;
    expect((await h.call("POST", `/offers/${id}/reanalyze`)).status).toBe(202);
    await h.runtime.analysis.idle();

    await recheck(h, id);

    expect((await offerOf(h, id)).analysisStatus).toMatchObject({
      status: "kept-previous",
      next: "reanalyze",
      reason: "refused",
    });
    expect(modelCalls(h)).toBe(2);
  });
});

describe("a re-post that becomes the current Ad ID of an Offer whose page was gone", () => {
  function ingestStored(h: Boot, spec: AdSpec, after: number) {
    h.runtime.snapshots.write("wg-gesucht", String(spec.adId), adPage(spec));
    return h.runtime.offers.ingest(fetchedAd(h as ReturnType<typeof bootOffers>, spec, after));
  }

  it("ends the page failure with its own stored page, and is not read: the words are the same", async () => {
    const h = boot();
    await setKey(h);
    // With the sentence the scripted answer quotes on the page, the first pass is final.
    const room = { title: "Helles Zimmer am Park", text: `${ROOM_TEXT} Anmeldung ist möglich.` };
    const first = ingestStored(h, { adId: AD, ...room, warmRent: 450 }, 0);
    const id = first.offerId as number;
    await h.runtime.analysis.idle();
    losePage(h);
    expect((await h.call("POST", `/offers/${id}/reanalyze`)).status).toBe(202);
    await h.runtime.analysis.idle();
    expect((await offerOf(h, id)).analysisStatus).toMatchObject({
      status: "kept-previous",
      next: "recheck",
    });

    const repost = ingestStored(h, { adId: AD + 1, ...room, warmRent: 480 }, 10 * MINUTE);
    await h.runtime.analysis.idle();

    expect(repost).toMatchObject({ outcome: "merged", offerId: id });
    expect((await offerOf(h, id)).analysisStatus).toEqual(current);
    expect(modelCalls(h)).toBe(1);
  });
});

describe("an Offer of two Ad IDs whose current one lost its page", () => {
  const failedOnPage = { status: "kept-previous", next: "recheck", reason: "no_stored_page" };

  async function roomOfTwo() {
    const h = boot();
    await setKey(h);
    const [first, second] = await crawlOffers(h, 2);
    const id = first?.id as number;
    const merged = await h.json("POST", `/offers/${id}/merge`, { offerId: second?.id });
    expect(merged.status).toBe(200);
    const ads = merged.body.ads as { adId: string; current: boolean }[];
    const lost = Number(ads.find((ad) => ad.current)?.adId);
    const other = Number(ads.find((ad) => !ad.current)?.adId);
    losePage(h, lost);
    expect((await h.call("POST", `/offers/${id}/reanalyze`)).status).toBe(202);
    await h.runtime.analysis.idle();
    expect((await offerOf(h, id)).analysisStatus).toMatchObject(failedOnPage);
    expect(modelCalls(h)).toBe(2);
    return { h, id, lost, other };
  }
  const currentAdOf = async (h: Boot, id: number) =>
    Number(
      ((await offerOf(h, id)).ads as { adId: string; current: boolean }[]).find((ad) => ad.current)
        ?.adId,
    );

  it("is current again after one Recheck that finds the Ad ID deleted and moves to the other one's stored page", async () => {
    const { h, id, lost, other } = await roomOfTwo();
    h.site.pages.set(lost, adapterFixture("deleted"));

    const before = h.events.length;
    await recheck(h, id);

    expect(await currentAdOf(h, id)).toBe(other);
    const after = await offerOf(h, id);
    expect(after.analysisStatus).toEqual(current);
    expect(announced(h, id, before)).toEqual(["analyzed"]);
    expect(modelCalls(h)).toBe(2);
  });

  it("keeps the failure when a page is stored for the Ad ID that is not the current one", async () => {
    const { h, id, lost, other } = await roomOfTwo();

    storeFetched(h, withOwnPhotos(offerHtml(), other), other);
    await h.runtime.analysis.idle();

    expect(await currentAdOf(h, id)).toBe(lost);
    const after = await offerOf(h, id);
    expect(after.analysisStatus).toMatchObject(failedOnPage);
    expect(modelCalls(h)).toBe(2);
  });

  it("ends for the Offer a split leaves on a stored page, and stays with the Ad ID whose page is gone", async () => {
    const { h, id, lost, other } = await roomOfTwo();

    const split = await h.json("POST", `/offers/${id}/split`, { adId: String(lost) });
    expect(split.status).toBe(201);
    await h.runtime.analysis.idle();

    expect(await currentAdOf(h, id)).toBe(other);
    expect((await offerOf(h, id)).analysisStatus).toEqual(current);
    expect((await offerOf(h, split.body.id)).analysisStatus).toMatchObject(failedOnPage);
    expect(modelCalls(h)).toBe(2);
  });
});

describe("a page failure carried onto an Offer whose current Ad ID has a stored page", () => {
  it("ends at the merge", async () => {
    const h = boot();
    await setKey(h);
    const [first] = await crawlOffers(h, 1);
    const id = first?.id as number;
    losePage(h);
    expect((await h.call("POST", `/offers/${id}/reanalyze`)).status).toBe(202);
    await h.runtime.analysis.idle();
    expect((await offerOf(h, id)).analysisStatus).toMatchObject({
      status: "kept-previous",
      next: "recheck",
    });
    // A newer post of the same words, crawled while no key is set: it waits, unread.
    expect((await h.call("DELETE", "/secrets/anthropic")).status).toBeLessThan(300);
    h.site.cards = [
      { id: AD, age: "3 Std.", title: `Zimmer ${AD}` },
      { id: AD + 1, age: "5 Min.", title: `Zimmer ${AD + 1}` },
    ];
    await h.crawl();
    await h.runtime.analysis.idle();
    const newer = ((await h.json("GET", "/offers")).body.items as { id: number }[]).find(
      (offer) => offer.id !== id,
    );

    const merged = await h.json("POST", `/offers/${id}/merge`, { offerId: newer?.id });

    expect(merged.status).toBe(200);
    expect(
      (merged.body.ads as { adId: string; current: boolean }[]).find((ad) => ad.current)?.adId,
    ).toBe(String(AD + 1));
    const after = await offerOf(h, id);
    expect(after.analysisState).toBe("analyzed");
    expect(after.analysisStatus).toEqual(current);
    expect(modelCalls(h)).toBe(1);
  });
});

describe("a page the rules could not read", () => {
  it("ends its page failure when newer rules read it at the re-parse", async () => {
    const h = boot();
    await setKey(h);
    const [first] = await crawlOffers(h, 1);
    const id = first?.id as number;
    // As a reading that found the stored page unreadable under the rules of its day left it.
    h.runtime.offers.failAnalysis(id, "unreadable_page");
    expect((await offerOf(h, id)).analysisStatus).toMatchObject({
      status: "kept-previous",
      next: "recheck",
      reason: "unreadable_page",
    });
    const newer: SourceAdapter = {
      ...wgGesuchtSource,
      rulesVersion: wgGesuchtSource.rulesVersion + 1,
      parseOffer(html, ctx) {
        const parsed = wgGesuchtSource.parseOffer(html, ctx);
        return parsed.outcome === "parsed" && parsed.status !== "deleted"
          ? { ...parsed, rulesVersion: wgGesuchtSource.rulesVersion + 1 }
          : parsed;
      },
    };
    const upgraded = createOffers({
      db: h.runtime.db,
      adapters: { "wg-gesucht": newer },
      snapshots: createSnapshotStore(h.dataDir),
      clock: () => h.clock.now,
    });

    expect(await upgraded.reparseOutdated()).toMatchObject({ done: 1 });

    expect((await offerOf(h, id)).analysisStatus).toEqual(current);
    expect(modelCalls(h)).toBe(1);
  });
});

describe("a first pass whose escalation was lost to a missing page", () => {
  it("says Recheck, and Re-analyse once a Recheck stored the page, without sending the escalation again", async () => {
    const h = boot({ script: [doubtful] });
    await setKey(h);
    const [offer] = await crawlOffers(h, 1);
    const id = offer?.id as number;
    losePage(h);
    await poll(h);
    h.batch.complete();
    await poll(h);
    for (let i = 0; i < 8; i++) await sweepAt(h, h.clock.now + 7 * 60 * MINUTE);

    expect((await offerOf(h, id)).analysisStatus).toEqual({
      status: "escalation-lost",
      next: "recheck",
      reason: "no_stored_page",
      at: null,
      willRead: false,
    });
    expect(modelCalls(h)).toBe(2);

    await recheck(h, id);

    expect((await offerOf(h, id)).analysisStatus).toEqual({
      status: "escalation-lost",
      next: "reanalyze",
      reason: null,
      at: null,
      willRead: false,
    });
    for (let i = 0; i < 3; i++) await sweepAt(h, h.clock.now + 7 * 60 * MINUTE);
    expect(modelCalls(h)).toBe(2);
  });
});

describe("an Offer not read yet whose stored page is gone", () => {
  it("waits for a Recheck, and for its reading like any new Offer once the page is stored", async () => {
    const h = boot();
    // No key yet: the page is stored and the Offer waits.
    const [offer] = await crawlOffers(h, 1);
    const id = offer?.id as number;
    losePage(h);
    await setKey(h);
    h.runtime.analysis.sweep();
    await h.runtime.analysis.idle();
    await poll(h);

    const waiting = await offerOf(h, id);
    expect(waiting.analysisState).toBe("failed");
    expect(waiting.analysisStatus).toMatchObject({
      status: "waiting-for-page",
      next: "recheck",
      reason: "no_stored_page",
    });
    expect(modelCalls(h)).toBe(0);

    const before = h.events.length;
    await recheck(h, id);
    await poll(h);
    h.batch.complete();
    await poll(h);

    expect(announced(h, id, before)[0]).toBe("queued");
    const read = await offerOf(h, id);
    expect(read.analysisState).toBe("analyzed");
    expect(read.analysisStatus).toEqual(current);
    expect(modelCalls(h)).toBe(1);
  });
});
