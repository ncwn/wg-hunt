// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { choose } from "./choose.js";
import { crawlStatus, fakeServer } from "./fake-server.js";
import { realServer } from "./real-server.js";
import { renderDashboard } from "./render.js";

async function openSettings(server = realServer({ signedIn: true })) {
  await server.ready;
  const { user } = renderDashboard(server.fetch, "/settings");
  await screen.findByRole("heading", { level: 1, name: "Settings" });
  const card = (name: string) => within(screen.getByRole("region", { name }));
  return { server, user, card };
}

const stored = async (server: ReturnType<typeof realServer>, path: string) =>
  (await server.asCli(path)).json();

describe("Settings: what a seeker changes", () => {
  it("pauses and resumes the hunt with Keep hunting", async () => {
    const { server, user } = await openSettings();
    const toggle = await screen.findByRole("switch", { name: "Keep hunting" });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));

    await user.click(toggle);
    await waitFor(async () => expect((await stored(server, "/crawl")).state).toBe("paused"));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));

    await user.click(toggle);
    await waitFor(async () => expect((await stored(server, "/crawl")).state).not.toBe("paused"));
  });

  it("can switch hunting off during a break, but can't cut the break short", async () => {
    const server = fakeServer({
      signedIn: true,
      crawl: crawlStatus({
        state: "cooling-down",
        cooldown: { until: "2026-06-10T14:20:00.000Z", level: 1, needsResume: false },
      }),
    });
    const { user } = renderDashboard(server.fetch, "/settings");
    const toggle = (await screen.findByRole("switch", {
      name: "Keep hunting",
    })) as HTMLButtonElement;
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(toggle.disabled).toBe(false);
    expect(screen.getByText(/taking a short break/)).toBeTruthy();

    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(server.state.requests).toContain("POST /api/v1/crawl/pause");
    expect(toggle.disabled).toBe(true);
    expect(screen.getByText(/It stays paused after that until you resume it/)).toBeTruthy();
  });

  it("saves quiet hours as the night around the active hours", async () => {
    const { server, user } = await openSettings();
    const from = await screen.findByLabelText("Quiet hours start");
    await waitFor(() => expect(from.getAttribute("data-value")).toBe("23:30"));
    expect(screen.getByLabelText("Quiet hours end").getAttribute("data-value")).toBe("07:00");

    await choose(user, from, "22:00");

    await waitFor(async () =>
      expect((await stored(server, "/settings/crawl")).pacing.activeHours).toEqual({
        start: "07:00",
        end: "22:00",
      }),
    );
  });

  it("keeps both changes when the pace is picked before the quiet hours are saved", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = true;
    const puts: string[] = [];
    const fetch = async (request: Request) => {
      if (request.method === "PUT" && new URL(request.url).pathname.endsWith("/settings/crawl")) {
        puts.push(await request.clone().text());
        if (holding) {
          holding = false;
          await held;
        }
      }
      return server.fetch(request);
    };
    const { user } = renderDashboard(fetch, "/settings");
    const from = await screen.findByLabelText("Quiet hours start");
    await waitFor(() => expect(from.getAttribute("data-value")).toBe("23:30"));

    await choose(user, from, "22:00");
    await waitFor(() => expect(puts).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Gently" }));
    expect(puts).toHaveLength(1);
    release();

    await waitFor(() => expect(puts).toHaveLength(2));
    await waitFor(async () =>
      expect((await stored(server, "/settings/crawl")).pacing).toMatchObject({
        activeHours: { start: "07:00", end: "22:00" },
        gapMinSeconds: 30,
        hourlyCap: 15,
      }),
    );
  });

  it("maps How often to look onto the pacing settings", async () => {
    const { server, user } = await openSettings();
    const normal = await screen.findByRole("button", { name: "Normal" });
    await waitFor(() => expect(normal.getAttribute("aria-pressed")).toBe("true"));

    await user.click(screen.getByRole("button", { name: "Gently" }));

    await waitFor(async () =>
      expect((await stored(server, "/settings/crawl")).pacing).toMatchObject({
        gapMinSeconds: 30,
        gapMaxSeconds: 90,
        hourlyCap: 15,
        dailyCap: 150,
      }),
    );
    expect(screen.getByRole("button", { name: "Gently" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("hides likely scams through the Filters", async () => {
    const { server, user } = await openSettings();
    const toggle = await screen.findByRole("switch", { name: "Hide likely scams" });
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
    const before = (await stored(server, "/filters")).hideLikelyScams.enabled;
    expect(toggle.getAttribute("aria-checked")).toBe(String(before));

    await user.click(toggle);

    await waitFor(async () =>
      expect((await stored(server, "/filters")).hideLikelyScams.enabled).toBe(!before),
    );
    expect(toggle.getAttribute("aria-checked")).toBe(String(!before));
  });

  it("says in words when there is no key, and says the limit is in US dollars", async () => {
    const { card } = await openSettings();
    expect(await screen.findByText(/Add a key so wg-hunt can read ads/)).toBeTruthy();
    expect(card("Reading offers").getByText("$")).toBeTruthy();
    expect(card("Reading offers").getByText("No ads waiting.")).toBeTruthy();
  });

  it("sends /crawl to Settings, where the Crawl page now lives under Advanced", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    renderDashboard(server.fetch, "/crawl");
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Crawl pacing and activity/ })).toBeNull();
  });
});
