// @vitest-environment jsdom
import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ANALYSIS_RETRY_MS } from "../src/analysis.js";
import { openAdvanced } from "./advanced.js";
import { realServer } from "./real-server.js";
import { renderDashboard } from "./render.js";

const refusal = () =>
  new Response(
    JSON.stringify({ type: "internal-error", title: "Internal server error", status: 500 }),
    { status: 500, headers: { "Content-Type": "application/problem+json" } },
  );

async function openSettings(path: string, how: "refuse" | "hold" = "refuse") {
  const server = realServer({ signedIn: true });
  await server.ready;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let blocked = true;
  const fetch = async (request: Request) => {
    if (request.method === "GET" && new URL(request.url).pathname === `/api/v1${path}` && blocked) {
      if (how === "refuse") return refusal();
      await held;
    }
    return server.fetch(request);
  };
  const { user } = renderDashboard(fetch, "/settings");
  await screen.findByRole("heading", { level: 1, name: "Settings" });
  const card = (name: string) => within(screen.getByRole("region", { name }));
  return {
    user,
    card,
    release: () => {
      blocked = false;
      release();
    },
  };
}

const paces = () =>
  ["Gently", "Normal", "Eager"].map(
    (name) => screen.getByRole("button", { name }) as HTMLButtonElement,
  );

describe("Settings: a read that fails can be tried again", () => {
  it("shows no pace while the hunting times load, and can't be clicked", async () => {
    const { release } = await openSettings("/settings/crawl", "hold");
    await screen.findByRole("button", { name: "Normal" });
    for (const pace of paces()) {
      expect(pace.getAttribute("aria-pressed")).toBe("false");
      expect(pace.disabled).toBe(true);
    }
    release();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Normal" }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
    for (const pace of paces()) expect(pace.disabled).toBe(false);
  });

  it("loads the hunting times again on Try again", async () => {
    const { user, card, release } = await openSettings("/settings/crawl");
    const hunting = card("Hunting");
    expect((await hunting.findByRole("alert")).textContent).toMatch(
      /Couldn't load the hunting times: Internal server error/,
    );
    for (const pace of paces()) {
      expect(pace.getAttribute("aria-pressed")).toBe("false");
      expect(pace.disabled).toBe(true);
    }

    release();
    await user.click(hunting.getByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Normal" }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
    expect(hunting.queryByRole("alert")).toBeNull();
    expect(
      (screen.getByLabelText("Quiet hours start") as HTMLElement).getAttribute("data-value"),
    ).toBe("23:30");
  });

  it("loads the Filters again on Try again, and Hide likely scams comes on", async () => {
    const { user, card, release } = await openSettings("/filters");
    const reading = card("Reading offers");
    expect((await reading.findByRole("alert")).textContent).toMatch(
      /Couldn't load the Filters: Internal server error/,
    );
    const toggle = reading.getByRole("switch", { name: "Hide likely scams" }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);

    release();
    await user.click(reading.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(toggle.disabled).toBe(false));
    expect(reading.queryByRole("alert")).toBeNull();
  });

  it("says the reading status couldn't be read, and fills the page on Try again", async () => {
    const { user, card, release } = await openSettings("/analysis");
    const reading = card("Reading offers");
    expect((await reading.findByRole("alert")).textContent).toMatch(
      /Couldn't load the reading status: Internal server error/,
    );
    expect(reading.queryByText("Reading ads")).toBeNull();

    release();
    await user.click(reading.getByRole("button", { name: "Try again" }));

    expect(await reading.findByText("No ads waiting.")).toBeTruthy();
    expect(reading.queryByRole("alert")).toBeNull();
  });

  it("asks for a reading status that couldn't be read again by itself", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const { card, release } = await openSettings("/analysis");
      const reading = card("Reading offers");
      await reading.findByRole("alert");
      release();
      await act(() => vi.advanceTimersByTimeAsync(ANALYSIS_RETRY_MS));
      expect(await reading.findByText("No ads waiting.")).toBeTruthy();
      expect(reading.queryByRole("alert")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("loads the reading model again on Try again", async () => {
    const { user, release } = await openSettings("/settings/analysis");
    await openAdvanced(user);
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Couldn't load the reading model: Internal server error/,
    );

    release();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { level: 3, name: "Reading model" })).toBeTruthy();
    expect(await screen.findByLabelText("Model")).toBeTruthy();
    expect(screen.queryByText(/Couldn't load the reading model/)).toBeNull();
  });
});
