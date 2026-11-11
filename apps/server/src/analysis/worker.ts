import {
  type AnalysisProvider,
  type AnalysisRequest,
  type BatchProvider,
  callWithRetry,
  contentHash,
  ERROR_KINDS,
  firstRequest,
  ProviderError,
  readFirst,
  type Source,
  type SourceAdapter,
  type StepArgs,
} from "@wg-hunt/core";
import { createAnthropicProvider } from "@wg-hunt/core/analysis/anthropic";
import { createAnthropicBatchProvider } from "@wg-hunt/core/analysis/anthropic-batch";
import { loadAnalysisSettings, readAnalysisSettings } from "../analysis-settings.js";
import type { SnapshotStore } from "../crawl/snapshots.js";
import type { Db } from "../db/index.js";
import type { EventBus } from "../events.js";
import type { AnalysisJob, IngestResult, Offers } from "../offers/offers.js";
import { readSecret } from "../secrets.js";
import { type BatchOptions, createBatchAnalysis } from "./batch.js";
import { estimateReanalysisUsd } from "./estimate.js";
import { keyReporting, keyState } from "./key.js";
import { meteredProvider } from "./metered.js";
import { createOfferReader } from "./read-offer.js";
import { type AnalysisPlan, makeRun } from "./record.js";
import { mayResendEscalation, mayRetry } from "./retry.js";
import { createSpendLedger } from "./spend.js";
import { analysisVersion } from "./version.js";

const MINUTE = 60_000;

export type AnalysisOptions = {
  providerFor?: (apiKey: string) => AnalysisProvider;
  batchProviderFor?: (apiKey: string) => BatchProvider;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  batch?: BatchOptions;
  newOfferAgeMs?: number;
};

export type Analysis = ReturnType<typeof createAnalysis>;

export type AnalysisOverview = ReturnType<Analysis["status"]>;

/**
 * Where the realtime worker has an Offer; one it holds nothing of has no entry.
 * - `queued`: in `queue`.
 * - `taken`: off the queue, and nothing has been sent for it.
 * - `reading`: its call is out.
 * - `unstored`: its call went out and its outcome could not be stored: the database took no write
 *   (a full disk). The call was billed, and no spend was recorded for the cap to hold, so this
 *   process sends it again only after a new click. A restart tries once more too.
 */
type Phase = "queued" | "taken" | "reading" | "unstored";

/**
 * The API key is read per Offer and never printed; errors reach the log and the database as a
 * kind only.
 */
export function createAnalysis(deps: {
  db: Db;
  offers: Offers;
  adapters: Record<Source, SourceAdapter>;
  snapshots: Pick<SnapshotStore, "read">;
  /** Epoch milliseconds. */
  clock: () => number;
  events: EventBus;
  options?: AnalysisOptions;
}) {
  const { db, offers, adapters, snapshots, clock, events } = deps;
  const options = deps.options ?? {};
  const providerFor = options.providerFor ?? ((apiKey) => createAnthropicProvider({ apiKey }));
  const newOfferAgeMs = options.newOfferAgeMs ?? 2 * 60 * MINUTE;

  const fresh = new Set<number>();

  const isNew = (job: Pick<AnalysisJob, "lastBumpAt">): boolean =>
    job.lastBumpAt === null || clock() - job.lastBumpAt <= newOfferAgeMs;
  const queue: number[] = [];
  const phases = new Map<number, Phase>();
  const inFlight = (id: number): boolean => {
    const phase = phases.get(id);
    return phase === "taken" || phase === "reading";
  };
  /**
   * What is left of the cap paid for neither of these Offers' calls when the worker last looked.
   * Kept only to say so: every cycle still looks again with the numbers of the moment. Beside the
   * phase, because such an Offer is queued again each cycle.
   */
  const noRoom = new Set<number>();
  let running: Promise<void> | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let provider: { apiKey: string; provider: AnalysisProvider } | undefined;

  const keyOf = () => readSecret(db, "anthropic");
  const reader = createOfferReader({ adapters, snapshots });
  const spend = createSpendLedger({ db, clock, events, onChange: () => syncStatus() });
  const batch = createBatchAnalysis({
    db,
    offers,
    reader,
    ledger: spend,
    events,
    clock,
    keyOf,
    realtimeHeld: () => [...[...phases.keys()].filter(inFlight), ...offers.owedReanalyses()],
    announce: (offerIds) => announceAll(offerIds),
    statusChanged: () => syncStatus(),
    providerFor: options.batchProviderFor ?? ((apiKey) => createAnthropicBatchProvider({ apiKey })),
    ...(options.batch && { options: options.batch }),
  });

  offers.attachAnalysis({
    reading: (offerId) => phases.get(offerId) === "reading",
    unstored: (offerId) => phases.get(offerId) === "unstored",
    cap: () => {
      const { state, resetsAt } = spend.capState();
      return { state, resetsAt };
    },
    noRoom: () => noRoom,
    announce: (offerId) => announce(offerId),
  });

  function providerOf(apiKey: string): AnalysisProvider {
    if (provider?.apiKey !== apiKey) {
      const reporting = keyReporting(providerFor(apiKey), {
        db,
        key: apiKey,
        now: () => new Date(clock()),
        changed: () => syncStatus(),
      });
      // Inside the meter: its own `spend_cap_reached` and `unpriced` never reached the API.
      provider = { apiKey, provider: meteredProvider(reporting, spend) };
    }
    return provider.provider;
  }

  function announceAll(offerIds: Iterable<number>): void {
    const ids = [...new Set(offerIds)];
    if (ids.length === 0) return;
    const { awaiting } = offers.analysisCounts();
    const spentUsd = spend.spentUsd();
    for (const offerId of ids) {
      const job = offers.analysisJob(offerId);
      const status = offers.analysisStatus(offerId);
      if (job === undefined || status === undefined) continue;
      events.publish("analysis-progress", {
        offerId,
        analysisState: job.state,
        status,
        awaiting,
        spentUsd,
      });
    }
  }

  function announce(offerId: number): void {
    announceAll([offerId]);
  }

  function fail(job: AnalysisJob, kind: string): void {
    offers.failAnalysis(job.id, kind);
    phases.set(job.id, "taken");
    // The kind is all that is ever logged: never a message, a key or any Offer text.
    console.error(`Analysis of Offer ${job.id} failed: ${kind}`);
    announce(job.id);
  }

  /**
   * An owed Re-analyse click (`job.reanalyzeRequestedAt`) runs whatever the Offer's state. It stays
   * owed through every return that reads nothing, a hand-over to a batch included: only the write
   * that saves the analysis, records the failure or queues an analyzed Offer's escalation ends it,
   * here or when the batch ends, before that outcome is announced.
   */
  async function analyseOne(job: AnalysisJob): Promise<"done" | "skipped" | "key-refused" | "cap"> {
    const id = job.id;
    const force = job.reanalyzeRequestedAt !== null;
    if (!force && (job.stale || (job.state === "analyzed" && !job.wordsChanged))) return "skipped";
    // Its request is already waiting for, or inside, a batch: reading it here too bills it twice,
    // click or no click.
    if (batch.heldBy(id) === "batch") return "skipped";
    const apiKey = keyOf();
    if (apiKey === undefined) return "skipped";
    const settings = loadAnalysisSettings(db);
    if (!force && settings.batchOnly) return "skipped";

    const page = reader.read(job);
    if (typeof page === "string") {
      fail(job, page);
      return "done";
    }

    const plan = batch.planOf(settings);
    const args: StepArgs = {
      text: page.text,
      category: job.category,
      ruleFacts: page.facts,
      ...plan,
    };
    const request = firstRequest(args);
    const room = roomFor(request);
    if (room === "none") {
      waitForCap(id);
      return "skipped";
    }
    noRoom.delete(id);
    if (room === "batch") {
      batch.enqueue([job], { plan, holder: "realtime" });
      batch.kick();
      return "skipped";
    }

    phases.set(id, "reading");
    announce(id);
    try {
      const response = await callWithRetry(
        providerOf(apiKey),
        request,
        options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
      );
      // A merge during the call may have given the Offer a further read of its words, which this
      // answer would overwrite or escalate again. The call is metered all the same.
      const now = offers.analysisJob(id);
      if (now === undefined || now.readDepth > job.readDepth) {
        phases.set(id, "taken");
        announce(id);
        return "done";
      }
      const step = readFirst(args, response);
      const analyzedAt = new Date(clock()).toISOString();
      const hash = contentHash(page.text);
      if (step.kind === "done") {
        offers.saveAnalysis(
          id,
          step.result.facts,
          makeRun({ plan, result: step.result, analyzedAt, contentHash: hash }),
        );
      } else {
        // The escalation is read as a batch, at half the price.
        const escalate = () =>
          batch.enqueueEscalation({ offerId: id, contentHash: hash, plan, state: step.state });
        if (job.state !== "analyzed") {
          offers.saveAnalysis(
            id,
            step.provisional.facts,
            makeRun({ plan, result: step.provisional, analyzedAt, contentHash: hash }),
            { carry: step.state, plan, contentHash: hash },
          );
          escalate();
        } else {
          // Nothing is saved, so the queued request is all that carries a click's reading on. One
          // write queues it and ends the click: a crash leaves the Offer owed or queued, never
          // both and never neither.
          db.$client.transaction(() => {
            escalate();
            offers.handOverReanalysis(id);
          })();
        }
        batch.kick();
      }
      phases.set(id, "taken");
      announce(id);
      return "done";
    } catch (error) {
      // Its call went out and nothing is stored yet: an error that leaves this function from
      // here on leaves the Offer `unstored`.
      if (phases.get(id) === "reading") phases.set(id, "unstored");
      const kind = error instanceof ProviderError ? error.kind : "server_error";
      const policy = ERROR_KINDS[kind];
      if (policy.perOffer === "not-a-failure") {
        // Nothing was sent, so there is nothing to store; a click on it stays owed.
        phases.set(id, "taken");
        if (kind === "spend_cap_reached") noRoom.add(id);
        announce(id);
      } else {
        fail(job, kind);
      }
      if (!policy.stopsQueue) return "done";
      return policy.perOffer === "not-a-failure" ? "cap" : "key-refused";
    }
  }

  /**
   * A batch call when only that fits, as new Offers go when the cap pays for a typical batch call
   * and not a realtime one.
   */
  function roomFor(request: AnalysisRequest): "realtime" | "batch" | "none" {
    const headroom = spend.headroomBetweenCallsMicros();
    const realtime = spend.estimateMicros(request, { batch: false });
    if (realtime === undefined || realtime <= headroom) return "realtime";
    const batched = spend.estimateMicros(request, { batch: true });
    return batched !== undefined && batched <= headroom ? "batch" : "none";
  }

  function waitForCap(id: number): void {
    if (noRoom.has(id)) return;
    noRoom.add(id);
    announce(id);
  }

  /** A page that cannot be read goes on to the batch, which records its failure at no cost. */
  function batchFits(job: AnalysisJob, plan: AnalysisPlan): boolean {
    const page = reader.read(job);
    if (typeof page === "string") return true;
    const request = firstRequest({
      text: page.text,
      category: job.category,
      ruleFacts: page.facts,
      ...plan,
    });
    return roomFor(request) !== "none";
  }

  async function drain(): Promise<void> {
    while (!stopped) {
      const id = queue.shift();
      if (id === undefined) return;
      phases.set(id, "taken");
      try {
        const job = offers.analysisJob(id);
        if (job === undefined) continue;
        const outcome = await analyseOne(job);
        // Its Offer may only be too big for what is left, so the Offers behind it still get their
        // own look at the cap.
        if (outcome === "cap" && job.reanalyzeRequestedAt !== null) continue;
        if (outcome === "key-refused" || outcome === "cap") {
          // A refused key has answered this Offer, a click on it included: `unauthorized` is
          // recorded on it. The clicks behind it are still owed.
          for (const waiting of queue.splice(0)) phases.delete(waiting);
        }
      } catch {
        // The database closed under a call in flight (shutdown), or took no write. A click whose
        // outcome was not stored is still on its Offer: the next start reads it, and so does the
        // next cycle unless its call had gone out (`unstored`).
        if (!stopped) {
          const held =
            phases.get(id) === "unstored"
              ? "; it is not sent again before a restart or a click"
              : "";
          console.error(`Analysis of Offer ${id} stopped on an internal error${held}`);
        }
      } finally {
        if (phases.get(id) !== "unstored") phases.delete(id);
      }
    }
  }

  function enqueue(id: number): void {
    // In flight, its call reads the Offer's words as they are now: it is a click's reading too.
    if (phases.has(id)) return;
    phases.set(id, "queued");
    queue.push(id);
  }

  function kick(): void {
    if (running !== undefined || stopped) return;
    running = drain().finally(() => {
      running = undefined;
      if (queue.length > 0) kick();
    });
  }

  function sweep(): void {
    if (stopped) return;
    const jobs = offers.analysisJobs();
    for (const job of jobs) {
      if (!job.wordsChanged) continue;
      offers.resetAnalysis(job.id);
      announce(job.id);
    }
    for (const id of noRoom) {
      const job = offers.analysisJob(id);
      const waits =
        job !== undefined &&
        !job.stale &&
        batch.heldBy(id) !== "batch" &&
        (job.reanalyzeRequestedAt !== null || job.state !== "analyzed");
      if (waits) continue;
      noRoom.delete(id);
      announce(id);
    }
    const justStored = new Set(fresh);
    fresh.clear();
    // The batch loop looks at the cap too: a lowered cap cancels what is in flight.
    batch.kick();
    // Every cycle, so a new month or a changed cap reaches /events even when nothing is sent.
    const cap = spend.sync();
    if (keyOf() === undefined) return;
    if (cap.state !== "ok") return;
    const settings = loadAnalysisSettings(db);
    // While the key stays refused, each cycle sends the oldest owed click, and the `unauthorized`
    // recorded on its Offer ends it.
    for (const id of offers.owedReanalyses()) enqueue(id);
    // Room for a batch call but not a realtime one: new Offers go as a batch too, rather than
    // being turned away at the realtime reservation.
    const realtime = spend.fitsRealtime();
    const plan = batch.planOf(settings);
    const held = batch.heldOffers();
    const forBatch: AnalysisJob[] = [];
    for (const job of jobs) {
      if (job.stale || held.has(job.id)) continue;
      // A batch would bill its words a second time as surely as a realtime call.
      if (phases.get(job.id) === "unstored") continue;
      if (job.escalation !== null && !job.wordsChanged) {
        if (mayResendEscalation(job, clock())) {
          const { carry, plan, contentHash: hash } = job.escalation;
          offers.noteEscalationResent(job.id);
          batch.enqueueEscalation({ offerId: job.id, contentHash: hash, plan, state: carry });
        }
        continue;
      }
      if (job.state === "analyzed" && !job.wordsChanged) continue;
      // A refusal or a cut-off answer waits for new words or a click: a retry is billed again.
      if (job.state === "failed" && !mayRetry(job, clock())) continue;
      // One published long ago is a backfill, and so is one that waited a while for a key or for
      // room under the cap; a failed backfill is retried as one.
      const backfill =
        (job.state === "pending" || job.state === "failed") &&
        !justStored.has(job.id) &&
        !isNew(job);
      if (!(settings.batchOnly || backfill || !realtime)) {
        enqueue(job.id);
        continue;
      }
      // Queued, it would only be discarded at submit and queued again by the next sweep.
      if (!batchFits(job, plan)) {
        waitForCap(job.id);
        continue;
      }
      // The `in-batch` that follows is what says it left the wait.
      noRoom.delete(job.id);
      forBatch.push(job);
    }
    if (forBatch.length > 0) batch.enqueue(forBatch, { plan });
    kick();
    batch.kick();
  }

  let poked = false;

  function poke(): void {
    if (poked || stopped) return;
    poked = true;
    setImmediate(() => {
      if (!poked) return;
      poked = false;
      sweep();
    });
  }

  /** An exact re-post that joined an already-read Offer keeps its model facts and costs no pass. */
  function ingested(result: IngestResult): void {
    if (result.outcome === "none") return;
    if (result.reusedFacts && result.offerId !== null) {
      if (offers.analysisJob(result.offerId)?.state === "analyzed") return;
    }
    if (result.offerId !== null) {
      const job = offers.analysisJob(result.offerId);
      if (job !== undefined && isNew(job)) fresh.add(result.offerId);
    }
    poke();
  }

  function status() {
    // First: it settles idle runs, which the counts below then show.
    const activeRunId = batch.activeRunId() ?? null;
    const { source, unreadable, settings } = readAnalysisSettings(db);
    const older = batch.outdatedJobs(settings).length;
    const key = keyState(db);
    const { pending, analyzed, failed, awaiting, byStatus } = offers.analysisCounts();
    return {
      counts: { pending, analyzed, failed },
      awaiting,
      key,
      byStatus,
      version: analysisVersion(batch.planOf(settings).model),
      olderVersion: { count: older, estimatedCostUsd: estimateReanalysisUsd(older, settings) },
      spend: spend.capState(),
      activeRunId,
      settings: { source, unreadable },
    };
  }

  let published: string | undefined;
  let syncing = false;

  function publishStatus(): void {
    syncing = false;
    if (stopped) return;
    try {
      const body = status();
      const json = JSON.stringify(body);
      if (json === published) return;
      published = json;
      events.publish("analysis-status-changed", body);
    } catch (error) {
      console.error(`Publishing the analysis status failed: ${(error as Error).name}`);
    }
  }

  /**
   * Called in the middle of other work (a provider call, a reservation's release, the batch loop
   * capping a run), where `status()` settling a run would announce it before that work does. So it
   * publishes once the current work has finished, and never throws into its caller.
   */
  function syncStatus(): void {
    if (syncing || stopped) return;
    syncing = true;
    queueMicrotask(publishStatus);
  }

  return {
    sweep,
    poke,
    ingested,
    spend,
    batch,
    reanalyze(
      id: number,
    ): "queued" | "not-found" | "no-key" | "key-refused" | "in-batch" | "spend-cap-reached" {
      const job = offers.analysisJob(id);
      if (job === undefined) return "not-found";
      if (keyOf() === undefined) return "no-key";
      // It would only fail `unauthorized` and leave a failed attempt on the Offer.
      if (keyState(db) === "refused") return "key-refused";
      // Its request is already paid for in a batch; a realtime read on top would bill it twice.
      if (batch.heldBy(id) === "batch") return "in-batch";
      if (spend.sync().state !== "ok") return "spend-cap-reached";
      const plan = batch.planOf(loadAnalysisSettings(db));
      const page = reader.read(job);
      // The call in flight is not counted; if it leaves too little, the click stays owed and waits
      // for the cap.
      const room =
        inFlight(id) || typeof page === "string"
          ? "realtime"
          : roomFor(
              firstRequest({
                text: page.text,
                category: job.category,
                ruleFacts: page.facts,
                ...plan,
              }),
            );
      if (room === "none") return "spend-cap-reached";
      // The `reading` or `in-batch` that follows is what says it left the wait.
      noRoom.delete(id);
      // Stored before the 202 is given, so a restart still owes the read.
      offers.requestReanalysis(id);
      // A click is the seeker asking for one more try, also of a call whose outcome was lost.
      if (phases.get(id) === "unstored") phases.delete(id);
      if (room === "batch") {
        batch.enqueue([job], { plan, holder: "realtime" });
        batch.kick();
      } else {
        enqueue(id);
        kick();
      }
      return "queued";
    },
    async idle(): Promise<void> {
      if (poked) {
        poked = false;
        sweep();
      }
      while (running !== undefined) await running;
      await batch.idle();
    },
    async pollBatches(): Promise<void> {
      await batch.poll();
    },
    start(): void {
      stopped = false;
      if (timer !== undefined) clearInterval(timer);
      batch.start();
      sweep();
      timer = setInterval(sweep, options.intervalMs ?? 5 * MINUTE);
      timer.unref();
    },
    /** Call before the database closes. */
    stop(): void {
      stopped = true;
      batch.stop();
      if (timer !== undefined) clearInterval(timer);
    },
    status,
    syncStatus,
  };
}
