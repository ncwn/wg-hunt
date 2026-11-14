// @vitest-environment jsdom

import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ANALYSIS_PREFIX } from "../../../packages/core/src/analysis/prompt.js";
import {
  fakeBatchProvider,
  fakeProvider,
  outputWith,
  sure,
} from "../../../packages/core/src/analysis/testing.js";
import { noteKeyRefused } from "../../server/src/analysis/key.js";
import {
  driveCrawl,
  fakeSource,
  MINUTE,
  MORNING,
  offerPageWith,
  relaxCaps,
} from "../../server/test/offers-harness.js";
import { openAdvanced } from "./advanced.js";
import { realServer } from "./real-server.js";
import { fakeEventStream, liveFrom, renderDashboard } from "./render.js";

async function openSettings(
  server: Awaited<ReturnType<typeof boot>>["server"],
  events?: ReturnType<typeof fakeEventStream>,
) {
  const { user } = renderDashboard(server.fetch, "/settings", events?.stream);
  await openAdvanced(user);
  return user;
}

const KEY = "sk-ant-api03-dashboard-test-key-0123456789";
const ok = outputWith({ anmeldung: { value: "possible", ...sure("Anmeldung ist möglich") } });

async function boot(count = 2, options: { key?: boolean } = {}) {
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
  if (options.key !== false) await server.call("PUT", "/secrets/anthropic", { value: KEY });
  const ids = Array.from({ length: count }, (_, i) => 9000001 + i);
  source.site.cards = ids.map((id) => ({ id, age: "5 Min.", title: `Zimmer ${id}` }));
  for (const id of ids)
    source.site.pages.set(id, offerPageWith({ title: `Zimmer ${id}`, warmRent: 450 }));
  await server.call("POST", "/searches", { city: "Berlin", categories: ["flatshare-room"] });
  await driveCrawl(server.runtime, clock, clock.now + 4 * 60 * MINUTE);
  await server.runtime.analysis.idle();
  return { server, batch, realtime, clock };
}

const changeSettings = async (
  server: Awaited<ReturnType<typeof boot>>["server"],
  patch: Record<string, unknown>,
) => {
  const current = await (await server.call("GET", "/settings/analysis")).json();
  const res = await server.call("PUT", "/settings/analysis", { ...current, ...patch });
  expect(res.status).toBe(200);
};

const rail = async () => within(await screen.findByRole("region", { name: "Reading offers" }));
const railNow = () => within(screen.getByRole("region", { name: "Reading offers" }));

describe("the spend meter in Settings", () => {
  it("shows what has been spent this month against the cap", async () => {
    const { server } = await boot(2);
    await openSettings(server);

    const meter = await (await rail()).findByRole("meter", { name: "Spend this month" });

    // Two realtime calls of 1,000 input and 200 output tokens at Haiku 5.5's prices.
    expect((meter as HTMLMeterElement).value).toBeCloseTo(0.0004, 9);
    expect((meter as HTMLMeterElement).max).toBe(5);
    await waitFor(() => expect(railNow().getByText(/\$0\.0004 of \$5\.00/)).toBeTruthy());
  });

  it("moves as the server announces spend, and shows the cap reached until it is cleared", async () => {
    const { server } = await boot(1);
    const events = fakeEventStream();
    await openSettings(server, events);
    await (await rail()).findByText(/of \$5\.00/);

    await events.emit({
      type: "analysis-progress",
      data: {
        offerId: 1,
        status: { status: "analyzed", next: "none", reason: null, at: null, willRead: false },
        awaiting: 0,
        spentUsd: 1.25,
      },
    });
    await waitFor(() => expect(railNow().getByText(/\$1\.25 of \$5\.00/)).toBeTruthy());
    expect(railNow().queryByText(/cap reached/i)).toBeNull();

    const held = {
      month: "2026-11",
      spentUsd: 5,
      capUsd: 5,
      reservedUsd: 0,
      headroomUsd: 0,
      resetsAt: "2026-11-30T23:00:00.000Z",
    };
    await events.emit({ type: "spend-cap-reached", data: { ...held, state: "reached" } });

    await waitFor(() => expect(railNow().getByText(/Monthly limit reached/)).toBeTruthy());
    expect(railNow().getByText(/\$5\.00 of \$5\.00/)).toBeTruthy();

    await events.emit({
      type: "spend-cap-cleared",
      data: {
        ...held,
        month: "2026-12",
        spentUsd: 0,
        headroomUsd: 5,
        state: "ok",
        resetsAt: "2026-12-31T23:00:00.000Z",
      },
    });

    await waitFor(() => expect(railNow().queryByText(/Monthly limit reached/)).toBeNull());
    expect(railNow().getByText(/\$0\.00 of \$5\.00/)).toBeTruthy();
  });

  it("says when the cap is held only by reads in progress", async () => {
    const { server } = await boot(1);
    const events = fakeEventStream();
    await openSettings(server, events);
    await (await rail()).findByText(/of \$5\.00/);

    await events.emit({
      type: "spend-cap-reached",
      data: {
        month: "2026-11",
        spentUsd: 1,
        capUsd: 2,
        reservedUsd: 1.5,
        headroomUsd: -0.5,
        state: "waiting-for-in-flight",
        resetsAt: "2026-11-30T23:00:00.000Z",
      },
    });

    await waitFor(() => expect(railNow().getByText(/held by reads in progress/)).toBeTruthy());
    expect(railNow().queryByText(/Monthly limit reached/)).toBeNull();
  });

  it("tells the seeker when the cap is already reached on opening", async () => {
    const { server } = await boot(1);
    await changeSettings(server, { monthlySpendCapUsd: 0 });
    await openSettings(server);

    expect(await (await rail()).findByText(/Monthly limit reached/)).toBeTruthy();
  });
});

describe("a key refused after the page opened", () => {
  it("shows the refused-key warning without a reload", async () => {
    const { server } = await boot(1);
    const events = fakeEventStream();
    await openSettings(server, events);
    await (await rail()).findByText(/of \$5\.00/);
    expect(railNow().queryByText(/key was refused/)).toBeNull();

    noteKeyRefused(server.runtime.db, KEY, new Date());
    const now = await (await server.call("GET", "/analysis")).json();
    await events.emit({ type: "analysis-status-changed", data: now });

    await waitFor(() => expect(railNow().getByText(/The Anthropic key was refused/)).toBeTruthy());
  });

  it("clears the warning when the key is replaced from the CLI", async () => {
    const { server } = await boot(1);
    noteKeyRefused(server.runtime.db, KEY, new Date());
    await openSettings(server, liveFrom(server));
    await (await rail()).findByText(/The Anthropic key was refused/);

    const saved = await server.asCli("/secrets/anthropic", {
      method: "PUT",
      body: JSON.stringify({ value: `${KEY}-new` }),
    });

    expect(saved.status).toBe(200);
    await waitFor(() => expect(railNow().queryByText(/key was refused/)).toBeNull());
  });

  it("keeps a newer snapshot when a read from before it answers last", async () => {
    const { server } = await boot(1);
    const events = fakeEventStream();
    let hold: Promise<void> | undefined;
    let release = () => {};
    const fetch = async (request: Request) => {
      const held = hold;
      const response = await server.fetch(request);
      if (held && request.method === "GET" && new URL(request.url).pathname === "/api/v1/analysis")
        await held;
      return response;
    };
    const { user } = renderDashboard(fetch, "/settings", events.stream);
    await openAdvanced(user);
    await (await rail()).findByText(/of \$5\.00/);

    hold = new Promise((resolve) => {
      release = resolve;
    });
    await events.reconnect();
    noteKeyRefused(server.runtime.db, KEY, new Date());
    const now = await (await server.call("GET", "/analysis")).json();
    hold = undefined;
    await events.emit({ type: "analysis-status-changed", data: now });
    await waitFor(() => expect(railNow().getByText(/The Anthropic key was refused/)).toBeTruthy());

    await act(async () => release());

    expect(railNow().getByText(/The Anthropic key was refused/)).toBeTruthy();
  });

  it("shows the status a snapshot brings after the page could not read it, and follows its run", async () => {
    const { server } = await boot(2);
    await changeSettings(server, { model: "claude-sonnet-5-5", effort: "medium" });
    expect((await server.call("POST", "/analysis/runs")).status).toBe(202);
    const events = fakeEventStream();
    let refuse = true;
    const fetch = async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (refuse && request.method === "GET" && path === "/api/v1/analysis")
        return new Response(null, { status: 503 });
      return server.fetch(request);
    };
    const { user } = renderDashboard(fetch, "/settings", events.stream);
    await openAdvanced(user);
    await screen.findByText(/Couldn't load the reading status/);
    refuse = false;

    const now = await (await server.call("GET", "/analysis")).json();
    await events.emit({ type: "analysis-status-changed", data: now });

    await waitFor(() => expect(screen.queryByText(/Couldn't load the reading status/)).toBeNull());
    expect(await screen.findByText(/Re-analysing: 0 of 2 offers/)).toBeTruthy();
  });
  it("follows the run a snapshot names when it came before a first read that then failed", async () => {
    const { server } = await boot(2);
    await changeSettings(server, { model: "claude-sonnet-5-5", effort: "medium" });
    expect((await server.call("POST", "/analysis/runs")).status).toBe(202);
    const events = fakeEventStream();
    let first = true;
    let asked = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (first && request.method === "GET" && path === "/api/v1/analysis") {
        first = false;
        asked = true;
        await gate;
        return new Response(null, { status: 503 });
      }
      return server.fetch(request);
    };
    const { user } = renderDashboard(fetch, "/settings", events.stream);
    await openAdvanced(user);
    await waitFor(() => expect(asked).toBe(true));

    const now = await (await server.call("GET", "/analysis")).json();
    await events.emit({ type: "analysis-status-changed", data: now });
    await act(async () => release());

    expect(await screen.findByText(/Re-analysing: 0 of 2 offers/)).toBeTruthy();
  });
});

describe("Settings: the older-analysis prompt", () => {
  it("says how many Offers are on an older analysis and what re-analysing them costs", async () => {
    const { server } = await boot(2);
    await changeSettings(server, { model: "claude-sonnet-5-5", effort: "medium" });
    await openSettings(server);

    const prompt = await screen.findByText(/2 offers on an older analysis, re-analyse for about/);

    expect(prompt.textContent).toMatch(/for about \$0\.0\d/);
    expect(screen.getByRole("button", { name: "Re-analyse" })).toBeTruthy();
  });

  it("is disabled, and says why, while the limit pays for reading an ad once and not in full", async () => {
    const { server } = await boot(2);
    await changeSettings(server, { model: "claude-sonnet-5-5", effort: "medium" });
    const { spend } = server.runtime.analysis;
    const pass = (model: string, effort: "medium" | "high") =>
      (spend.estimateMicros(
        { model, effort, prefix: ANALYSIS_PREFIX, userTurn: "x".repeat(8_000) },
        { batch: true },
      ) ?? Number.POSITIVE_INFINITY) / 1e6;
    const cap =
      spend.spentUsd() + pass("claude-sonnet-5-5", "medium") + pass("claude-haiku-5-5", "high") / 2;
    await changeSettings(server, { monthlySpendCapUsd: Math.round(cap * 1e6) / 1e6 });
    const status = await (await server.call("GET", "/analysis")).json();
    expect(status.spend.state).toBe("ok");
    expect(status.actions.startRunRefusedBy).toBe("spend-cap-reached");

    await openSettings(server);

    expect(
      await screen.findByText(
        "What's left of the monthly limit doesn't cover reading one ad again in full, so this waits for next month or a higher limit.",
      ),
    ).toBeTruthy();
    expect((screen.getByRole("button", { name: "Re-analyse" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("is not shown when every Offer is on the current analysis", async () => {
    const { server } = await boot(2);
    await openSettings(server);
    const section = within(await screen.findByRole("region", { name: "Reading offers" }));
    await section.findByRole("meter", { name: "Spend this month" });

    expect(screen.queryByText(/on an older analysis/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Re-analyse" })).toBeNull();
  });

  it("starts a run on the click, follows its progress and clears the prompt when it is done", async () => {
    const { server, batch } = await boot(2);
    await changeSettings(server, { model: "claude-sonnet-5-5", effort: "medium" });
    const user = await openSettings(server, liveFrom(server));
    await screen.findByText(/2 offers on an older analysis, re-analyse/);
    expect(batch.submissions).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Re-analyse" }));
    const question = screen.getByRole("alertdialog", { name: "Re-analyse 2 offers?" });
    expect(question.textContent).toMatch(/costs about/);
    expect(batch.submissions).toHaveLength(0);
    await user.click(within(question).getByRole("button", { name: "Re-analyse" }));

    expect(await screen.findByText(/Re-analysing: 0 of 2 offers/)).toBeTruthy();
    await server.runtime.analysis.pollBatches();
    expect(batch.submissions).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Re-analyse" })).toBeNull();

    batch.complete();
    await server.runtime.analysis.pollBatches();

    expect(await screen.findByText(/Re-analysis finished: 2 offers/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/on an older analysis/)).toBeNull());
  });

  it("appears when another reading model is saved elsewhere, without a reload", async () => {
    const { server } = await boot(2);
    await openSettings(server, liveFrom(server));
    await (await rail()).findByRole("meter", { name: "Spend this month" });
    expect(screen.queryByText(/on an older analysis/)).toBeNull();

    const current = await (await server.asCli("/settings/analysis")).json();
    const saved = await server.asCli("/settings/analysis", {
      method: "PUT",
      body: JSON.stringify({ ...current, model: "claude-sonnet-5-5", effort: "medium" }),
    });

    expect(saved.status).toBe(200);
    expect(await screen.findByText(/2 offers on an older analysis, re-analyse/)).toBeTruthy();
  });

  it("shows how a run ended when its last announcement was missed while the connection was down", async () => {
    const { server, batch } = await boot(2);
    await changeSettings(server, { model: "claude-sonnet-5-5", effort: "medium" });
    const events = fakeEventStream();
    const user = await openSettings(server, events);
    await user.click(await screen.findByRole("button", { name: "Re-analyse" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Re-analyse" }),
    );
    await screen.findByText(/Re-analysing: 0 of 2 offers/);
    await server.runtime.analysis.pollBatches();

    batch.complete();
    await server.runtime.analysis.pollBatches();
    await events.reconnect();

    expect(await screen.findByText(/Re-analysis finished: 2 offers/)).toBeTruthy();
    expect(screen.queryByText(/Re-analysing/)).toBeNull();
  });

  it("says nothing was read again when a run's offers all changed while it ran", async () => {
    const { server } = await boot(2);
    await changeSettings(server, { model: "claude-sonnet-5-5", effort: "medium" });
    const events = fakeEventStream();
    const user = await openSettings(server, events);
    await user.click(await screen.findByRole("button", { name: "Re-analyse" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Re-analyse" }),
    );
    await screen.findByText(/Re-analysing/);

    await events.emit({
      type: "analysis-run-progress",
      data: {
        runId: 1,
        status: "succeeded",
        stopReason: null,
        done: 2,
        applied: 0,
        total: 2,
        spentUsd: 0,
      },
    });

    expect(await screen.findByText(/no offer was read again/i)).toBeTruthy();
    expect(screen.queryByText(/2 offers read again/)).toBeNull();
  });

  it("counts only the offers a run read again", async () => {
    const { server } = await boot(2);
    await changeSettings(server, { model: "claude-sonnet-5-5", effort: "medium" });
    const events = fakeEventStream();
    const user = await openSettings(server, events);
    await user.click(await screen.findByRole("button", { name: "Re-analyse" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Re-analyse" }),
    );
    await screen.findByText(/Re-analysing/);

    await events.emit({
      type: "analysis-run-progress",
      data: {
        runId: 1,
        status: "succeeded",
        stopReason: null,
        done: 2,
        applied: 1,
        total: 2,
        spentUsd: 0.01,
      },
    });

    expect(await screen.findByText(/1 of 2 offers read again/)).toBeTruthy();
  });

  it("explains a run the spend cap stopped", async () => {
    const { server } = await boot(2);
    await changeSettings(server, { model: "claude-sonnet-5-5", effort: "medium" });
    const events = fakeEventStream();
    const user = await openSettings(server, events);
    await user.click(await screen.findByRole("button", { name: "Re-analyse" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Re-analyse" }),
    );
    await screen.findByText(/Re-analysing/);

    await events.emit({
      type: "analysis-run-progress",
      data: {
        runId: 1,
        status: "stopped",
        stopReason: "spend-cap-reached",
        done: 2,
        applied: 2,
        total: 2,
        spentUsd: 5,
      },
    });

    expect(await screen.findByText(/stopped: the monthly limit ran out/i)).toBeTruthy();
  });

  it("explains a run that Delete all Offer data interrupted", async () => {
    const { server } = await boot(2);
    await changeSettings(server, { model: "claude-sonnet-5-5", effort: "medium" });
    const events = fakeEventStream();
    const user = await openSettings(server, events);
    await user.click(await screen.findByRole("button", { name: "Re-analyse" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Re-analyse" }),
    );
    await screen.findByText(/Re-analysing/);

    await events.emit({
      type: "analysis-run-progress",
      data: {
        runId: 1,
        status: "stopped",
        stopReason: "interrupted",
        done: 2,
        applied: 2,
        total: 2,
        spentUsd: 0.01,
      },
    });

    expect(await screen.findByText(/its offers were deleted/i)).toBeTruthy();
    expect(screen.queryByText(/monthly limit ran out/i)).toBeNull();
  });

  it("cannot be started at the cap: the button is off and says why", async () => {
    const { server } = await boot(2);
    await changeSettings(server, {
      model: "claude-sonnet-5-5",
      effort: "medium",
      monthlySpendCapUsd: 0,
    });
    await openSettings(server);

    const button = await screen.findByRole("button", { name: "Re-analyse" });

    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/monthly limit is reached/i)).toBeTruthy();
  });

  it("keeps the question up, answering, until the run has started", async () => {
    const { server } = await boot(2);
    await changeSettings(server, { model: "claude-sonnet-5-5", effort: "medium" });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = async (request: Request) => {
      if (request.method === "POST" && new URL(request.url).pathname === "/api/v1/analysis/runs")
        await held;
      return server.fetch(request);
    };
    const { user } = renderDashboard(fetch, "/settings");
    await openAdvanced(user);
    await user.click(await screen.findByRole("button", { name: "Re-analyse" }));
    const question = screen.getByRole("alertdialog", { name: "Re-analyse 2 offers?" });
    await user.click(within(question).getByRole("button", { name: "Re-analyse" }));

    expect(screen.getByRole("alertdialog")).toBe(question);
    for (const button of within(question).getAllByRole("button"))
      expect((button as HTMLButtonElement).disabled).toBe(true);
    release();

    expect(await screen.findByText(/Re-analysing: 0 of 2 offers/)).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("says why a start was refused in its question, and not once it is asked again", async () => {
    const { server } = await boot(2);
    await changeSettings(server, { model: "claude-sonnet-5-5", effort: "medium" });
    const fetch = async (request: Request) =>
      request.method === "POST" && new URL(request.url).pathname === "/api/v1/analysis/runs"
        ? new Response(
            JSON.stringify({ title: "Busy", status: 503, detail: "wg-hunt is busy right now." }),
            { status: 503, headers: { "Content-Type": "application/problem+json" } },
          )
        : server.fetch(request);
    const { user } = renderDashboard(fetch, "/settings");
    await openAdvanced(user);
    await user.click(await screen.findByRole("button", { name: "Re-analyse" }));
    const ask = () => screen.getByRole("alertdialog", { name: "Re-analyse 2 offers?" });
    await user.click(within(ask()).getByRole("button", { name: "Re-analyse" }));

    expect((await within(ask()).findByRole("alert")).textContent).toBe(
      "wg-hunt is busy right now.",
    );
    await user.click(within(ask()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("wg-hunt is busy right now.")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Re-analyse" }));
    expect(within(ask()).queryByRole("alert")).toBeNull();
  });

  it("says so when a run is going but its progress couldn't be read, and reads it again", async () => {
    const { server } = await boot(2);
    await changeSettings(server, { model: "claude-sonnet-5-5", effort: "medium" });
    expect((await server.call("POST", "/analysis/runs")).status).toBeLessThan(300);
    let refuse = true;
    const fetch = async (request: Request) =>
      refuse && /\/analysis\/runs\/\d+$/.test(new URL(request.url).pathname)
        ? new Response(
            JSON.stringify({ title: "Busy", status: 503, detail: "wg-hunt is busy right now." }),
            { status: 503, headers: { "Content-Type": "application/problem+json" } },
          )
        : server.fetch(request);
    const { user } = renderDashboard(fetch, "/settings");
    await openAdvanced(user);

    const section = within(
      (await screen.findByRole("heading", { level: 3, name: "Reading model" })).closest(
        "section",
      ) as HTMLElement,
    );
    expect((await section.findByRole("alert")).textContent).toMatch(
      /Couldn't read how the re-analysis is going: wg-hunt is busy right now\./,
    );
    refuse = false;
    await user.click(section.getByRole("button", { name: "Try again" }));

    expect(await section.findByText(/Re-analysing: 0 of 2 offers/)).toBeTruthy();
    expect(section.queryByRole("alert")).toBeNull();
  });

  it("lets a run's outcome be dismissed", async () => {
    const { server } = await boot(2);
    await changeSettings(server, { model: "claude-sonnet-5-5", effort: "medium" });
    const events = fakeEventStream();
    const user = await openSettings(server, events);
    await user.click(await screen.findByRole("button", { name: "Re-analyse" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Re-analyse" }),
    );
    await screen.findByText(/Re-analysing/);
    await events.emit({
      type: "analysis-run-progress",
      data: {
        runId: 1,
        status: "stopped",
        stopReason: "spend-cap-reached",
        done: 2,
        applied: 2,
        total: 2,
        spentUsd: 5,
      },
    });
    await screen.findByText(/stopped: the monthly limit ran out/i);

    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByText(/stopped: the monthly limit ran out/i)).toBeNull();
  });

  it("shows why a newer run couldn't be read, never the older run's outcome", async () => {
    const { server, batch } = await boot(2);
    await changeSettings(server, { model: "claude-sonnet-5-5", effort: "medium" });
    let refuse = false;
    const fetch = async (request: Request) =>
      refuse && /\/analysis\/runs\/\d+$/.test(new URL(request.url).pathname)
        ? new Response(
            JSON.stringify({ title: "Busy", status: 503, detail: "wg-hunt is busy right now." }),
            { status: 503, headers: { "Content-Type": "application/problem+json" } },
          )
        : server.fetch(request);
    const events = fakeEventStream();
    const { user } = renderDashboard(fetch, "/settings", events.stream);
    await openAdvanced(user);
    await user.click(await screen.findByRole("button", { name: "Re-analyse" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Re-analyse" }),
    );
    await screen.findByText(/Re-analysing: 0 of 2 offers/);
    await server.runtime.analysis.pollBatches();
    batch.complete();
    await server.runtime.analysis.pollBatches();
    await events.emit({
      type: "analysis-run-progress",
      data: {
        runId: 1,
        status: "succeeded",
        stopReason: null,
        done: 2,
        applied: 2,
        total: 2,
        spentUsd: 0.01,
      },
    });
    await screen.findByText(/Re-analysis finished: 2 offers/);

    await changeSettings(server, { model: "claude-haiku-5-5", effort: "low" });
    expect((await server.call("POST", "/analysis/runs")).status).toBeLessThan(300);
    refuse = true;
    await events.reconnect();

    const section = within(
      screen
        .getByRole("heading", { level: 3, name: "Reading model" })
        .closest("section") as HTMLElement,
    );
    expect((await section.findByRole("alert")).textContent).toMatch(
      /Couldn't read how the re-analysis is going: wg-hunt is busy right now\./,
    );
    expect(section.queryByText(/Re-analysis finished/)).toBeNull();
    expect(section.queryByRole("button", { name: "Re-analyse" })).toBeNull();

    refuse = false;
    await user.click(section.getByRole("button", { name: "Try again" }));
    expect(await section.findByText(/Re-analysing: 0 of 2 offers/)).toBeTruthy();
  });

  it("shows a run already going once a reading status that failed is read again", async () => {
    const { server } = await boot(2);
    await changeSettings(server, { model: "claude-sonnet-5-5", effort: "medium" });
    expect((await server.call("POST", "/analysis/runs")).status).toBeLessThan(300);
    let refuse = true;
    const fetch = async (request: Request) =>
      refuse && request.method === "GET" && new URL(request.url).pathname === "/api/v1/analysis"
        ? new Response(JSON.stringify({ title: "Internal server error", status: 500 }), {
            status: 500,
            headers: { "Content-Type": "application/problem+json" },
          })
        : server.fetch(request);
    const { user } = renderDashboard(fetch, "/settings");
    const reading = await rail();
    await reading.findByRole("alert");
    refuse = false;
    await user.click(reading.getByRole("button", { name: "Try again" }));
    await reading.findByText(/No ads waiting|Reading \d+ ads?/);

    await openAdvanced(user);
    const section = within(
      (await screen.findByRole("heading", { level: 3, name: "Reading model" })).closest(
        "section",
      ) as HTMLElement,
    );
    expect(await section.findByText(/Re-analysing: 0 of 2 offers/)).toBeTruthy();
  });

  it("stops saying a run is going once the status says none is, though its outcome couldn't be read", async () => {
    const { server, batch } = await boot(2);
    await changeSettings(server, { model: "claude-sonnet-5-5", effort: "medium" });
    let unreachable = false;
    const fetch = async (request: Request) => {
      if (unreachable && /\/analysis\/runs\/\d+$/.test(new URL(request.url).pathname))
        throw new TypeError("Failed to fetch");
      return server.fetch(request);
    };
    const events = fakeEventStream();
    const { user } = renderDashboard(fetch, "/settings", events.stream);
    await openAdvanced(user);
    await user.click(await screen.findByRole("button", { name: "Re-analyse" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Re-analyse" }),
    );
    await screen.findByText(/Re-analysing: 0 of 2 offers/);
    await server.runtime.analysis.pollBatches();

    batch.complete();
    await server.runtime.analysis.pollBatches();
    unreachable = true;
    await events.reconnect();

    await waitFor(() => expect(screen.queryByText(/Re-analysing/)).toBeNull());
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("keeps a started run's end when it is announced before the start is answered", async () => {
    const { server, batch } = await boot(2);
    await changeSettings(server, { model: "claude-sonnet-5-5", effort: "medium" });
    const events = fakeEventStream();
    const fetch = async (request: Request) => {
      const response = await server.fetch(request);
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/analysis/runs"))
        return response;
      await server.runtime.analysis.pollBatches();
      batch.complete();
      await server.runtime.analysis.pollBatches();
      await events.emit({
        type: "analysis-run-progress",
        data: {
          runId: 1,
          status: "succeeded",
          stopReason: null,
          done: 2,
          applied: 2,
          total: 2,
          spentUsd: 0.01,
        },
      });
      return response;
    };
    const { user } = renderDashboard(fetch, "/settings", events.stream);
    await openAdvanced(user);
    await user.click(await screen.findByRole("button", { name: "Re-analyse" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Re-analyse" }),
    );

    expect(await screen.findByText(/Re-analysis finished: 2 offers/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.queryByText(/Re-analysing/)).toBeNull();
  });

  it("shows the spend meter on Settings too", async () => {
    const { server } = await boot(1);
    await openSettings(server);

    const section = within(await screen.findByRole("region", { name: "Reading offers" }));

    expect(await section.findByRole("meter", { name: "Spend this month" })).toBeTruthy();
    expect(section.getByText(/of \$5\.00/)).toBeTruthy();
  });
});
