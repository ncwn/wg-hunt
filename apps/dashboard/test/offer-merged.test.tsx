// @vitest-environment jsdom

import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { choose, detail, openOffers, type Server } from "./offers-page-harness.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

async function mergeDearIntoCheap(server: Server) {
  const items = (await (await server.call("GET", "/offers?includeHidden=true")).json()).items;
  const idOf = (title: string): number =>
    items.find((item: { title: string }) => item.title === title).id;
  const [cheap, dear] = [idOf("Cheap room"), idOf("Dear room")];
  const merged = await server.call("POST", `/offers/${cheap}/merge`, { offerId: dear });
  expect(merged.status).toBe(200);
  const survivor: { title: string } = await merged.json();
  return { cheap, dear, title: survivor.title };
}

describe("an Offer merged into another", () => {
  it("opened by its old id, points at the Offer it went into, and the link opens that one", async () => {
    let ids: Awaited<ReturnType<typeof mergeDearIntoCheap>> | undefined;
    const ctx = await openOffers(undefined, undefined, async ({ server }) => {
      ids = await mergeDearIntoCheap(server);
      return `/offers/all?offer=${ids.dear}`;
    });
    const { cheap, title } = ids as NonNullable<typeof ids>;

    const link = await detail().findByRole("link", { name: title });
    expect(detail().getByText(/merged into/)).toBeTruthy();
    expect(detail().queryByText(/isn't known/)).toBeNull();
    expect(link.getAttribute("href")).toBe(`/offers/all?offer=${cheap}`);

    await ctx.user.click(link);
    expect(await detail().findByRole("heading", { level: 2, name: title })).toBeTruthy();
    expect(ctx.location().pathname).toBe("/offers/all");
    expect(ctx.location().search).toBe(`?offer=${cheap}`);
    await ctx.back();
    expect(ctx.location().search).toBe(`?offer=${cheap}`);
  });

  it("while open, turns into the same pointer when the server announces the merge", async () => {
    const ctx = await openOffers();
    await choose(ctx.user, "Dear room");
    await detail().findByRole("heading", { level: 2, name: "Dear room" });

    const { cheap, dear, title } = await mergeDearIntoCheap(ctx.server);
    ctx.events.emit({ type: "offer-merged", data: { offerId: dear, mergedInto: cheap } });

    const link = await detail().findByRole("link", { name: title });
    expect(detail().queryByRole("article")).toBeNull();
    expect(link.getAttribute("href")).toBe(`/offers/all?offer=${cheap}`);
    await ctx.user.click(link);
    expect(await detail().findByRole("heading", { level: 2, name: title })).toBeTruthy();
    expect(ctx.location().search).toBe(`?offer=${cheap}`);
  });

  it("stays a pointer when a read sent before the merge answers after it", async () => {
    let held: { id: number; until: Promise<void> } | undefined;
    const ctx = await openOffers(undefined, undefined, undefined, (fetch) => async (request) => {
      const response = await fetch(request);
      const gate = held;
      if (gate && request.method === "GET" && request.url.endsWith(`/offers/${gate.id}`)) {
        await gate.until;
      }
      return response;
    });
    await choose(ctx.user, "Dear room");
    await detail().findByRole("heading", { level: 2, name: "Dear room" });

    const dearId = Number(new URLSearchParams(ctx.location().search).get("offer"));
    let release = () => {};
    held = { id: dearId, until: new Promise<void>((resolve) => (release = resolve)) };
    await ctx.events.reconnect();
    await waitFor(() =>
      expect(ctx.requests.filter((r) => /^GET \/api\/v1\/offers\/\d+$/.test(r))).toHaveLength(2),
    );
    const { cheap, dear, title } = await mergeDearIntoCheap(ctx.server);
    ctx.events.emit({ type: "offer-merged", data: { offerId: dear, mergedInto: cheap } });
    await detail().findByRole("link", { name: title });

    held = undefined;
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(detail().getByRole("link", { name: title })).toBeTruthy();
    expect(detail().queryByRole("article")).toBeNull();
  });

  it("leaves another Offer's merge alone", async () => {
    const ctx = await openOffers();
    await choose(ctx.user, "Dearest room");
    const { cheap, dear } = await mergeDearIntoCheap(ctx.server);
    ctx.events.emit({ type: "offer-merged", data: { offerId: dear, mergedInto: cheap } });

    await waitFor(() => expect(detail().queryByText(/merged into/)).toBeNull());
    expect(detail().getByRole("heading", { level: 2, name: "Dearest room" })).toBeTruthy();
  });
});

describe("an Offer id nobody knows", () => {
  it("still says the offer isn't known, with nothing to follow", async () => {
    await openOffers(undefined, "/offers/all?offer=999");

    expect(
      await screen.findByText("That offer isn't known. It may have been removed."),
    ).toBeTruthy();
    expect(detail().queryByRole("link")).toBeNull();
    expect(detail().queryByRole("button", { name: "Try again" })).toBeNull();
  });
});
