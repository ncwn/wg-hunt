// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fakeBatchProvider,
  fakeProvider,
  outputWith,
} from "../../../packages/core/src/analysis/testing.js";
import {
  driveCrawl,
  fakeSource,
  MINUTE,
  MORNING,
  offerPageWith,
  relaxCaps,
} from "../../server/test/offers-harness.js";
import {
  choose,
  detail,
  limitRent,
  openOffers,
  rowOf,
  type Server,
  THREE,
  titleLink,
  titles,
} from "./offers-page-harness.js";
import { offer, serverWithOffers } from "./overview-harness.js";
import { realServer } from "./real-server.js";
import { fakeEventStream, renderDashboard } from "./render.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

const headTag = () => document.querySelector(".wh-offer-head .wh-tag")?.textContent;

function elsewhere(server: Server, events: ReturnType<typeof fakeEventStream>) {
  const cheap = async () =>
    (await (await server.call("GET", "/offers?includeHidden=true")).json()).items.find(
      (o: { title: string }) => o.title === "Cheap room",
    );
  return {
    async limitTo(limit: number) {
      const filters = await (await server.call("GET", "/filters")).json();
      filters.maxRent.limit = limit;
      await server.call("PUT", "/filters", filters);
    },
    async dismiss() {
      await server.call("PATCH", `/offers/${(await cheap()).id}/marks`, { dismissed: true });
    },
    async announce() {
      const now = await cheap();
      await events.emit({
        type: "offer-band-changed",
        data: { offerId: now.id, band: now.band, bandChangedAt: now.bandChangedAt },
      });
    },
  };
}

describe("the open Offer", () => {
  it("follows a band change made elsewhere, with its chips and marks", async () => {
    const { user, server, events } = await openOffers(THREE, "/offers/all", ({ server }) =>
      limitRent(server),
    );
    await choose(user, "Cheap room");
    await waitFor(() => expect(headTag()).toBe("Match"));
    expect(detail().queryByRole("group", { name: "How it fits you" })).toBeNull();
    const change = elsewhere(server, events);

    await change.limitTo(420);
    await change.announce();
    await waitFor(() => expect(headTag()).toBe("Near match"));
    expect(detail().getByRole("group", { name: "How it fits you" })).toBeTruthy();

    await change.dismiss();
    await change.announce();
    await waitFor(() => expect(headTag()).toBe("Hidden"));
    expect(
      detail().getByRole("button", { name: "Undo: not for me" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(detail().getByText(/^Hidden: you marked it not for me/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the latest band when an earlier read answers last", async () => {
    let hold = false;
    let held = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { user, server, events } = await openOffers(
      THREE,
      "/offers/all",
      ({ server }) => limitRent(server),
      (fetch) => async (request) => {
        const response = await fetch(request);
        if (hold && !held && /\/offers\/\d+$/.test(new URL(request.url).pathname)) {
          held = true;
          await gate;
        }
        return response;
      },
    );
    await choose(user, "Cheap room");
    await waitFor(() => expect(headTag()).toBe("Match"));
    const change = elsewhere(server, events);

    hold = true;
    await change.limitTo(420);
    await change.announce();
    await waitFor(() => expect(held).toBe(true));
    await change.dismiss();
    await change.announce();
    await waitFor(() => expect(headTag()).toBe("Hidden"));

    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(headTag()).toBe("Hidden");
  });

  it("keeps a band change read while the card's first read was still on its way", async () => {
    let hold = false;
    let held = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { user, server, events } = await openOffers(
      THREE,
      "/offers/all",
      ({ server }) => limitRent(server),
      (fetch) => async (request) => {
        const response = await fetch(request);
        if (hold && !held && /\/offers\/\d+$/.test(new URL(request.url).pathname)) {
          held = true;
          await gate;
        }
        return response;
      },
    );
    await waitFor(() => rowOf("Cheap room"));
    const change = elsewhere(server, events);

    hold = true;
    await user.click(titleLink("Cheap room"));
    await waitFor(() => expect(held).toBe(true));
    await change.limitTo(420);
    await change.announce();
    await waitFor(() => expect(headTag()).toBe("Near match"));

    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(headTag()).toBe("Near match");
  });
});

describe("the Offers list", () => {
  it("keeps an Offer announced while it is being read again", async () => {
    const offers = [1, 2, 3].map((id) => offer({ id, title: `Room ${id}` }));
    const server = serverWithOffers(offers, { paged: true });
    let hold = false;
    let held = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = async (request: Request) => {
      const response = await server.fetch(request);
      const url = new URL(request.url);
      if (hold && !held && url.pathname === "/api/v1/offers" && request.method === "GET") {
        held = true;
        await gate;
      }
      return response;
    };
    const events = fakeEventStream();
    renderDashboard(fetch, "/offers/all", events.stream);
    await waitFor(() => expect(titles()).toHaveLength(3));

    hold = true;
    await events.reconnect();
    await waitFor(() => expect(held).toBe(true));
    const fresh = offer({ id: 4, title: "Fresh room" });
    offers.push(fresh);
    await events.emit({ type: "offer-added", data: fresh });
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(titles()).toHaveLength(4);
    expect(titles()).toContain("Fresh room");
  });
});

async function openWhileReading() {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const realtime = fakeProvider([outputWith({})]);
  const source = fakeSource();
  const clock = { now: MORNING };
  const server = realServer({
    fetcher: source.fetcher,
    clock: () => clock.now,
    analysis: {
      providerFor: () => ({
        analyse: async (request) => {
          await gate;
          return realtime.provider.analyse(request);
        },
      }),
      batchProviderFor: () => fakeBatchProvider([outputWith({})]).provider,
      sleep: async () => {},
    },
  });
  await server.signIn();
  relaxCaps(server.runtime, clock.now);
  await server.call("PUT", "/secrets/anthropic", {
    value: "sk-ant-api03-open-views-key-0123456789",
  });
  source.site.cards = THREE.map(({ id, title }) => ({ id, age: "5 Min.", title }));
  for (const ad of THREE) source.site.pages.set(ad.id, offerPageWith(ad));
  await server.call("POST", "/searches", { city: "Berlin", categories: ["flatshare-room"] });
  await driveCrawl(server.runtime, clock, clock.now + 4 * 60 * MINUTE);
  vi.setSystemTime(clock.now);
  const listed = (await (await server.call("GET", "/offers")).json()).items as {
    title: string;
    analysisStatus: { status: string };
  }[];
  const queued = listed.find((each) => each.analysisStatus.status === "queued")?.title;
  if (queued === undefined) throw new Error("no Offer is queued");
  const events = fakeEventStream();
  const requests: string[] = [];
  let listedNow: typeof listed = [];
  const fetch = async (request: Request) => {
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    const response = await server.fetch(request);
    if (request.method === "GET" && path === "/api/v1/offers")
      listedNow = (await response.clone().json()).items;
    return response;
  };
  const rendered = renderDashboard(fetch, "/offers/all", events.stream);
  await waitFor(() => expect(titles()).toHaveLength(3));
  // Rows show no analysis wording, so the list's copy is read from what it was answered.
  const statusOf = (title: string) =>
    listedNow.find((each) => each.title === title)?.analysisStatus.status;
  const lowerCap = async () => {
    const settings = await (await server.call("GET", "/settings/analysis")).json();
    await server.call("PUT", "/settings/analysis", { ...settings, monthlySpendCapUsd: 0 });
  };
  const announce = async () =>
    events.emit({
      type: "analysis-status-changed",
      data: await (await server.call("GET", "/analysis")).json(),
    });
  return { ...rendered, server, events, requests, queued, statusOf, release, lowerCap, announce };
}

describe("a change to what every Offer's analysis status depends on", () => {
  it("reads the open Offer again, so its note follows a cap lowered in another tab", async () => {
    const { user, queued, release, lowerCap, announce } = await openWhileReading();
    await choose(user, queued);
    expect(await detail().findByText("Queued to be read.")).toBeTruthy();

    await lowerCap();
    await announce();

    expect(await detail().findByText(/the monthly limit is reached/)).toBeTruthy();
    release();
  });

  it("reads the list again once for a burst, keeping its rows meanwhile", async () => {
    const { requests, queued, statusOf, release, lowerCap, announce } = await openWhileReading();
    const lists = () => requests.filter((r) => r === "GET /api/v1/offers").length;
    const before = lists();
    expect(statusOf(queued)).toBe("queued");

    await lowerCap();
    await announce();
    await announce();
    await announce();
    expect(titles()).toHaveLength(3);

    await waitFor(() => expect(lists()).toBe(before + 1));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(lists()).toBe(before + 1);
    expect(titles()).toHaveLength(3);
    expect(statusOf(queued)).toBe("waiting-for-cap");
    release();
  });
});

async function editBerlin() {
  const server = realServer();
  await server.signIn();
  await server.call("POST", "/searches", {
    city: "Berlin",
    categories: ["one-room-flat", "flatshare-room"],
  });
  const patches: unknown[] = [];
  const fetch = async (request: Request) => {
    if (request.method === "PATCH") patches.push(await request.clone().json());
    return server.fetch(request);
  };
  const { user } = renderDashboard(fetch, "/searches");
  await user.click(await screen.findByRole("button", { name: "Edit Berlin" }));
  return { user, server, patches };
}

describe("the Search form", () => {
  it("sends only what the seeker changed, so a change made elsewhere survives", async () => {
    const { user, server, patches } = await editBerlin();
    await server.call("PATCH", "/searches/1", { recencyDays: 3 });

    await user.type(screen.getByLabelText("Most you'll pay, warm"), "800");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const card = await screen.findByRole("article", { name: /in Berlin/ });
    await waitFor(() => expect(screen.queryByLabelText("City")).toBeNull());
    expect(patches).toEqual([{ priceCeiling: 800 }]);
    expect(within(card).getByText(/last 3 days/)).toBeTruthy();
  });

  it("sends nothing when nothing changed, and closes as Cancel does", async () => {
    const { user, server, patches } = await editBerlin();
    const updatedAt = async () =>
      (await (await server.call("GET", "/searches")).json()).items[0].updatedAt;
    const before = await updatedAt();

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByLabelText("City")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Edit Berlin" }));
    await user.click(screen.getByRole("checkbox", { name: "House" }));
    await user.click(screen.getByRole("checkbox", { name: "House" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByLabelText("City")).toBeNull());

    expect(patches).toEqual([]);
    expect(before).toEqual(expect.any(String));
    expect(await updatedAt()).toBe(before);
  });
});
