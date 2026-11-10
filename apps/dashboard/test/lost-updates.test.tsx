// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { openAdvanced, openFold } from "./advanced.js";
import { choose } from "./choose.js";
import { openProfile, preview, saved } from "./profile-harness.js";
import { realServer } from "./real-server.js";
import { renderDashboard } from "./render.js";

type Server = ReturnType<typeof realServer>;

async function save(user: { click: (element: Element) => Promise<void> }) {
  const button = await within(preview()).findByRole("button", { name: "Save" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  await user.click(button);
}

// biome-ignore lint/suspicious/noExplicitAny: the four documents differ; each test edits its own
type Json = any;

async function elsewhere(server: Server, path: string, change: (doc: Json) => void) {
  const doc = await (await server.asCli(path)).json();
  delete doc.constants;
  change(doc);
  const res = await server.asCli(path, { method: "PUT", body: JSON.stringify(doc) });
  expect(res.status).toBe(200);
}

const stored = async (server: Server, path: string) => (await server.asCli(path)).json();

function holdingFetch(server: Server, path: string) {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = true;
  let sent = 0;
  const fetch = async (request: Request) => {
    if (request.method === "PUT" && new URL(request.url).pathname.endsWith(path)) {
      sent += 1;
      if (holding) {
        holding = false;
        await held;
      }
    }
    return server.fetch(request);
  };
  return { fetch, release: () => release(), sent: () => sent };
}

describe("Profile & Filters: a draft is re-applied onto what is saved now", () => {
  it("keeps a Filters change made elsewhere while a Profile draft waited on another page", async () => {
    const { user, server } = await openProfile();
    await choose(user, screen.getByLabelText("Diet"), "Vegan");
    await within(preview()).findByText(/would be ranked differently/);

    const nav = within(screen.getByRole("navigation", { name: "Main" }));
    await user.click(nav.getByRole("link", { name: /Searches/ }));
    await screen.findByRole("heading", { level: 1, name: "Searches" });
    await elsewhere(server, "/filters", (filters) => {
      filters.hideLikelyScams.enabled = true;
    });

    await user.click(nav.getByRole("link", { name: /Profile$/ }));
    await screen.findByRole("heading", { level: 2, name: "About you" });
    await save(user);
    expect(await screen.findByText(/Saved\. Your Offers are already ranked/)).toBeTruthy();

    expect(await saved(server, "profile")).toMatchObject({ diet: "vegan" });
    expect((await saved(server, "filters")).hideLikelyScams.enabled).toBe(true);
  });

  it("refuses to overwrite a change made while the page was open, and keeps both on the next Save", async () => {
    const { user, server } = await openProfile();
    await user.type(screen.getByLabelText("Max warm rent limit"), "480");
    await within(preview()).findByText(/would be ranked differently/);
    await elsewhere(server, "/filters", (filters) => {
      filters.hideLikelyScams.enabled = true;
    });

    await save(user);
    expect(await screen.findByText(/changed somewhere else/)).toBeTruthy();
    expect((await saved(server, "filters")).maxRent.limit).toBeNull();
    expect((screen.getByLabelText("Max warm rent limit") as HTMLInputElement).value).toBe("480");

    await save(user);
    expect(await screen.findByText(/Saved\. Your Offers are already ranked/)).toBeTruthy();
    const filters = await saved(server, "filters");
    expect(filters.maxRent.limit).toBe(480);
    expect(filters.hideLikelyScams.enabled).toBe(true);
  });

  it("writes neither half when one changed elsewhere, and keeps every change on the next Save", async () => {
    const { user, server } = await openProfile();
    await choose(user, screen.getByLabelText("Diet"), "Vegan");
    await user.type(screen.getByLabelText("Max warm rent limit"), "480");
    await within(preview()).findByText(/would be ranked differently/);
    await elsewhere(server, "/filters", (filters) => {
      filters.hideLikelyScams.enabled = true;
    });

    await save(user);
    expect(await screen.findByText(/changed somewhere else/)).toBeTruthy();
    expect((await saved(server, "profile")).diet).not.toBe("vegan");
    expect((await saved(server, "filters")).maxRent.limit).toBeNull();

    await save(user);
    expect(await screen.findByText(/Saved\. Your Offers are already ranked/)).toBeTruthy();
    expect((await saved(server, "profile")).diet).toBe("vegan");
    const filters = await saved(server, "filters");
    expect(filters.maxRent.limit).toBe(480);
    expect(filters.hideLikelyScams.enabled).toBe(true);
  });

  it("does not take its own save for a change made elsewhere when reads carry weak ETags", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    const fetch = async (request: Request) => {
      const response = await server.fetch(request);
      const etag = response.headers.get("ETag");
      if (request.method !== "GET" || etag === null) return response;
      const headers = new Headers(response.headers);
      headers.set("ETag", `W/${etag}`);
      return new Response(response.body, { status: response.status, headers });
    };
    const { user } = renderDashboard(fetch, "/profile");
    const limit = (await screen.findByLabelText("Max warm rent limit")) as HTMLInputElement;
    await user.type(limit, "480");
    await within(preview()).findByText(/would be ranked differently/);
    await save(user);
    expect(await screen.findByText(/Saved\. Your Offers are already ranked/)).toBeTruthy();

    await choose(user, screen.getByLabelText("Diet"), "Vegan");
    const nav = within(screen.getByRole("navigation", { name: "Main" }));
    await user.click(nav.getByRole("link", { name: /Searches/ }));
    await screen.findByRole("heading", { level: 1, name: "Searches" });
    await user.click(nav.getByRole("link", { name: /Profile$/ }));
    await screen.findByRole("heading", { level: 2, name: "About you" });

    await within(preview()).findByText(/would be ranked differently/);
    expect(screen.queryByText(/changed somewhere else/)).toBeNull();
    expect(screen.getByLabelText("Diet").getAttribute("data-value")).toBe("vegan");
  });

  it("drops the draft when what was changed elsewhere is what it held", async () => {
    const { user, server } = await openProfile();
    await user.type(screen.getByLabelText("Max warm rent limit"), "480");
    await within(preview()).findByText(/would be ranked differently/);
    const nav = within(screen.getByRole("navigation", { name: "Main" }));
    await user.click(nav.getByRole("link", { name: /Searches/ }));
    await screen.findByRole("heading", { level: 1, name: "Searches" });
    await elsewhere(server, "/filters", (filters) => {
      filters.maxRent.limit = 480;
    });
    await user.click(nav.getByRole("link", { name: /Profile$/ }));
    await screen.findByRole("heading", { level: 2, name: "About you" });
    await waitFor(() => expect(nav.queryByRole("img", { name: "Unsaved draft" })).toBeNull());
  });

  it("keeps the editor when the read after a refused save fails, and says so beside the draft", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    let failReads = false;
    const fetch = async (request: Request) =>
      failReads && request.method === "GET" && new URL(request.url).pathname.endsWith("/profile")
        ? new Response(JSON.stringify({ title: "Server error", detail: "The disk is busy." }), {
            status: 500,
            headers: { "Content-Type": "application/problem+json" },
          })
        : server.fetch(request);
    const { user } = renderDashboard(fetch, "/profile");
    const limit = (await screen.findByLabelText("Max warm rent limit")) as HTMLInputElement;
    await user.type(limit, "480");
    await within(preview()).findByText(/would be ranked differently/);
    await elsewhere(server, "/filters", (filters) => {
      filters.hideLikelyScams.enabled = true;
    });

    failReads = true;
    await save(user);
    expect(await within(preview()).findByText(/The disk is busy/)).toBeTruthy();
    expect(screen.queryByText(/Couldn't load your profile/)).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "About you" })).toBeTruthy();
    expect((screen.getByLabelText("Max warm rent limit") as HTMLInputElement).value).toBe("480");

    failReads = false;
    await save(user);
    expect(await within(preview()).findByText(/changed somewhere else/)).toBeTruthy();
    await save(user);
    expect(await screen.findByText(/Saved\. Your Offers are already ranked/)).toBeTruthy();
    const filters = await stored(server, "/filters");
    expect(filters.maxRent.limit).toBe(480);
    expect(filters.hideLikelyScams.enabled).toBe(true);
  });

  it("holds Load example while the example is on its way", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let asked = 0;
    const fetch = async (request: Request) => {
      if (new URL(request.url).pathname.endsWith("/presets/example")) {
        asked += 1;
        await held;
      }
      return server.fetch(request);
    };
    const { user } = renderDashboard(fetch, "/profile");
    await screen.findByRole("heading", { level: 2, name: "About you" });
    const button = screen.getByRole("button", { name: "Load example" }) as HTMLButtonElement;
    await user.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    await user.click(button);
    expect(asked).toBe(1);

    release();
    expect(await screen.findByText(/Example loaded as a draft/)).toBeTruthy();
    expect(button.disabled).toBe(false);
  });

  it("keeps what was typed while the save was on its way", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    const hold = holdingFetch(server, "/seeking");
    const { user } = renderDashboard(hold.fetch, "/profile");
    const limit = (await screen.findByLabelText("Max warm rent limit")) as HTMLInputElement;
    await user.type(limit, "480");
    await within(preview()).findByText(/would be ranked differently/);

    await save(user);
    await waitFor(() => expect(hold.sent()).toBe(1));
    await choose(user, screen.getByLabelText("Diet"), "Vegan");
    hold.release();

    expect(await screen.findByText(/Saved\. Your Offers are already ranked/)).toBeTruthy();
    expect((await stored(server, "/filters")).maxRent.limit).toBe(480);
    const nav = within(screen.getByRole("navigation", { name: "Main" }));
    expect(nav.getByRole("img", { name: "Unsaved draft" })).toBeTruthy();
    expect((await stored(server, "/profile")).diet).not.toBe("vegan");
    await save(user);
    await waitFor(async () => expect((await stored(server, "/profile")).diet).toBe("vegan"));
  });

  it("says when the example can't be loaded, with no draft to show it in", async () => {
    const { user, breakPreset } = await openProfile();
    breakPreset();
    await user.click(screen.getByRole("button", { name: "Load example" }));
    expect(await screen.findByText(/Couldn't load the example: the preset broke/)).toBeTruthy();
  });

  it("lets the example's Search suggestion go with the draft on Discard", async () => {
    const { user } = await openProfile();
    await user.click(screen.getByRole("button", { name: "Load example" }));
    expect(await screen.findByText(/It also suggests a search/)).toBeTruthy();
    await user.click(within(preview()).getByRole("button", { name: "Discard" }));
    const question = screen.getByRole("alertdialog", { name: "Discard your unsaved changes?" });
    await user.click(within(question).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByText(/It also suggests a search/)).toBeNull());
  });

  it("asks before the page is reloaded or closed with a draft", async () => {
    const { user } = await openProfile();
    const unload = () => {
      const event = new Event("beforeunload", { cancelable: true });
      fireEvent(window, event);
      return event.defaultPrevented;
    };
    expect(unload()).toBe(false);
    await user.type(screen.getByLabelText("Max warm rent limit"), "480");
    await within(preview()).findByText(/would be ranked differently/);
    expect(unload()).toBe(true);
  });
});

describe("Settings: a single setting changes only itself", () => {
  async function openSettings(server = realServer({ signedIn: true })) {
    await server.ready;
    const { user } = renderDashboard(server.fetch, "/settings");
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    return { server, user };
  }

  it("Hide likely scams keeps a Filters change saved after Settings was opened", async () => {
    const { server, user } = await openSettings();
    const toggle = await screen.findByRole("switch", { name: "Hide likely scams" });
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
    await elsewhere(server, "/filters", (filters) => {
      filters.maxRent.enabled = true;
      filters.maxRent.limit = 650;
    });

    await user.click(toggle);
    await waitFor(async () =>
      expect((await stored(server, "/filters")).hideLikelyScams.enabled).toBe(true),
    );
    expect((await stored(server, "/filters")).maxRent.limit).toBe(650);
  });

  it("the monthly limit keeps a reading-model change saved after Settings was opened", async () => {
    const { server, user } = await openSettings();
    const limit = await screen.findByLabelText("Monthly limit for reading offers");
    await waitFor(() => expect((limit as HTMLInputElement).disabled).toBe(false));
    // The row settles once this month's spend is in; typing before that races the load.
    await screen.findByText(/used this month/);
    await elsewhere(server, "/settings/analysis", (settings) => {
      settings.batchOnly = true;
    });

    await user.clear(limit);
    await user.type(limit, "9");
    await user.tab();
    await waitFor(async () =>
      expect((await stored(server, "/settings/analysis")).monthlySpendCapUsd).toBe(9),
    );
    expect((await stored(server, "/settings/analysis")).batchOnly).toBe(true);
  });

  it("the monthly limit is sent once for Enter then leaving the field", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    const hold = holdingFetch(server, "/settings/analysis");
    const { user } = renderDashboard(hold.fetch, "/settings");
    const limit = await screen.findByLabelText("Monthly limit for reading offers");
    await waitFor(() => expect((limit as HTMLInputElement).disabled).toBe(false));
    // The row settles once this month's spend is in; typing before that races the load.
    await screen.findByText(/used this month/);
    await user.clear(limit);
    await user.type(limit, "9{Enter}");
    await waitFor(() => expect(hold.sent()).toBe(1));
    await user.tab();
    hold.release();
    await waitFor(async () =>
      expect((await stored(server, "/settings/analysis")).monthlySpendCapUsd).toBe(9),
    );
    expect(hold.sent()).toBe(1);
  });

  it("the monthly limit saves a second amount committed while the first was on its way", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    const hold = holdingFetch(server, "/settings/analysis");
    const { user } = renderDashboard(hold.fetch, "/settings");
    const limit = await screen.findByLabelText("Monthly limit for reading offers");
    await waitFor(() => expect((limit as HTMLInputElement).disabled).toBe(false));
    await screen.findByText(/used this month/);
    await user.clear(limit);
    await user.type(limit, "9{Enter}");
    await waitFor(() => expect(hold.sent()).toBe(1));
    await user.clear(limit);
    await user.type(limit, "12{Enter}");
    hold.release();
    await waitFor(async () =>
      expect((await stored(server, "/settings/analysis")).monthlySpendCapUsd).toBe(12),
    );
    expect(hold.sent()).toBe(2);
  });

  it("the monthly limit field is never enabled before it shows the saved limit", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    const fetch = async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path.endsWith("/settings/analysis")) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return server.fetch(request);
    };
    renderDashboard(fetch, "/settings");
    const limit = (await screen.findByLabelText(
      "Monthly limit for reading offers",
    )) as HTMLInputElement;
    const seen: string[] = [];
    await waitFor(() => {
      seen.push(limit.value);
      expect(limit.disabled).toBe(false);
    });
    expect(seen.at(-1)).toBe("5");
  });

  it("quiet hours keep a pacing change saved after Settings was opened", async () => {
    const { server, user } = await openSettings();
    const from = await screen.findByLabelText("Quiet hours start");
    await waitFor(() => expect(from.getAttribute("data-value")).toBe("23:30"));
    await elsewhere(server, "/settings/crawl", (settings) => {
      settings.pacing.dailyCap = 120;
    });

    await choose(user, from, "22:00");
    await waitFor(async () =>
      expect((await stored(server, "/settings/crawl")).pacing.activeHours.end).toBe("22:00"),
    );
    expect((await stored(server, "/settings/crawl")).pacing.dailyCap).toBe(120);
  });
});

describe("Settings › Advanced: drafts survive saves made around them", () => {
  it("keeps an unsaved pacing draft when the quiet hours are saved", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    const { user } = renderDashboard(server.fetch, "/settings");
    await openAdvanced(user);
    await openFold(user, "Pacing");
    const region = await screen.findByRole("region", { name: "Pacing" });
    const daily = (await within(region).findByLabelText("Most requests a day")) as HTMLInputElement;
    await user.clear(daily);
    await user.type(daily, "200");

    await choose(user, screen.getByLabelText("Quiet hours start"), "22:00");
    await waitFor(async () =>
      expect((await stored(server, "/settings/crawl")).pacing.activeHours.end).toBe("22:00"),
    );

    const after = within(screen.getByRole("region", { name: "Pacing" }));
    expect((after.getByLabelText("Most requests a day") as HTMLInputElement).value).toBe("200");
    await waitFor(() =>
      expect(after.getByLabelText("Checks until").getAttribute("data-value")).toBe("22:00"),
    );
    await user.click(after.getByRole("button", { name: "Save pacing" }));
    await waitFor(async () =>
      expect((await stored(server, "/settings/crawl")).pacing).toMatchObject({
        dailyCap: 200,
        activeHours: { end: "22:00" },
      }),
    );
  });

  it("keeps the pacing it saved when a read from before the save answers last", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    let afterPut = false;
    let held: Promise<Response> | undefined;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = async (request: Request) => {
      const isCrawl = new URL(request.url).pathname.endsWith("/settings/crawl");
      if (isCrawl && request.method === "PUT") afterPut = true;
      if (isCrawl && request.method === "GET" && afterPut && held === undefined) {
        held = server.fetch(request);
        const response = await held;
        await gate;
        return response;
      }
      return server.fetch(request);
    };
    const { user } = renderDashboard(fetch, "/settings");
    await openAdvanced(user);
    await openFold(user, "Pacing");
    const region = within(await screen.findByRole("region", { name: "Pacing" }));
    const daily = (await region.findByLabelText("Most requests a day")) as HTMLInputElement;
    await user.clear(daily);
    await user.type(daily, "200");

    await choose(user, screen.getByLabelText("Quiet hours start"), "22:00");
    await waitFor(() => expect(held).toBeDefined());
    await user.click(region.getByRole("button", { name: "Save pacing" }));
    await region.findByText(/changed somewhere else/);
    await user.click(region.getByRole("button", { name: "Save pacing" }));
    await waitFor(async () =>
      expect((await stored(server, "/settings/crawl")).pacing.dailyCap).toBe(200),
    );
    await waitFor(() => expect(region.queryByRole("button", { name: "Save pacing" })).toBeNull());

    release();
    await held;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((region.getByLabelText("Most requests a day") as HTMLInputElement).value).toBe("200");
    expect(region.queryByRole("button", { name: "Save pacing" })).toBeNull();
  });

  it("keeps the reading-model fields changed while the save was on its way", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    const hold = holdingFetch(server, "/settings/analysis");
    const { user } = renderDashboard(hold.fetch, "/settings");
    await openAdvanced(user);
    await screen.findByLabelText("Model");

    await user.click(screen.getByLabelText("Always read in batches"));
    await user.click(screen.getByRole("button", { name: "Save reading model" }));
    await waitFor(() => expect(hold.sent()).toBe(1));
    await choose(user, screen.getByLabelText("Effort"), "low");
    hold.release();

    await waitFor(async () =>
      expect((await stored(server, "/settings/analysis")).batchOnly).toBe(true),
    );
    await waitFor(() => expect(screen.getByText("Unsaved changes")).toBeTruthy());
    expect(screen.getByLabelText("Effort").textContent).toContain("low");
  });

  function failingReads(server: Server, path: string) {
    const reads = { failing: false };
    const fetch = async (request: Request) =>
      reads.failing && request.method === "GET" && new URL(request.url).pathname.endsWith(path)
        ? new Response(JSON.stringify({ title: "Server error", detail: "The disk is busy." }), {
            status: 500,
            headers: { "Content-Type": "application/problem+json" },
          })
        : server.fetch(request);
    return { fetch, reads };
  }

  it("says a refused pacing save's saved values couldn't be read, when the read after it fails", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    const { fetch, reads } = failingReads(server, "/settings/crawl");
    const { user } = renderDashboard(fetch, "/settings");
    await openAdvanced(user);
    await openFold(user, "Pacing");
    const region = within(await screen.findByRole("region", { name: "Pacing" }));
    const daily = (await region.findByLabelText("Most requests a day")) as HTMLInputElement;
    await user.clear(daily);
    await user.type(daily, "200");
    await elsewhere(server, "/settings/crawl", (settings) => {
      settings.pacing.hourlyCap = 7;
    });

    reads.failing = true;
    await user.click(region.getByRole("button", { name: "Save pacing" }));
    const said = await region.findByText(/couldn't read them just now/);
    expect(said.textContent).toMatch(/The disk is busy/);
    expect(said.textContent).not.toMatch(/laid over/);
  });

  it("says a refused reading-model save's saved values couldn't be read, when the read after it fails", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    const { fetch, reads } = failingReads(server, "/settings/analysis");
    const { user } = renderDashboard(fetch, "/settings");
    await openAdvanced(user);
    await screen.findByLabelText("Model");
    await user.click(screen.getByLabelText("Always read in batches"));
    await elsewhere(server, "/settings/analysis", (settings) => {
      settings.monthlySpendCapUsd = 7;
    });

    reads.failing = true;
    await user.click(screen.getByRole("button", { name: "Save reading model" }));
    const said = await screen.findByText(/couldn't read them just now/);
    expect(said.textContent).toMatch(/The disk is busy/);
    expect(said.textContent).not.toMatch(/laid over/);
  });
});
