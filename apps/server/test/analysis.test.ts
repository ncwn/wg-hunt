import { ProviderError } from "@wg-hunt/core";
import {
  emptyOutput,
  fakeBatchProvider,
  fakeProvider,
  outputWith,
  sure,
  unsure,
} from "@wg-hunt/core/analysis/testing";
import { wgGesuchtSource } from "@wg-hunt/core/sources/wg-gesucht";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AdSpec, adPage, fetchedAd, ROOM_TEXT_EDITED } from "./dedupe-harness.js";
import { adapterFixture } from "./fixtures/search-pages.js";
import { bootOffers, MINUTE } from "./offers-harness.js";

const KEY = "sk-ant-api03-test-key-do-not-leak-0123456789";

const anmeldungOk = outputWith({
  anmeldung: { value: "possible", ...sure("Anmeldung ist möglich") },
});

function boot(
  script: Parameters<typeof fakeProvider>[0] = [anmeldungOk],
  batchScript: Parameters<typeof fakeBatchProvider>[0] = [anmeldungOk],
) {
  const fake = fakeProvider(script);
  const batch = fakeBatchProvider(batchScript);
  const h = bootOffers({
    analysis: {
      providerFor: () => fake.provider,
      batchProviderFor: () => batch.provider,
      sleep: async () => {},
    },
  });
  return { ...h, ...fake, batch };
}

type Boot = ReturnType<typeof boot>;

const setKey = async (h: Boot) => {
  const res = await h.call("PUT", "/secrets/anthropic", { value: KEY });
  expect(res.status).toBe(200);
};

async function crawlOne(h: Boot, adId = 9000001) {
  h.site.cards = h.freshCards([adId]);
  await h.addSearch();
  await h.crawl();
  await h.runtime.analysis.idle();
  // A Stale Offer is hidden from ranking; this lists it all the same.
  const list = await h.json("GET", "/offers?includeHidden=true");
  return list.body.items[0] as { id: number; analysisState: string };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("analysing a new Offer", () => {
  it("fills the model facts of an Offer the crawl found, through the provider", async () => {
    const h = boot();
    await setKey(h);

    const offer = await crawlOne(h);

    expect(offer.analysisState).toBe("analyzed");
    const { body } = await h.json("GET", `/offers/${offer.id}`);
    expect(body.facts.anmeldung).toEqual({
      value: "possible",
      origin: "text",
      quote: "Anmeldung ist möglich",
      confidence: { status: "confident" },
    });
    expect(body.analysis).toMatchObject({
      state: "analyzed",
      model: "claude-haiku-5-5",
      effort: "medium",
      escalation: { model: "claude-haiku-5-5", effort: "high" },
      escalated: false,
    });
    expect(body.facts.roomSize.origin).toBe("field");
  });

  it("sends one Offer per request, with the fixed prefix and the Offer's own words", async () => {
    const h = boot();
    await setKey(h);

    await crawlOne(h);

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.userTurn).toContain("Anmeldung ist möglich.");
    expect(h.requests[0]).toMatchObject({ model: "claude-haiku-5-5", effort: "medium" });
  });

  it("announces its progress on /events", async () => {
    const h = boot();
    await setKey(h);

    const offer = await crawlOne(h);

    const progress = h.events.filter((event) => event.type === "analysis-progress");
    // The fake model used 1,000 input and 200 output tokens: $0.10 and $0.50 per million.
    expect(progress.map((event) => event.data)).toEqual([
      {
        offerId: offer.id,
        analysisState: "pending",
        status: { status: "reading", next: "wait", reason: null, at: null, willRead: true },
        awaiting: 1,
        spentUsd: 0,
      },
      {
        offerId: offer.id,
        analysisState: "analyzed",
        status: { status: "analyzed", next: "none", reason: null, at: null, willRead: false },
        awaiting: 0,
        spentUsd: 0.0002,
      },
    ]);
  });

  it("keeps the first pass at once and reads the Offer again at the escalation setting as a batch", async () => {
    const h = boot(
      [outputWith({ anmeldung: { value: "conditional", ...unsure("Anmeldung ist möglich") } })],
      [anmeldungOk],
    );
    await setKey(h);

    const offer = await crawlOne(h);

    expect(h.requests.map((request) => request.effort)).toEqual(["medium"]);
    const waiting = (await h.json("GET", `/offers/${offer.id}`)).body;
    expect(waiting.analysisState).toBe("analyzed");
    expect(waiting.analysis.escalated).toBe(false);
    expect(waiting.facts.anmeldung.confidence.status).toBe("doubtful");

    await h.runtime.analysis.pollBatches();
    expect(h.batch.submissions).toHaveLength(1);
    expect(h.batch.submissions[0]?.map((r) => r.request.effort)).toEqual(["high"]);
    h.batch.complete();
    await h.runtime.analysis.pollBatches();

    const { body } = await h.json("GET", `/offers/${offer.id}`);
    expect(body.analysis.escalated).toBe(true);
    expect(body.facts.anmeldung).toMatchObject({
      value: "possible",
      confidence: { status: "confident" },
    });
  });

  it("merges 'Geschlecht egal' in the field with 'nur Frauen' in the text into {woman}", async () => {
    const h = boot([
      outputWith({
        anmeldung: { value: "possible", ...sure("Anmeldung ist möglich") },
        genderSoughtFromText: { value: "only", only: ["woman"], ...sure("Nur Frauen, bitte") },
      }),
    ]);
    h.site.pages.set(
      9000001,
      adapterFixture("flatshare")
        .replace("Frau zwischen 23 und 28 Jahren", "Geschlecht egal")
        .replace("Wir kochen gern zusammen.", "Wir kochen gern zusammen. Nur Frauen, bitte."),
    );
    await setKey(h);

    const offer = await crawlOne(h);

    const { body } = await h.json("GET", `/offers/${offer.id}`);
    expect(body.facts.genderSought).toMatchObject({
      value: ["woman"],
      origin: "text",
      alternatives: [{ value: "any", origin: "field", quote: "Geschlecht egal" }],
    });
  });
});

describe("without an Anthropic key", () => {
  it("keeps crawling and leaves the Offers pending, never calling the provider", async () => {
    const h = boot();

    const offer = await crawlOne(h);

    expect(offer.analysisState).toBe("pending");
    expect(h.requests).toHaveLength(0);
    const status = await h.json("GET", "/analysis");
    expect(status.body).toMatchObject({
      key: "absent",
      counts: { pending: 1, analyzed: 0, failed: 0 },
      awaiting: 0,
      byStatus: { "waiting-for-key": 1 },
    });
    expect((await h.json("GET", `/offers/${offer.id}`)).body.analysisStatus).toMatchObject({
      status: "waiting-for-key",
      next: "add-key",
    });
  });

  it("analyses the waiting Offers as soon as a key is set", async () => {
    const h = boot();
    const offer = await crawlOne(h);

    await setKey(h);
    await h.runtime.analysis.idle();

    const { body } = await h.json("GET", `/offers/${offer.id}`);
    expect(body.analysisState).toBe("analyzed");
    expect((await h.json("GET", "/analysis")).body.awaiting).toBe(0);
  });
});

describe("when the API fails", () => {
  it("marks the Offer failed after the retries, and the next cycle tries again", async () => {
    let failing = true;
    const h = boot(() => (failing ? new ProviderError("overloaded") : anmeldungOk));
    await setKey(h);

    const offer = await crawlOne(h);

    expect(offer.analysisState).toBe("failed");
    expect(h.requests).toHaveLength(4);
    const failed = await h.json("GET", `/offers/${offer.id}`);
    expect(failed.body.analysis).toMatchObject({ state: "failed" });
    expect(failed.body.analysisStatus.reason).toBe("overloaded");
    expect((await h.json("GET", "/analysis")).body).toMatchObject({
      counts: { failed: 1 },
      awaiting: 0,
      byStatus: { "retry-at": 1 },
    });
    expect(failed.body.analysisStatus).toEqual({
      status: "retry-at",
      next: "wait",
      reason: "overloaded",
      at: new Date(h.clock.now + 10 * MINUTE).toISOString(),
      willRead: false,
    });

    failing = false;
    h.runtime.analysis.sweep();
    await h.runtime.analysis.idle();
    expect(h.requests).toHaveLength(4);
    h.clock.now += 11 * MINUTE;
    h.runtime.analysis.sweep();
    await h.runtime.analysis.idle();

    expect((await h.json("GET", `/offers/${offer.id}`)).body.analysisState).toBe("analyzed");
  });

  it("never lets the key into a log, an error or a response", async () => {
    const logs = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")];
    const h = boot(() => {
      throw new Error(`401 invalid x-api-key ${KEY}`);
    });
    await setKey(h);

    const offer = await crawlOne(h);

    const everything = [
      ...logs.flatMap((spy) => spy.mock.calls.flat().map(String)),
      JSON.stringify((await h.json("GET", `/offers/${offer.id}`)).body),
      JSON.stringify((await h.json("GET", "/offers")).body),
      JSON.stringify((await h.json("GET", "/analysis")).body),
      JSON.stringify((await h.json("GET", "/secrets")).body),
      JSON.stringify((await h.json("GET", "/settings/analysis")).body),
      JSON.stringify(h.events),
    ].join("\n");
    expect(offer.analysisState).toBe("failed");
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain("do-not-leak");
  });

  it("stops asking once the key is refused, leaving the rest pending", async () => {
    const h = boot(() => new ProviderError("unauthorized"));
    await setKey(h);
    h.site.cards = h.freshCards([9000001, 9000002, 9000003]);
    await h.addSearch();
    await h.crawl();
    await h.runtime.analysis.idle();

    expect(h.requests).toHaveLength(1);
    const states = (await h.json("GET", "/offers")).body.items.map(
      (offer: { analysisState: string }) => offer.analysisState,
    );
    expect(states.sort()).toEqual(["failed", "pending", "pending"]);
  });
});

describe("what gets analysed, and when", () => {
  it("leaves an Offer that was already Stale (deactivated) when first seen pending, uncounted", async () => {
    const h = boot();
    await setKey(h);
    h.site.pages.set(9000001, adapterFixture("deactivated"));

    const offer = await crawlOne(h);

    expect(h.requests).toHaveLength(0);
    expect(offer.analysisState).toBe("pending");
    expect((await h.json("GET", "/analysis")).body.awaiting).toBe(0);
  });

  it("does not analyse an Offer again when the page is fetched again with the same text", async () => {
    const h = boot();
    await setKey(h);
    const offer = await crawlOne(h);
    const before = h.requests.length;

    const page = adapterFixture("flatshare").replace("489€", "500€");
    recheck(h, page);
    await h.runtime.analysis.idle();

    expect(h.requests).toHaveLength(before);
    expect((await h.json("GET", `/offers/${offer.id}`)).body.analysisState).toBe("analyzed");
  });

  it("analyses an Offer again, from scratch, when its text changed", async () => {
    const h = boot([
      anmeldungOk,
      outputWith({
        anmeldung: { value: "possible", ...sure("Anmeldung ist möglich") },
        minimumStay: { value: "stated", months: 3, ...sure("Mindestmietdauer 3 Monate") },
      }),
    ]);
    await setKey(h);
    const offer = await crawlOne(h);

    const page = adapterFixture("flatshare").replace(
      "Anmeldung ist möglich.",
      "Anmeldung ist möglich. Neu: Mindestmietdauer 3 Monate.",
    );
    recheck(h, page);
    await h.runtime.analysis.idle();

    expect(h.requests).toHaveLength(2);
    const { body } = await h.json("GET", `/offers/${offer.id}`);
    expect(body.analysisState).toBe("analyzed");
    expect(body.facts.minimumStay.value).toBe(3);
  });

  it("sends new Offers through the Batch API when the setting is batch only", async () => {
    const h = boot();
    await setKey(h);
    const settings = (await h.json("GET", "/settings/analysis")).body;
    await h.json("PUT", "/settings/analysis", { ...settings, batchOnly: true });

    const offer = await crawlOne(h);
    await h.runtime.analysis.pollBatches();

    expect(h.requests).toHaveLength(0);
    expect(offer.analysisState).toBe("pending");
    expect(h.batch.submissions).toHaveLength(1);

    h.batch.complete();
    await h.runtime.analysis.pollBatches();

    expect((await h.json("GET", `/offers/${offer.id}`)).body.analysisState).toBe("analyzed");
    expect(h.requests).toHaveLength(0);
  });

  it("reads an Offer that was published days ago through the Batch API: it is a backfill, not new", async () => {
    const h = boot();
    await setKey(h);
    h.site.cards = [
      { id: 9000001, age: "5 Min.", title: "Zimmer 9000001" },
      { id: 9000002, age: "3 Tage", title: "Zimmer 9000002" },
    ];
    await h.addSearch();
    await h.crawl();
    await h.runtime.analysis.idle();
    await h.runtime.analysis.pollBatches();

    expect(h.requests).toHaveLength(1);
    expect(h.batch.submissions).toHaveLength(1);
    const states = (await h.json("GET", "/offers")).body.items.map(
      (offer: { analysisState: string }) => offer.analysisState,
    );
    expect(states.sort()).toEqual(["analyzed", "pending"]);

    h.batch.complete();
    await h.runtime.analysis.pollBatches();

    expect((await h.json("GET", "/analysis")).body.counts).toMatchObject({ analyzed: 2 });
  });

  it("uses the model and effort set in the analysis settings", async () => {
    const h = boot();
    await setKey(h);
    const settings = (await h.json("GET", "/settings/analysis")).body;
    await h.json("PUT", "/settings/analysis", {
      ...settings,
      model: "claude-sonnet-5-5",
      effort: "low",
      escalation: null,
    });

    await crawlOne(h);

    expect(h.requests[0]).toMatchObject({ model: "claude-sonnet-5-5", effort: "low" });
  });
});

describe("the analysis worker started again after a stop", () => {
  it("sweeps and reads again, rather than setting a timer that does nothing", async () => {
    const h = boot();
    h.runtime.analysis.stop();
    await setKey(h);
    const offer = await crawlOne(h);
    expect(offer.analysisState).toBe("pending");

    h.runtime.analysis.start();
    await h.runtime.analysis.idle();
    h.runtime.analysis.stop();

    expect(h.requests).toHaveLength(1);
    expect((await h.json("GET", `/offers/${offer.id}`)).body.analysisState).toBe("analyzed");
  });
});

describe("POST /offers/{id}/reanalyze", () => {
  it("runs the model again on one Offer and replaces its facts", async () => {
    const h = boot([
      anmeldungOk,
      outputWith({ anmeldung: { value: "possible", ...sure("Anmeldung ist möglich") } }),
    ]);
    await setKey(h);
    const offer = await crawlOne(h);

    const res = await h.json("POST", `/offers/${offer.id}/reanalyze`);
    await h.runtime.analysis.idle();

    expect(res.status).toBe(202);
    expect(h.requests).toHaveLength(2);
    expect((await h.json("GET", `/offers/${offer.id}`)).body.analysisState).toBe("analyzed");
  });

  it("keeps the previous result when the new run fails", async () => {
    let calls = 0;
    const h = boot(() => (calls++ === 0 ? anmeldungOk : new ProviderError("overloaded")));
    await setKey(h);
    const offer = await crawlOne(h);

    await h.json("POST", `/offers/${offer.id}/reanalyze`);
    await h.runtime.analysis.idle();

    const { body } = await h.json("GET", `/offers/${offer.id}`);
    expect(body.analysisState).toBe("analyzed");
    expect(body.facts.anmeldung.value).toBe("possible");
    expect(body.analysisStatus.reason).toBe("overloaded");
  });

  it("answers 409 api-key-refused while the API refuses the key, rather than a click that can only fail", async () => {
    const h = boot([anmeldungOk, new ProviderError("unauthorized")]);
    await setKey(h);
    const [offer] = [await crawlOne(h), await crawlOne(h, 9000002)];
    expect((await h.json("GET", "/analysis")).body.key).toBe("refused");

    const refused = await h.json("POST", `/offers/${offer.id}/reanalyze`);
    await h.runtime.analysis.idle();

    expect(refused.status).toBe(409);
    expect(refused.body.type).toBe("api-key-refused");
    expect(h.requests).toHaveLength(2);
    expect((await h.json("GET", `/offers/${offer.id}`)).body.analysisStatus.status).toBe(
      "analyzed",
    );
  });

  it("answers 409 no-api-key without a key, and 404 for an unknown Offer", async () => {
    const h = boot();
    const offer = await crawlOne(h);

    const noKey = await h.json("POST", `/offers/${offer.id}/reanalyze`);
    const unknown = await h.json("POST", "/offers/99999/reanalyze");

    expect(noKey.status).toBe(409);
    expect(noKey.body.type).toBe("no-api-key");
    expect(unknown.status).toBe(404);
    expect(h.requests).toHaveLength(0);
  });
});

function recheck(h: Boot, html: string, adId = 9000001) {
  const parsed = wgGesuchtSource.parseOffer(html, {
    firstSeen: new Date(h.clock.now),
    category: "flatshare-room",
  });
  if (parsed.outcome !== "parsed") throw new Error("unreadable");
  h.runtime.snapshots.write("wg-gesucht", String(adId), html);
  h.runtime.offers.ingest({
    source: "wg-gesucht",
    adId: String(adId),
    fetchedAt: h.clock.now + 5 * MINUTE,
    card: {
      adId: String(adId),
      path: `/wg-zimmer-in-Teststadt-Mitte.${adId}.html`,
      title: `Zimmer ${adId}`,
      advertiser: { name: "Anna", kind: "private" },
    },
    parsed,
  });
}

describe("an exact re-post of an analysed Offer", () => {
  function ingestAd(h: Boot, spec: AdSpec, after: number) {
    h.runtime.snapshots.write("wg-gesucht", String(spec.adId), adPage(spec));
    return h.runtime.offers.ingest(fetchedAd(h, spec, after));
  }

  it("keeps the Offer's model facts and runs no new model pass; an edited text does", async () => {
    const h = boot([emptyOutput()]);
    await setKey(h);
    const title = "Helles Zimmer am Park";

    const first = ingestAd(h, { adId: 9000001, title, warmRent: 450 }, 0);
    await h.runtime.analysis.idle();
    expect(h.requests).toHaveLength(1);
    const read = (await h.json("GET", `/offers/${first.offerId}`)).body.analysis.analyzedAt;

    const repost = ingestAd(h, { adId: 9000002, title, warmRent: 480 }, 10 * MINUTE);
    await h.runtime.analysis.idle();

    expect(repost).toMatchObject({ outcome: "merged", offerId: first.offerId, reusedFacts: true });
    expect(h.requests).toHaveLength(1);
    const kept = (await h.json("GET", `/offers/${first.offerId}`)).body;
    expect(kept.analysisState).toBe("analyzed");
    expect(kept.analysis.analyzedAt).toBe(read);

    const edited = ingestAd(
      h,
      { adId: 9000003, title, warmRent: 480, text: ROOM_TEXT_EDITED },
      20 * MINUTE,
    );
    await h.runtime.analysis.idle();

    expect(edited).toMatchObject({ outcome: "merged", reusedFacts: false });
    expect(h.requests).toHaveLength(2);
  });
});
