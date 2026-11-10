import {
  fakeBatchProvider,
  fakeProvider,
  outputWith,
  sure,
  unsure,
} from "@wg-hunt/core/analysis/testing";
import { wgGesuchtSource } from "@wg-hunt/core/sources/wg-gesucht";
import { expect } from "vitest";
import { adapterFixture } from "./fixtures/search-pages.js";
import { bootOffers, MINUTE } from "./offers-harness.js";

export const KEY = "sk-ant-api03-test-key-do-not-leak-0123456789";

export const anmeldungOk = outputWith({
  anmeldung: { value: "possible", ...sure("Anmeldung ist möglich") },
});
export const doubtful = outputWith({
  anmeldung: { value: "conditional", ...unsure("Anmeldung ist möglich") },
});

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens?: number;
};
export const usage = (over: Partial<TokenUsage> = {}): TokenUsage => ({
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...over,
});

export function boot(
  options: {
    script?: Parameters<typeof fakeProvider>[0];
    batchScript?: Parameters<typeof fakeBatchProvider>[0];
    usage?: TokenUsage;
    batchUsage?: TokenUsage;
    size?: number;
    start?: number;
    dataDir?: string;
    graceMs?: number;
    sameProviders?: {
      realtime: ReturnType<typeof fakeProvider>;
      batch: ReturnType<typeof fakeBatchProvider>;
    };
  } = {},
) {
  const realtime =
    options.sameProviders?.realtime ??
    fakeProvider(options.script ?? [anmeldungOk], { usage: options.usage ?? usage() });
  const batch =
    options.sameProviders?.batch ??
    fakeBatchProvider(options.batchScript ?? [anmeldungOk], {
      usage: options.batchUsage ?? usage(),
    });
  const h = bootOffers({
    ...(options.start !== undefined && { start: options.start }),
    ...(options.dataDir !== undefined && { dataDir: options.dataDir }),
    analysis: {
      providerFor: () => realtime.provider,
      batchProviderFor: () => batch.provider,
      sleep: async () => {},
      batch: { size: options.size ?? 100, reconcileGraceMs: options.graceMs ?? 10 * MINUTE },
    },
  });
  return { ...h, ...realtime, batch };
}
export type Boot = ReturnType<typeof boot>;

export const setKey = async (h: Boot) => {
  expect((await h.call("PUT", "/secrets/anthropic", { value: KEY })).status).toBe(200);
};

export async function change(h: Boot, patch: Record<string, unknown>) {
  const current = (await h.json("GET", "/settings/analysis")).body;
  expect((await h.json("PUT", "/settings/analysis", { ...current, ...patch })).status).toBe(200);
}

export const status = async (h: Boot) => (await h.json("GET", "/analysis")).body;
export const poll = (h: Boot) => h.runtime.analysis.pollBatches();
export const offerOf = async (h: Boot, id: number) => (await h.json("GET", `/offers/${id}`)).body;

export async function crawlOffers(h: Boot, count: number) {
  const ids = Array.from({ length: count }, (_, i) => 9000001 + i);
  h.site.cards = h.freshCards(ids);
  await h.addSearch();
  await h.crawl();
  await h.runtime.analysis.idle();
  return (await h.json("GET", "/offers")).body.items as { id: number; analysisState: string }[];
}

export function recheck(h: Boot, html: string, adId = 9000001) {
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

export const editedPage = () =>
  adapterFixture("flatshare").replace(
    "Anmeldung ist möglich.",
    "Anmeldung ist möglich. Neu: Mindestmietdauer 3 Monate.",
  );

export { MINUTE };
