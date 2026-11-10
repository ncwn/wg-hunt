// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { openAdvanced, openFold } from "./advanced.js";
import { choose } from "./choose.js";
import { realServer } from "./real-server.js";
import { renderDashboard } from "./render.js";

type Server = ReturnType<typeof realServer>;
// biome-ignore lint/suspicious/noExplicitAny: each test edits its own document
type Json = any;

async function elsewhere(server: Server, path: string, change: (doc: Json) => void) {
  const doc = await (await server.asCli(path)).json();
  delete doc.constants;
  change(doc);
  const res = await server.asCli(path, { method: "PUT", body: JSON.stringify(doc) });
  expect(res.status).toBe(200);
}

const stored = async (server: Server, path: string) => (await server.asCli(path)).json();

const nav = () => within(screen.getByRole("navigation", { name: "Main" }));
const dot = () => nav().queryByRole("img", { name: "Unsaved draft" });

function unloadAsks() {
  const event = new Event("beforeunload", { cancelable: true });
  fireEvent(window, event);
  return event.defaultPrevented;
}

function holdingFetch(server: Server, path: string) {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = true;
  let answered = false;
  const fetch = async (request: Request) => {
    const put = request.method === "PUT" && new URL(request.url).pathname.endsWith(path);
    if (put && holding) {
      holding = false;
      await held;
      const response = await server.fetch(request);
      answered = true;
      return response;
    }
    return server.fetch(request);
  };
  return { fetch, release: () => release(), answered: () => answered };
}

async function openSettings(hold?: string) {
  const server = realServer({ signedIn: true });
  await server.ready;
  const holding = hold ? holdingFetch(server, hold) : undefined;
  const { user } = renderDashboard(holding?.fetch ?? server.fetch, "/settings");
  await openAdvanced(user);
  return { server, user, holding };
}

async function visitSearches(user: UserEvent) {
  await user.click(nav().getByRole("link", { name: /Searches/ }));
  await screen.findByRole("heading", { level: 1, name: "Searches" });
}

async function backToSettings(user: UserEvent) {
  await user.click(nav().getByRole("link", { name: /Settings/ }));
  await screen.findByRole("heading", { level: 1, name: "Settings" });
}

async function pacing() {
  return within(await screen.findByRole("region", { name: "Pacing" }));
}

async function editDailyCap(user: UserEvent, value: string) {
  await openFold(user, "Pacing");
  const daily = (await (await pacing()).findByLabelText("Most requests a day")) as HTMLInputElement;
  await user.clear(daily);
  await user.type(daily, value);
}

describe("Settings drafts survive a visit to another page", () => {
  it("keeps a pacing draft, marks Settings while it is held, and Save saves it", async () => {
    const { server, user } = await openSettings();
    expect(dot()).toBeNull();
    expect(unloadAsks()).toBe(false);
    await editDailyCap(user, "200");
    await waitFor(() => expect(dot()).toBeTruthy());
    expect(unloadAsks()).toBe(true);

    await visitSearches(user);
    expect(dot()).toBeTruthy();
    expect(unloadAsks()).toBe(true);

    await backToSettings(user);
    const region = await pacing();
    const daily = (await region.findByLabelText("Most requests a day")) as HTMLInputElement;
    await waitFor(() => expect(daily.value).toBe("200"));
    for (const fold of [/^Advanced/, /^Pacing/]) {
      expect(screen.getByRole("button", { name: fold }).getAttribute("aria-expanded")).toBe("true");
    }
    await user.click(region.getByRole("button", { name: "Save pacing" }));
    await waitFor(async () =>
      expect((await stored(server, "/settings/crawl")).pacing.dailyCap).toBe(200),
    );
    await waitFor(() => expect(dot()).toBeNull());
    expect(unloadAsks()).toBe(false);
  });

  it("keeps a reading-model draft, and Save saves it", async () => {
    const { server, user } = await openSettings();
    await user.click(await screen.findByLabelText("Always read in batches"));
    await waitFor(() => expect(dot()).toBeTruthy());
    expect(unloadAsks()).toBe(true);

    await visitSearches(user);
    await backToSettings(user);
    expect(await screen.findByText("Unsaved changes")).toBeTruthy();
    expect(screen.getByLabelText("Always read in batches").getAttribute("aria-checked")).toBe(
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Save reading model" }));
    await waitFor(async () =>
      expect((await stored(server, "/settings/analysis")).batchOnly).toBe(true),
    );
    await waitFor(() => expect(dot()).toBeNull());
    expect(unloadAsks()).toBe(false);
  });

  it("lets the dot go on Discard and Revert", async () => {
    const { user } = await openSettings();
    await editDailyCap(user, "200");
    await user.click(await screen.findByLabelText("Always read in batches"));
    await waitFor(() => expect(dot()).toBeTruthy());

    await user.click((await pacing()).getByRole("button", { name: "Discard" }));
    expect(dot()).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Revert" }));
    await waitFor(() => expect(dot()).toBeNull());
    expect(unloadAsks()).toBe(false);

    await visitSearches(user);
    await backToSettings(user);
    await openFold(user, "Advanced");
    await openFold(user, "Pacing");
    expect((await pacing()).queryByRole("button", { name: "Save pacing" })).toBeNull();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("lays a pacing draft over pacing saved while away", async () => {
    const { server, user } = await openSettings();
    await editDailyCap(user, "200");
    await visitSearches(user);
    await elsewhere(server, "/settings/crawl", (settings) => {
      settings.pacing.hourlyCap = 9;
    });

    await backToSettings(user);
    const region = await pacing();
    await waitFor(() =>
      expect((region.getByLabelText("Most requests an hour") as HTMLInputElement).value).toBe("9"),
    );
    expect((region.getByLabelText("Most requests a day") as HTMLInputElement).value).toBe("200");
    await user.click(region.getByRole("button", { name: "Save pacing" }));
    await waitFor(async () =>
      expect((await stored(server, "/settings/crawl")).pacing).toMatchObject({
        dailyCap: 200,
        hourlyCap: 9,
      }),
    );
    expect(region.queryByText(/changed somewhere else/)).toBeNull();
  });

  it("lays a reading-model draft over settings saved while away", async () => {
    const { server, user } = await openSettings();
    await choose(user, await screen.findByLabelText("Effort"), "low");
    await visitSearches(user);
    await elsewhere(server, "/settings/analysis", (settings) => {
      settings.batchOnly = true;
    });

    await backToSettings(user);
    await waitFor(() =>
      expect(screen.getByLabelText("Always read in batches").getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
    expect(screen.getByLabelText("Effort").textContent).toContain("low");
    await user.click(screen.getByRole("button", { name: "Save reading model" }));
    await waitFor(async () =>
      expect(await stored(server, "/settings/analysis")).toMatchObject({
        effort: "low",
        batchOnly: true,
      }),
    );
    expect(screen.queryByText(/changed somewhere else/)).toBeNull();
  });

  it("lets go of a pacing draft whose save finished after the seeker left", async () => {
    const { server, user, holding } = await openSettings("/settings/crawl");
    await editDailyCap(user, "200");
    await user.click((await pacing()).getByRole("button", { name: "Save pacing" }));
    await visitSearches(user);
    holding?.release();
    await waitFor(() => expect(holding?.answered()).toBe(true));
    await waitFor(() => expect(dot()).toBeNull());
    expect(unloadAsks()).toBe(false);

    await elsewhere(server, "/settings/crawl", (settings) => {
      settings.pacing.dailyCap = 150;
    });
    await backToSettings(user);
    await openFold(user, "Advanced");
    await openFold(user, "Pacing");
    const region = await pacing();
    await waitFor(() =>
      expect((region.getByLabelText("Most requests a day") as HTMLInputElement).value).toBe("150"),
    );
    expect(region.queryByRole("button", { name: "Save pacing" })).toBeNull();
  });

  it("lets go of a reading-model draft whose save finished after the seeker left", async () => {
    const { server, user, holding } = await openSettings("/settings/analysis");
    await user.click(await screen.findByLabelText("Always read in batches"));
    await user.click(screen.getByRole("button", { name: "Save reading model" }));
    await visitSearches(user);
    holding?.release();
    await waitFor(() => expect(holding?.answered()).toBe(true));
    await waitFor(() => expect(dot()).toBeNull());
    expect(unloadAsks()).toBe(false);

    await elsewhere(server, "/settings/analysis", (settings) => {
      settings.batchOnly = false;
    });
    await backToSettings(user);
    await openFold(user, "Advanced");
    await waitFor(() =>
      expect(screen.getByLabelText("Always read in batches").getAttribute("aria-checked")).toBe(
        "false",
      ),
    );
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });
});
