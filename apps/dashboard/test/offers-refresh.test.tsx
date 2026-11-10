// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { OfferSummary } from "../src/offers.js";
import { offer, serverWithOffers } from "./overview-harness.js";
import { fakeEventStream, renderDashboard } from "./render.js";

const list = () => within(screen.getByRole("region", { name: "Offers" }));
const rowCount = () => list().queryByRole("table")?.querySelectorAll("tbody > tr").length ?? 0;

function many(n: number): OfferSummary[] {
  return Array.from({ length: n }, (_, i) => offer({ id: 1000 + i, title: `Room ${i}` }));
}

async function openList(offers: OfferSummary[]) {
  const server = serverWithOffers(offers, { paged: true });
  const events = fakeEventStream();
  let gate: Promise<void> | undefined;
  const fetch = async (request: Request) => {
    const url = new URL(request.url);
    const firstPage = url.pathname === "/api/v1/offers" && !url.searchParams.has("cursor");
    if (firstPage && gate) await gate;
    return server.fetch(request);
  };
  const rendered = renderDashboard(fetch, "/offers/all", events.stream);
  await waitFor(() => expect(rowCount()).toBe(Math.min(50, offers.length)));
  const hold = () => {
    let release!: () => void;
    gate = new Promise((resolve) => {
      release = resolve;
    });
    return () => {
      gate = undefined;
      release();
    };
  };
  return { ...rendered, server, events, hold };
}

async function showMore(user: { click: (el: Element) => Promise<void> }, until: number) {
  while (rowCount() < until) {
    const before = rowCount();
    await user.click(list().getByRole("button", { name: "Show more" }));
    await waitFor(() => expect(rowCount()).toBeGreaterThan(before));
  }
}

describe("reading the Offers list again", () => {
  it("keeps every loaded row, past 200", async () => {
    const ctx = await openList(many(260));
    await showMore(ctx.user, 260);
    expect(list().queryByRole("button", { name: "Show more" })).toBeNull();
    const reads = ctx.server.listQueries.length;

    await ctx.events.reconnect();

    await waitFor(() => expect(ctx.server.listQueries.length).toBeGreaterThan(reads));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rowCount()).toBe(260);
    for (const query of ctx.server.listQueries) {
      expect(Number(query.get("limit"))).toBeLessThanOrEqual(200);
    }
  }, 30_000);

  it("keeps a page shown with Show more while a re-read was under way", async () => {
    const ctx = await openList(many(120));
    const release = ctx.hold();
    await ctx.events.reconnect();
    await ctx.user.click(list().getByRole("button", { name: "Show more" }));
    await waitFor(() => expect(rowCount()).toBe(100));

    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await waitFor(() => expect(rowCount()).toBe(100));
  });
});
