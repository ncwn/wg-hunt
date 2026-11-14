import { PAGE_FAILURE_KINDS, ProviderError } from "@wg-hunt/core";
import { describe, expect, it, vi } from "vitest";
import { type AnalysisStatusInput, deriveAnalysisStatus } from "../src/analysis/status.js";
import {
  anmeldungOk,
  boot,
  change,
  crawlOffers,
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
import { adapterFixture } from "./fixtures/search-pages.js";

const progressOf = (h: ReturnType<typeof boot>, offerId: number) =>
  h.events
    .filter((event) => event.type === "analysis-progress" && event.data.offerId === offerId)
    .map((event) => (event.data as { status: { status: string } }).status.status);

describe("an Offer's analysis status", () => {
  it("says a refused key is refused, on the Offer and in GET /analysis, until another key is saved", async () => {
    let refuse = true;
    const h = boot({ script: () => (refuse ? new ProviderError("unauthorized") : anmeldungOk) });
    await setKey(h);

    const offers = await crawlOffers(h, 2);

    const now = await status(h);
    expect(now).toMatchObject({ key: "refused", awaiting: 0 });
    expect(now.byStatus["key-refused"]).toBe(2);
    for (const offer of offers) {
      expect((await offerOf(h, offer.id)).analysisStatus).toMatchObject({
        status: "key-refused",
        next: "replace-key",
        willRead: false,
      });
    }

    refuse = false;
    expect(
      (await h.call("PUT", "/secrets/anthropic", { value: `${KEY}-replaced-0123` })).status,
    ).toBe(200);
    expect((await status(h)).key).toBe("present");
    h.runtime.analysis.sweep();
    await h.runtime.analysis.idle();
    expect((await status(h)).byStatus.analyzed).toBe(2);
  });

  it("waits for a click after a refusal, which trying again would only repeat", async () => {
    const h = boot({ script: [new ProviderError("refused")] });
    await setKey(h);
    const [offer] = await crawlOffers(h, 1);

    expect((await offerOf(h, offer?.id as number)).analysisStatus).toEqual({
      status: "needs-click",
      next: "reanalyze",
      reason: "refused",
      at: null,
      willRead: false,
    });
    expect((await status(h)).awaiting).toBe(0);
  });

  it("keeps the previous result after a failed Re-analyse, and says so", async () => {
    const h = boot({ script: (call) => (call === 0 ? anmeldungOk : new ProviderError("refused")) });
    await setKey(h);
    const [offer] = await crawlOffers(h, 1);
    const id = offer?.id as number;

    await h.json("POST", `/offers/${id}/reanalyze`);
    await h.runtime.analysis.idle();

    const body = await offerOf(h, id);
    expect(body.analysisState).toBe("analyzed");
    expect(body.analysisStatus).toMatchObject({
      status: "kept-previous",
      next: "reanalyze",
      reason: "refused",
    });
  });

  it("shows a request in a batch from when it was queued, and announces each step on /events", async () => {
    const h = boot();
    await setKey(h);
    await change(h, { batchOnly: true });
    const start = h.clock.now;
    const [offer] = await crawlOffers(h, 1);
    const id = offer?.id as number;

    const held = (await offerOf(h, id)).analysisStatus;
    expect(held).toMatchObject({ status: "in-batch", next: "wait", reason: null, willRead: true });
    expect(Date.parse(held.at)).toBeGreaterThanOrEqual(start);
    expect(Date.parse(held.at)).toBeLessThanOrEqual(h.clock.now);
    expect((await status(h)).awaiting).toBe(1);

    await poll(h);
    h.batch.complete();
    await poll(h);

    expect((await offerOf(h, id)).analysisStatus.status).toBe("analyzed");
    expect(progressOf(h, id)).toEqual(["in-batch", "analyzed"]);
  });

  it("announces a batch failure, which used to change the Offer silently", async () => {
    const h = boot({ batchScript: [new ProviderError("overloaded")] });
    await setKey(h);
    await change(h, { batchOnly: true });
    const [offer] = await crawlOffers(h, 1);
    const id = offer?.id as number;

    await poll(h);
    h.batch.complete();
    await poll(h);

    expect((await offerOf(h, id)).analysisStatus).toMatchObject({
      status: "retry-at",
      reason: "overloaded",
    });
    expect(progressOf(h, id)).toEqual(["in-batch", "retry-at"]);
  });

  it("tells a first pass waiting for its escalation from one whose escalation was lost", async () => {
    // Refused: trying the escalation again would only be refused again.
    const h = boot({ script: [doubtful], batchScript: [new ProviderError("refused")] });
    await setKey(h);
    const [offer] = await crawlOffers(h, 1);
    const id = offer?.id as number;

    const waiting = await offerOf(h, id);
    expect(waiting.analysisState).toBe("analyzed");
    expect(waiting.analysisStatus).toMatchObject({ status: "provisional", willRead: true });

    await poll(h);
    h.batch.complete();
    await poll(h);

    expect((await offerOf(h, id)).analysisStatus).toMatchObject({
      status: "escalation-lost",
      next: "reanalyze",
      reason: "refused",
      willRead: false,
    });
  });

  it("shows a Re-analyse click the cap stopped as waiting for the cap until it is read", async () => {
    // Read once, then the cap stops the click after its 202.
    const h = boot({
      script: [anmeldungOk, new ProviderError("spend_cap_reached"), anmeldungOk],
    });
    await setKey(h);
    const [offer] = await crawlOffers(h, 1);
    const id = offer?.id as number;

    expect((await h.call("POST", `/offers/${id}/reanalyze`)).status).toBe(202);
    await h.runtime.analysis.idle();
    expect(h.requests).toHaveLength(2);

    expect((await offerOf(h, id)).analysisStatus).toMatchObject({
      status: "waiting-for-cap",
      next: "raise-cap",
      willRead: false,
    });
    expect((await status(h)).awaiting).toBe(0);

    h.clock.now += 5 * MINUTE;
    h.runtime.analysis.sweep();
    await h.runtime.analysis.idle();
    expect(h.requests).toHaveLength(3);
    expect((await offerOf(h, id)).analysisStatus.status).toBe("analyzed");
  });

  it("announces a served Re-analyse click with its outcome, not as still queued", async () => {
    for (const [answer, outcome] of [
      [anmeldungOk, "analyzed"],
      [new ProviderError("refused"), "kept-previous"],
    ] as const) {
      const h = boot({ script: [anmeldungOk, answer] });
      await setKey(h);
      const [offer] = await crawlOffers(h, 1);
      const id = offer?.id as number;

      expect((await h.call("POST", `/offers/${id}/reanalyze`)).status).toBe(202);
      await h.runtime.analysis.idle();

      const last = h.events
        .filter((event) => event.type === "analysis-progress" && event.data.offerId === id)
        .at(-1);
      expect(last?.data).toMatchObject({ status: { status: outcome }, awaiting: 0 });
    }
  });

  it("stops showing a read whose start could not be announced, and reads it at the next cycle", async () => {
    const h = boot();
    await setKey(h);
    const [offer] = await crawlOffers(h, 1);
    const id = offer?.id as number;
    const { events } = h.runtime;
    const publish = events.publish;
    let broken = true;
    events.publish = (type, data) => {
      const reading =
        type === "analysis-progress" &&
        (data as { status: { status: string } }).status.status === "reading";
      if (broken && reading) {
        broken = false;
        throw new Error("synthetic: the announcement failed");
      }
      publish(type, data);
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    expect((await h.call("POST", `/offers/${id}/reanalyze`)).status).toBe(202);
    await h.runtime.analysis.idle();
    log.mockRestore();

    expect(broken).toBe(false);
    expect(h.requests).toHaveLength(1);
    expect((await offerOf(h, id)).analysisStatus).toMatchObject({
      status: "queued",
      willRead: true,
    });

    h.runtime.analysis.sweep();
    await h.runtime.analysis.idle();
    expect(h.requests).toHaveLength(2);
    expect((await offerOf(h, id)).analysisStatus.status).toBe("analyzed");
  });

  it("calls a Stale Offer stale and never counts it as read", async () => {
    const h = boot();
    await setKey(h);
    h.site.pages.set(9000001, adapterFixture("deactivated"));
    h.site.cards = h.freshCards([9000001]);
    await h.addSearch();
    await h.crawl();
    await h.runtime.analysis.idle();
    const list = await h.json("GET", "/offers?includeHidden=true");

    expect(list.body.items[0].analysisStatus).toMatchObject({ status: "stale", next: "none" });
    expect((await status(h)).byStatus.stale).toBe(1);
  });

  it("announces the reset when the Advertiser changed the words, though no call follows", async () => {
    const h = boot();
    await setKey(h);
    const [offer] = await crawlOffers(h, 1);
    const id = offer?.id as number;
    expect((await h.call("DELETE", "/secrets/anthropic")).status).toBe(204);
    const before = h.events.length;
    const calls = h.requests.length;

    recheck(h, editedPage());
    h.runtime.analysis.sweep();
    await h.runtime.analysis.idle();

    const progress = h.events
      .slice(before)
      .filter((event) => event.type === "analysis-progress" && event.data.offerId === id);
    expect(progress.map((event) => event.data)).toEqual([
      expect.objectContaining({ analysisState: "pending" }),
    ]);
    expect(h.requests.length).toBe(calls);
  });
});

describe("deriveAnalysisStatus", () => {
  const base: AnalysisStatusInput = {
    state: "pending",
    stale: false,
    wordsChanged: false,
    olderVersion: false,
    provisional: false,
    escalationResends: 0,
    failure: null,
    contentHash: "h1",
    held: null,
    reading: false,
    unstored: false,
    owed: false,
    noRoom: false,
    key: "present",
    cap: { state: "ok", resetsAt: "2026-11-30T23:00:00.000Z", fitsRun: true },
    now: Date.parse("2026-11-09T12:00:00Z"),
  };
  const at = (over: Partial<AnalysisStatusInput>) => deriveAnalysisStatus({ ...base, ...over });
  const failure = (kind: string, attempts = 1) => ({
    kind,
    at: base.now - MINUTE,
    attempts,
    contentHash: "h1",
  });

  it("names each meaning `pending` used to hide", () => {
    expect(at({}).status).toBe("queued");
    expect(at({ key: "absent" }).status).toBe("waiting-for-key");
    expect(at({ key: "refused" }).status).toBe("key-refused");
    expect(
      at({ cap: { state: "reached", resetsAt: "2026-11-30T23:00:00.000Z", fitsRun: false } }),
    ).toMatchObject({
      status: "waiting-for-cap",
      at: "2026-11-30T23:00:00.000Z",
    });
    expect(at({ stale: true }).status).toBe("stale");
  });

  it("says whether a failure retries at a known time or needs a click", () => {
    expect(at({ state: "failed", failure: failure("overloaded") })).toMatchObject({
      status: "retry-at",
      at: new Date(base.now - MINUTE + 10 * MINUTE).toISOString(),
    });
    expect(at({ state: "failed", failure: failure("overloaded", 5) }).status).toBe("needs-click");
    expect(at({ state: "failed", failure: failure("truncated") }).status).toBe("needs-click");
    expect(at({ state: "failed", failure: failure("no_stored_page") })).toMatchObject({
      status: "waiting-for-page",
      next: "recheck",
    });
    expect(at({ state: "failed", failure: failure("truncated"), contentHash: "h2" }).status).toBe(
      "queued",
    );
    const over = { ...failure("overloaded"), at: base.now - 60 * MINUTE };
    expect(
      at({
        state: "failed",
        failure: over,
        cap: { state: "reached", resetsAt: null, fitsRun: false },
      }).status,
    ).toBe("waiting-for-cap");
  });

  it("names what `analyzed` used to hide, and keeps the two outdateds apart", () => {
    expect(at({ state: "analyzed" }).status).toBe("analyzed");
    expect(at({ state: "analyzed", wordsChanged: true }).status).toBe("words-changed");
    expect(at({ state: "analyzed", olderVersion: true }).status).toBe("older-version");
    expect(at({ state: "analyzed", failure: failure("overloaded") }).status).toBe("kept-previous");
    expect(at({ state: "analyzed", provisional: true }).status).toBe("provisional");
    expect(at({ state: "analyzed", provisional: true, failure: failure("refused") })).toMatchObject(
      { status: "escalation-lost", reason: "refused" },
    );
    // Re-sent as often as the sweep may, with no failure left on the Offer (it failed before
    // anything was sent, or the cap kept stopping it): lost too, not waiting for the next cycle.
    expect(at({ state: "analyzed", provisional: true, escalationResends: 5 })).toMatchObject({
      status: "escalation-lost",
      next: "reanalyze",
      reason: null,
    });
    expect(at({ state: "analyzed", provisional: true, escalationResends: 4 }).status).toBe(
      "provisional",
    );
    expect(
      at({
        state: "analyzed",
        provisional: true,
        held: { stage: 2, since: new Date(base.now) },
      }).status,
    ).toBe("provisional");
  });

  it.each(PAGE_FAILURE_KINDS)(
    "points a kept result and a lost escalation at Recheck after %s, which a click would only repeat",
    (kind) => {
      const kept = { state: "analyzed" as const, failure: failure(kind) };
      expect(at(kept)).toEqual({
        status: "kept-previous",
        next: "recheck",
        reason: kind,
        at: null,
        willRead: false,
      });
      // Its escalation was sent again as often as the sweep may, and failed on the page each time.
      const lost = { ...kept, provisional: true, escalationResends: 5 };
      expect(at(lost)).toEqual({
        status: "escalation-lost",
        next: "recheck",
        reason: kind,
        at: null,
        willRead: false,
      });
      for (const status of [kept, lost]) {
        expect(at({ ...status, key: "absent" }).next).toBe("recheck");
        expect(at({ ...status, key: "refused" }).next).toBe("recheck");
        expect(
          at({ ...status, cap: { state: "reached", resetsAt: null, fitsRun: false } }).next,
        ).toBe("recheck");
      }
      expect(at({ state: "failed", failure: failure(kind) })).toMatchObject({
        status: "waiting-for-page",
        next: "recheck",
        reason: kind,
      });
    },
  );

  it("says an owed escalation no batch holds waits for the cap or the key, not that it is read", () => {
    const owed = { state: "analyzed" as const, provisional: true };
    expect(
      at({
        ...owed,
        cap: { state: "reached", resetsAt: "2026-11-30T23:00:00.000Z", fitsRun: false },
      }),
    ).toEqual({
      status: "waiting-for-cap",
      next: "raise-cap",
      reason: null,
      at: "2026-11-30T23:00:00.000Z",
      willRead: false,
    });
    expect(at({ ...owed, key: "absent" })).toMatchObject({
      status: "waiting-for-key",
      willRead: false,
    });
    expect(at({ ...owed, key: "refused" })).toMatchObject({
      status: "key-refused",
      willRead: false,
    });
    expect(at({ ...owed, failure: failure("overloaded") })).toMatchObject({
      status: "retry-at",
      reason: "overloaded",
      willRead: false,
    });
    expect(
      at({
        ...owed,
        held: { stage: 2, since: new Date(base.now) },
        cap: { state: "reached", resetsAt: null, fitsRun: false },
      }).status,
    ).toBe("provisional");
  });

  it("puts a call in flight and a batch ahead of what blocks new calls", () => {
    expect(at({ reading: true, key: "refused" }).status).toBe("reading");
    expect(
      at({
        held: { stage: 1, since: new Date(base.now) },
        cap: { state: "reached", resetsAt: null, fitsRun: false },
      }).status,
    ).toBe("in-batch");
  });

  it("says a request a batch holds waits for the key once the key is gone or refused", () => {
    const held = { held: { stage: 1 as const, since: new Date(base.now) } };
    expect(at({ ...held, key: "absent" })).toMatchObject({
      status: "waiting-for-key",
      next: "add-key",
      willRead: false,
    });
    const owed = { state: "analyzed" as const, provisional: true };
    expect(
      at({ ...owed, held: { stage: 2, since: new Date(base.now) }, key: "refused" }),
    ).toMatchObject({ status: "key-refused", next: "replace-key", willRead: false });
  });

  it("tells waiting for what is in flight from a reached cap", () => {
    expect(
      at({ cap: { state: "waiting-for-in-flight", resetsAt: base.cap.resetsAt, fitsRun: false } }),
    ).toEqual({
      status: "waiting-for-in-flight",
      next: "wait",
      reason: null,
      at: null,
      willRead: true,
    });
    const owed = { state: "analyzed" as const, provisional: true };
    expect(
      at({ ...owed, cap: { state: "waiting-for-in-flight", resetsAt: null, fitsRun: false } })
        .status,
    ).toBe("waiting-for-in-flight");
  });

  it("says an owed Re-analyse click is queued, whatever the Offer's state, unless the key or the cap stops it", () => {
    const owed = { owed: true };
    for (const state of [
      { state: "analyzed" as const },
      { state: "analyzed" as const, olderVersion: true },
      { state: "analyzed" as const, failure: failure("refused") },
      { state: "analyzed" as const, provisional: true, escalationResends: 5 },
      { state: "failed" as const, failure: failure("truncated") },
      { state: "failed" as const, failure: failure("overloaded") },
    ]) {
      expect(at({ ...state, ...owed })).toEqual({
        status: "queued",
        next: "wait",
        reason: null,
        at: null,
        willRead: true,
      });
    }
    const analyzed = { state: "analyzed" as const, ...owed };
    expect(at({ ...analyzed, key: "absent" }).status).toBe("waiting-for-key");
    expect(at({ ...analyzed, key: "refused" }).status).toBe("key-refused");
    expect(
      at({ ...analyzed, cap: { state: "reached", resetsAt: base.cap.resetsAt, fitsRun: false } }),
    ).toMatchObject({ status: "waiting-for-cap", at: base.cap.resetsAt });
    expect(
      at({ ...analyzed, cap: { state: "waiting-for-in-flight", resetsAt: null, fitsRun: false } })
        .status,
    ).toBe("waiting-for-in-flight");
    expect(at({ ...analyzed, reading: true }).status).toBe("reading");
    expect(at({ ...analyzed, stale: true }).status).toBe("stale");
    expect(at({ ...analyzed, held: { stage: 1, since: new Date(base.now) } }).status).toBe(
      "in-batch",
    );
  });

  it("says an Offer whose own call the cap cannot pay for waits for the cap, as a reached cap does", () => {
    const reached = {
      cap: { state: "reached" as const, resetsAt: base.cap.resetsAt, fitsRun: false },
    };
    const noRoom = { noRoom: true };
    for (const state of [
      {},
      {
        state: "failed" as const,
        failure: { ...failure("overloaded"), at: base.now - 60 * MINUTE },
      },
      { state: "analyzed" as const, owed: true },
      { state: "analyzed" as const, olderVersion: true, owed: true },
      { state: "analyzed" as const, failure: failure("refused"), owed: true },
      { state: "analyzed" as const, provisional: true, escalationResends: 5, owed: true },
      { state: "failed" as const, failure: failure("truncated"), owed: true },
      { state: "analyzed" as const, provisional: true },
    ]) {
      expect(at({ ...state, ...noRoom })).toEqual(at({ ...state, ...reached }));
      expect(at({ ...state, ...noRoom })).toMatchObject({
        status: "waiting-for-cap",
        next: "raise-cap",
        at: base.cap.resetsAt,
        willRead: false,
      });
    }
    const owed = { state: "analyzed" as const, owed: true, ...noRoom };
    expect(at({ ...owed, key: "absent" }).status).toBe("waiting-for-key");
    expect(at({ ...owed, key: "refused" }).status).toBe("key-refused");
    expect(at({ ...owed, reading: true }).status).toBe("reading");
    expect(at({ ...owed, stale: true }).status).toBe("stale");
    expect(at({ ...owed, held: { stage: 1, since: new Date(base.now) } }).status).toBe("in-batch");
    expect(
      at({
        ...owed,
        cap: { state: "waiting-for-in-flight", resetsAt: base.cap.resetsAt, fitsRun: false },
      }).status,
    ).toBe("waiting-for-in-flight");
    expect(at({ state: "failed", failure: failure("overloaded"), ...noRoom }).status).toBe(
      "retry-at",
    );
    expect(at({ state: "analyzed", ...noRoom }).status).toBe("analyzed");
  });

  it("says a call whose outcome was not stored waits for a click, whatever else the Offer is owed", () => {
    const unstored = { unstored: true };
    const lost = { reason: "outcome_not_stored", next: "reanalyze", at: null, willRead: false };
    for (const state of [
      {},
      { owed: true },
      { noRoom: true },
      { state: "failed" as const, failure: failure("overloaded") },
      { state: "failed" as const, failure: failure("truncated"), owed: true },
    ]) {
      expect(at({ ...state, ...unstored })).toEqual({ status: "needs-click", ...lost });
    }
    for (const state of [
      { state: "analyzed" as const, owed: true },
      { state: "analyzed" as const, owed: true, olderVersion: true },
      { state: "analyzed" as const, owed: true, failure: failure("refused") },
      { state: "analyzed" as const, owed: true, provisional: true },
    ]) {
      expect(at({ ...state, ...unstored })).toEqual({ status: "kept-previous", ...lost });
    }

    expect(at({ ...unstored, key: "absent" })).toMatchObject({
      status: "needs-click",
      next: "add-key",
    });
    expect(at({ ...unstored, key: "refused" }).next).toBe("replace-key");
    expect(
      at({ ...unstored, cap: { state: "reached", resetsAt: base.cap.resetsAt, fitsRun: false } }),
    ).toMatchObject({ status: "needs-click", next: "raise-cap", at: base.cap.resetsAt });
    expect(at({ ...unstored, stale: true }).status).toBe("stale");
    expect(at({ ...unstored, held: { stage: 1, since: new Date(base.now) } }).status).toBe(
      "in-batch",
    );
  });

  it("says what a click or a run waits for when the key or the cap would refuse it now", () => {
    const kept = { state: "analyzed" as const, failure: failure("refused") };
    const lost = { state: "analyzed" as const, provisional: true, failure: failure("refused") };
    const older = { state: "analyzed" as const, olderVersion: true };
    const click = { state: "failed" as const, failure: failure("truncated") };
    const reached = {
      cap: { state: "reached" as const, resetsAt: base.cap.resetsAt, fitsRun: false },
    };
    const inFlight = {
      cap: { state: "waiting-for-in-flight" as const, resetsAt: null, fitsRun: false },
    };

    expect(at(kept).next).toBe("reanalyze");
    expect(at(older).next).toBe("start-run");

    expect(at({ ...kept, key: "absent" })).toMatchObject({
      status: "kept-previous",
      next: "add-key",
    });
    expect(at({ ...lost, key: "refused" })).toMatchObject({
      status: "escalation-lost",
      next: "replace-key",
    });
    expect(at({ ...older, key: "absent" })).toMatchObject({
      status: "older-version",
      next: "add-key",
    });
    for (const status of [kept, lost, older, click]) {
      expect(at({ ...status, ...reached })).toMatchObject({
        next: "raise-cap",
        at: base.cap.resetsAt,
        willRead: false,
      });
      expect(at({ ...status, ...inFlight })).toMatchObject({ next: "raise-cap", at: null });
    }
  });
});

describe("an Offer a batch holds after the key is deleted", () => {
  it("is not counted as being read, and says it waits for a key", async () => {
    const h = boot();
    await setKey(h);
    await change(h, { batchOnly: true });
    const [offer] = await crawlOffers(h, 1);
    const id = offer?.id as number;
    await poll(h);
    expect((await status(h)).awaiting).toBe(1);

    expect((await h.call("DELETE", "/secrets/anthropic")).status).toBeLessThan(300);

    expect((await offerOf(h, id)).analysisStatus).toMatchObject({
      status: "waiting-for-key",
      willRead: false,
    });
    expect((await status(h)).awaiting).toBe(0);
  });
});
