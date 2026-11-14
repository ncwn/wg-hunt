// @vitest-environment jsdom

import { act, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fakeBatchProvider,
  fakeProvider,
  outputWith,
  sure,
} from "../../../packages/core/src/analysis/testing.js";
import {
  driveCrawl,
  fakeSource,
  MINUTE,
  MORNING,
  offerPageWith,
  relaxCaps,
} from "../../server/test/offers-harness.js";
import { ANALYSIS_RETRY_MS } from "../src/analysis.js";
import { openAdvanced } from "./advanced.js";
import { realServer } from "./real-server.js";
import { fakeEventStream, renderDashboard } from "./render.js";

const KEY = "sk-ant-api03-dashboard-test-key-0123456789";
const ok = outputWith({ anmeldung: { value: "possible", ...sure("Anmeldung ist möglich") } });

async function boot(count: number) {
  const realtime = fakeProvider([ok]);
  const batch = fakeBatchProvider([ok]);
  const source = fakeSource();
  const clock = { now: MORNING };
  const server = realServer({
    fetcher: source.fetcher,
    clock: () => clock.now,
    analysis: {
      providerFor: () => realtime.provider,
      batchProviderFor: () => batch.provider,
      sleep: async () => {},
    },
  });
  await server.signIn();
  relaxCaps(server.runtime, clock.now);
  await server.call("PUT", "/secrets/anthropic", { value: KEY });
  const ids = Array.from({ length: count }, (_, i) => 9000001 + i);
  source.site.cards = ids.map((id) => ({ id, age: "5 Min.", title: `Zimmer ${id}` }));
  for (const id of ids)
    source.site.pages.set(id, offerPageWith({ title: `Zimmer ${id}`, warmRent: 450 }));
  await server.call("POST", "/searches", { city: "Berlin", categories: ["flatshare-room"] });
  await driveCrawl(server.runtime, clock, clock.now + 4 * 60 * MINUTE);
  await server.runtime.analysis.idle();
  const current = await (await server.call("GET", "/settings/analysis")).json();
  await server.call("PUT", "/settings/analysis", {
    ...current,
    model: "claude-sonnet-5-5",
    effort: "medium",
  });
  return { server, batch };
}

afterEach(() => {
  vi.useRealTimers();
});

async function startRun(fetch: (request: Request) => Promise<Response>) {
  const events = fakeEventStream();
  const { user } = renderDashboard(fetch, "/settings", events.stream);
  await openAdvanced(user);
  await user.click(await screen.findByRole("button", { name: "Re-analyse" }));
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", { name: "Re-analyse" }),
  );
  await screen.findByText(/Re-analysing: 0 of 2 offers/);
  return events;
}

describe("a run that ended while the connection was down", () => {
  it("is not shown as still going when the status read after the reconnect fails once", async () => {
    const { server, batch } = await boot(2);
    let failNextStatus = false;
    let statusReads = 0;
    const fetch = async (request: Request) => {
      if (new URL(request.url).pathname === "/api/v1/analysis") {
        statusReads += 1;
        if (failNextStatus) {
          failNextStatus = false;
          throw new TypeError("Failed to fetch");
        }
      }
      return server.fetch(request);
    };
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const events = await startRun(fetch);
    await server.runtime.analysis.pollBatches();

    // The run ends while the stream is down, so its last announcement never reaches the page.
    batch.complete();
    await server.runtime.analysis.pollBatches();
    expect((await (await server.call("GET", "/analysis")).json()).activeRunId).toBeNull();

    failNextStatus = true;
    await events.reconnect();
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(failNextStatus).toBe(false);
    const readsAfterReconnect = statusReads;

    await act(() => vi.advanceTimersByTimeAsync(ANALYSIS_RETRY_MS));
    expect(await screen.findByText(/Re-analysis finished: 2 offers/)).toBeTruthy();
    const snapshot = await (await server.call("GET", "/analysis")).json();
    await events.emit({ type: "analysis-status-changed", data: snapshot });

    expect({
      statusReadAgain: statusReads > readsAfterReconnect,
      snapshotActiveRunId: snapshot.activeRunId,
      saysRunStillGoing: screen.queryByText(/Re-analysing: 0 of 2 offers/) !== null,
    }).toEqual({ statusReadAgain: true, snapshotActiveRunId: null, saysRunStillGoing: false });
  });

  it("shows the outcome of the run it follows when a snapshot says none is going", async () => {
    const { server, batch } = await boot(2);
    const events = await startRun(server.fetch);
    await server.runtime.analysis.pollBatches();
    batch.complete();
    await server.runtime.analysis.pollBatches();

    const snapshot = await (await server.call("GET", "/analysis")).json();
    expect(snapshot.activeRunId).toBeNull();
    await events.emit({ type: "analysis-status-changed", data: snapshot });

    expect(await screen.findByText(/Re-analysis finished: 2 offers/)).toBeTruthy();
    expect(screen.queryByText(/Re-analysing/)).toBeNull();
  });
});
