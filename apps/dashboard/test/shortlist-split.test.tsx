// @vitest-environment jsdom
import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { limitRent, openOffers, titles } from "./offers-page-harness.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const TWINS = [
  { id: 9000001, title: "Cheap room", warmRent: 450 },
  { id: 9000002, title: "Cheap twin", warmRent: 460 },
];

describe("the Shortlisted view, live", () => {
  it("lists a shortlisted room split off elsewhere (CLI, API), as the server's shortlist does", async () => {
    let roomId = 0;
    const ctx = await openOffers(TWINS, "/offers/shortlisted", async ({ server }) => {
      await limitRent(server);
      const items = (await (await server.call("GET", "/offers")).json()).items as {
        id: number;
        title: string;
      }[];
      const [a, b] = items.map((item) => item.id).sort((x, y) => x - y) as [number, number];
      expect((await server.call("POST", `/offers/${a}/merge`, { offerId: b })).status).toBe(200);
      expect((await server.call("PATCH", `/offers/${a}/marks`, { shortlisted: true })).status).toBe(
        200,
      );
      roomId = a;
    });
    // The page's stream carries what the server publishes from here on.
    ctx.server.runtime.events.subscribe((event) => {
      void ctx.events.emit(JSON.parse(JSON.stringify(event)));
    });
    await waitFor(() => expect(titles()).toHaveLength(1));

    const split = await act(() =>
      ctx.server.call("POST", `/offers/${roomId}/split`, { adId: "9000002" }),
    );
    expect(split.status).toBe(201);

    const shortlist = (await (await ctx.server.call("GET", "/offers?shortlisted=true")).json())
      .items as { title: string }[];
    expect(shortlist.map((item) => item.title).sort()).toEqual(["Cheap room", "Cheap twin"]);

    // Past the 300 ms a burst of events is given to settle.
    await act(() => new Promise((resolve) => setTimeout(resolve, 1000)));
    expect(titles().sort()).toEqual(["Cheap room", "Cheap twin"]);
  });
});
