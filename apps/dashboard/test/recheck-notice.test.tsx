// @vitest-environment jsdom
import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { driveCrawl, MINUTE } from "../../server/test/offers-harness.js";
import { type Offer, RECHECK_POLL_MS } from "../src/offers.js";
import { formatWhen } from "../src/searches.js";
import { choose, detail, openOffers } from "./offers-page-harness.js";

type Recheck = Offer["recheck"];

const PARK = { id: 9000001, title: "Zimmer am Park", warmRent: 450 };
const KANAL = { id: 9000002, title: "Zimmer am Kanal", warmRent: 480 };

const QUEUED = /Queued\. Rechecks go last/;
const RUNNING = /Rechecking: fetching the ad's page now/;

const offerRead = (request: Request) =>
  request.method === "GET" && /\/offers\/\d+$/.test(new URL(request.url).pathname);
const offerIdOf = (request: Request) => Number(new URL(request.url).pathname.split("/").pop());

const recheckAs =
  (next: (id: number) => Partial<Recheck> | undefined) =>
  (fetch: (request: Request) => Promise<Response>) =>
  async (request: Request) => {
    const answer = await fetch(request);
    if (!offerRead(request) || !answer.ok) return answer;
    const change = next(offerIdOf(request));
    if (change === undefined) return answer;
    const offer = (await answer.json()) as Offer;
    return Response.json({ ...offer, recheck: { ...offer.recheck, ...change } });
  };

const readsOf = (requests: string[], id: number) =>
  requests.filter((line) => line === `GET /api/v1/offers/${id}`).length;

const idOf = async (server: { call: (m: string, p: string) => Promise<Response> }, t: string) =>
  (
    (await (await server.call("GET", "/offers?includeHidden=true")).json()).items as {
      id: number;
      title: string;
    }[]
  ).find((item) => item.title === t)?.id as number;

async function pollFor(times: number) {
  for (let i = 0; i < times; i++) {
    await act(() => vi.advanceTimersByTimeAsync(RECHECK_POLL_MS));
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the Recheck notice", () => {
  it("follows the Recheck from queued through in-flight to cleared, then stops reading", async () => {
    const script: Partial<Recheck>[] = [];
    let last: Partial<Recheck> | undefined;
    const { user, requests, server } = await openOffers([PARK], "/offers/all", undefined, (fetch) =>
      recheckAs(() => {
        last = script.shift() ?? last;
        return last;
      })(fetch),
    );
    const id = await idOf(server, PARK.title);
    await choose(user, PARK.title);
    const button = await detail().findByRole("button", { name: "Recheck" });
    expect(detail().queryByText(QUEUED)).toBeNull();

    script.push(
      { state: "queued", manual: true },
      { state: "in-flight", manual: true },
      { state: "idle", manual: false },
    );
    await user.click(button);
    expect(await detail().findByText(QUEUED)).toBeTruthy();

    await pollFor(1);
    expect(await detail().findByText(RUNNING)).toBeTruthy();
    expect(detail().queryByText(QUEUED)).toBeNull();

    await pollFor(1);
    await waitFor(() => expect(detail().queryByText(RUNNING)).toBeNull());
    expect(detail().queryByText(QUEUED)).toBeNull();

    const reads = readsOf(requests, id);
    await pollFor(4);
    expect(readsOf(requests, id)).toBe(reads);
  });

  it("clears once the Recheck is done even though the page came back unchanged", async () => {
    const { user, server, clock, requests } = await openOffers([PARK]);
    const id = await idOf(server, PARK.title);
    const before = (await (await server.call("GET", `/offers/${id}`)).json()) as Offer;
    await choose(user, PARK.title);

    await user.click(await detail().findByRole("button", { name: "Recheck" }));
    expect(await detail().findByText(QUEUED)).toBeTruthy();

    // It stops as soon as the Recheck is done, before a later poll of the Search could move the Bump.
    let after = before;
    for (let minute = 1; minute <= 60; minute++) {
      await driveCrawl(server.runtime, clock, clock.now + MINUTE);
      after = (await (await server.call("GET", `/offers/${id}`)).json()) as Offer;
      if (after.recheck.state !== "queued" && after.recheck.state !== "in-flight") break;
    }
    expect(after.recheck.state).toBe("idle");
    expect(after.recheck.pageFetchedAt).not.toBe(before.recheck.pageFetchedAt);
    expect(after.ads.map((ad) => ad.textHash)).toEqual(before.ads.map((ad) => ad.textHash));
    expect(after.lastBumpAt).toBe(before.lastBumpAt);

    await pollFor(1);
    await waitFor(() => expect(detail().queryByText(QUEUED)).toBeNull());
    const reads = readsOf(requests, id);
    await pollFor(3);
    expect(readsOf(requests, id)).toBe(reads);
  });

  it("raises an alarm with the time automatic Rechecks hold off until, when the last one got no usable page", async () => {
    const retryAfter = new Date(Date.now() + 6 * 60 * MINUTE).toISOString();
    const { user } = await openOffers([PARK], "/offers/all", undefined, (fetch) =>
      recheckAs(() => ({
        state: "failed",
        manual: false,
        lastFailedAt: new Date().toISOString(),
        retryAfter,
      }))(fetch),
    );
    await choose(user, PARK.title);

    const alarm = await detail().findByRole("alert");
    expect(alarm.textContent).toContain("The last Recheck got no usable page.");
    expect(alarm.textContent).toContain(`No automatic Recheck before ${formatWhen(retryAfter)}.`);
  });

  it("shows a Recheck already queued when the pane opens, without pressing anything", async () => {
    const { user } = await openOffers([PARK], "/offers/all", async ({ server }) => {
      const id = await idOf(server, PARK.title);
      await server.call("POST", `/offers/${id}/recheck`);
    });
    await choose(user, PARK.title);

    expect(await detail().findByText(QUEUED)).toBeTruthy();
  });

  it("stops reading the Offer once another one is opened, or the pane goes", async () => {
    let parkId = 0;
    const { user, server, requests, unmount } = await openOffers(
      [PARK, KANAL],
      "/offers/all",
      undefined,
      (fetch) =>
        recheckAs((id) => (id === parkId ? { state: "queued", manual: true } : undefined))(fetch),
    );
    parkId = await idOf(server, PARK.title);
    await choose(user, PARK.title);
    expect(await detail().findByText(QUEUED)).toBeTruthy();
    await pollFor(1);
    expect(readsOf(requests, parkId)).toBeGreaterThan(1);

    await choose(user, KANAL.title);
    await waitFor(() => expect(detail().queryByText(QUEUED)).toBeNull());
    const afterSwitch = readsOf(requests, parkId);
    await pollFor(3);
    expect(readsOf(requests, parkId)).toBe(afterSwitch);

    await choose(user, PARK.title);
    expect(await detail().findByText(QUEUED)).toBeTruthy();
    unmount();
    const afterUnmount = readsOf(requests, parkId);
    await pollFor(3);
    expect(readsOf(requests, parkId)).toBe(afterUnmount);
  });
});
