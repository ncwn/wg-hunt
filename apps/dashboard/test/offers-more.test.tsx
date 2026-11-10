// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { offer, serverWithOffers } from "./overview-harness.js";
import { renderDashboard } from "./render.js";

const list = () => within(screen.getByRole("region", { name: "Offers" }));
const rowCount = () => list().queryByRole("table")?.querySelectorAll("tbody > tr").length ?? 0;

describe("Show more on the Offers list", () => {
  it("is loading, not failed, while a failed page is tried again", async () => {
    const offers = Array.from({ length: 120 }, (_, i) =>
      offer({ id: 1000 + i, title: `Room ${i}` }),
    );
    const server = serverWithOffers(offers, { paged: true });
    let next: "refuse" | "hold" | "answer" = "refuse";
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { user } = renderDashboard(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/v1/offers" && url.searchParams.has("cursor")) {
        if (next === "refuse") {
          return new Response(JSON.stringify({ title: "Server error", status: 500 }), {
            status: 500,
            headers: { "Content-Type": "application/problem+json" },
          });
        }
        if (next === "hold") await held;
      }
      return server.fetch(request);
    }, "/offers/all");
    await waitFor(() => expect(rowCount()).toBe(50));

    await user.click(list().getByRole("button", { name: "Show more" }));
    expect(await list().findByText(/Couldn't load more offers/)).toBeTruthy();

    next = "hold";
    await user.click(list().getByRole("button", { name: "Show more" }));
    expect(list().getByRole("button", { name: "Loading…" })).toBeTruthy();
    expect(list().queryByText(/Couldn't load more offers/)).toBeNull();

    next = "answer";
    release();
    await waitFor(() => expect(rowCount()).toBe(100));
    expect(list().getByRole("button", { name: "Show more" })).toBeTruthy();
    expect(list().queryByText(/Couldn't load more offers/)).toBeNull();
  });
});
