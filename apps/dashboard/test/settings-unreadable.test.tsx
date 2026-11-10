// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSetting, putSetting } from "../../server/src/db/settings.js";
import { realServer } from "./real-server.js";
import { liveFrom, renderDashboard } from "./render.js";

type Server = ReturnType<typeof realServer>;
// biome-ignore lint/suspicious/noExplicitAny: each test breaks its own document
type Json = any;

beforeEach(() => {
  // The server logs each unreadable field.
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const stored = async (server: Server, path: string): Promise<Json> =>
  (await server.asCli(path)).json();

async function plant(server: Server, path: string, key: string, change: (doc: Json) => void) {
  const { constants: _c, ...doc } = await stored(server, path);
  change(doc);
  putSetting(server.runtime.db, key, JSON.stringify(doc));
}

async function openSettings(server: Server) {
  const events = liveFrom(server);
  const { user } = renderDashboard(server.fetch, "/settings", events.stream);
  await screen.findByRole("heading", { level: 1, name: "Settings" });
  const card = (name: string) => within(screen.getByRole("region", { name }));
  const publishCrawl = async () =>
    events.emit({ type: "crawl-status-changed", data: await stored(server, "/crawl") });
  return { user, card, publishCrawl };
}

const UNREADABLE = /couldn't be read/;

describe("Settings: saved settings that no longer parse", () => {
  it("names the reading settings that went back to their default until a save", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    await plant(server, "/settings/analysis", "analysis", (doc) => {
      doc.monthlySpendCapUsd = 1;
      doc.effort = "extreme";
    });
    const { user, card } = await openSettings(server);

    const notice = await card("Reading offers").findByText(UNREADABLE);
    expect(notice.textContent).toContain("Effort");
    expect(notice.textContent).not.toContain("Monthly limit");
    const limit = (await card("Reading offers").findByLabelText(
      "Monthly limit for reading offers",
    )) as HTMLInputElement;
    expect(limit.value).toBe("1");
    expect(card("Hunting").queryByText(UNREADABLE)).toBeNull();

    await screen.findByText(/used this month/);
    await user.clear(limit);
    await user.type(limit, "2");
    await user.tab();

    await waitFor(() => expect(card("Reading offers").queryByText(UNREADABLE)).toBeNull());
    expect((await stored(server, "/analysis")).settings.source).toBe("saved");
  });

  it("ends the reading settings' notice when they are saved elsewhere", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    await plant(server, "/settings/analysis", "analysis", (doc) => {
      doc.effort = "extreme";
    });
    const { card } = await openSettings(server);
    await card("Reading offers").findByText(UNREADABLE);

    const saved = await server.asCli("/settings/analysis", {
      method: "PUT",
      body: JSON.stringify(await stored(server, "/settings/analysis")),
    });

    expect(saved.status).toBe(200);
    await waitFor(() => expect(card("Reading offers").queryByText(UNREADABLE)).toBeNull());
  });

  it("names the hunting settings that went back to their default until a save", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    await plant(server, "/settings/crawl", "crawl.settings", (doc) => {
      doc.recheck.maxPageAgeHours = 0;
    });
    const { user, card, publishCrawl } = await openSettings(server);

    const notice = await card("Hunting").findByText(UNREADABLE);
    expect(notice.textContent).toContain("Recheck pages older than");
    expect(card("Reading offers").queryByText(UNREADABLE)).toBeNull();

    await user.click(await screen.findByRole("button", { name: "Gently" }));
    await waitFor(async () =>
      expect((await stored(server, "/crawl")).settings.source).toBe("saved"),
    );
    await publishCrawl();

    await waitFor(() => expect(card("Hunting").queryByText(UNREADABLE)).toBeNull());
  });

  it("keeps the hunting settings as they are now", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    await plant(server, "/settings/crawl", "crawl.settings", (doc) => {
      doc.pacing.dailyCap = 120;
      doc.pacing.sessionSize = "many";
    });
    const { user, card, publishCrawl } = await openSettings(server);
    await card("Hunting").findByText(UNREADABLE);

    await user.click(card("Hunting").getByRole("button", { name: "Keep these settings" }));
    await waitFor(async () =>
      expect((await stored(server, "/crawl")).settings.source).toBe("saved"),
    );
    await publishCrawl();

    await waitFor(() => expect(card("Hunting").queryByText(UNREADABLE)).toBeNull());
    const row = JSON.parse(getSetting(server.runtime.db, "crawl.settings")?.value ?? "null");
    expect(row.pacing).toMatchObject({ dailyCap: 120, sessionSize: 15 });
    expect(row).not.toHaveProperty("constants");
  });

  it("keeps the reading settings as they are now", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    await plant(server, "/settings/analysis", "analysis", (doc) => {
      doc.monthlySpendCapUsd = 1;
      doc.batchOnly = "yes";
    });
    const { user, card } = await openSettings(server);
    await card("Reading offers").findByText(UNREADABLE);

    await user.click(card("Reading offers").getByRole("button", { name: "Keep these settings" }));

    await waitFor(() => expect(card("Reading offers").queryByText(UNREADABLE)).toBeNull());
    const row = JSON.parse(getSetting(server.runtime.db, "analysis")?.value ?? "null");
    expect(row).toMatchObject({ monthlySpendCapUsd: 1, batchOnly: false });
  });
});
