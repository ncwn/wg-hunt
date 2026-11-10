// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api/client.js";
import { PacingEditor } from "../src/components/PacingEditor.js";
import { openAdvanced } from "./advanced.js";
import { choose } from "./choose.js";
import { realServer } from "./real-server.js";
import { renderDashboard } from "./render.js";

type Server = ReturnType<typeof realServer>;
// biome-ignore lint/suspicious/noExplicitAny: each test edits its own document
type Json = any;

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

const stored = async (server: Server, path: string) => (await server.asCli(path)).json();

async function editPacing(fetch: (request: Request) => Promise<Response>) {
  const api = createApiClient({ fetch, baseUrl: "http://localhost/api/v1" });
  const user = userEvent.setup();
  const onSaved = vi.fn();
  const view = render(<PacingEditor api={api} onSaved={onSaved} refresh={0} outside={0} />);
  const rerender = (outside: number) =>
    view.rerender(<PacingEditor api={api} onSaved={onSaved} refresh={0} outside={outside} />);
  await user.click(await screen.findByRole("button", { name: /^Pacing/ }));
  const region = within(screen.getByRole("region", { name: "Pacing" }));
  const daily = (await region.findByLabelText("Most requests a day")) as HTMLInputElement;
  await user.clear(daily);
  await user.type(daily, "200");
  return { user, region, daily, onSaved, rerender, unmount: view.unmount };
}

describe("Settings › Pacing: a save that answers late", () => {
  it("still tells Settings it saved when the editor is gone by the time it answers", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    const hold = holdingFetch(server, "/settings/crawl");
    const { user, region, onSaved, unmount } = await editPacing(hold.fetch);

    await user.click(region.getByRole("button", { name: "Save pacing" }));
    await waitFor(() => expect(hold.sent()).toBe(1));
    unmount();
    hold.release();

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect((await stored(server, "/settings/crawl")).pacing.dailyCap).toBe(200);
  });

  it("still tells Settings it saved, and says nothing, when saved from outside meanwhile", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    const hold = holdingFetch(server, "/settings/crawl");
    const { user, region, onSaved, rerender } = await editPacing(hold.fetch);

    const save = region.getByRole("button", { name: "Save pacing" }) as HTMLButtonElement;
    await user.click(save);
    await waitFor(() => expect(hold.sent()).toBe(1));
    rerender(1);
    expect(save.disabled).toBe(true);
    hold.release();

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect((await stored(server, "/settings/crawl")).pacing.dailyCap).toBe(200);
    expect(region.queryByRole("alert")).toBeNull();
    expect(region.queryByText(/changed somewhere else|couldn't/i)).toBeNull();
  });

  it("drops a refusal once the pacing is saved from outside, and keeps the draft", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    const fetch = async (request: Request) =>
      request.method === "PUT" && new URL(request.url).pathname.endsWith("/settings/crawl")
        ? new Response(
            JSON.stringify({ title: "Busy", status: 503, detail: "wg-hunt is busy right now." }),
            { status: 503, headers: { "Content-Type": "application/problem+json" } },
          )
        : server.fetch(request);
    const { user, region, daily, rerender } = await editPacing(fetch);

    await user.click(region.getByRole("button", { name: "Save pacing" }));
    expect(await region.findByText("wg-hunt is busy right now.")).toBeTruthy();

    rerender(1);
    expect(region.queryByText("wg-hunt is busy right now.")).toBeNull();
    await waitFor(() =>
      expect(
        (region.getByRole("button", { name: "Save pacing" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(daily.value).toBe("200");
  });
});

async function elsewhere(server: Server, path: string, change: (doc: Json) => void) {
  const doc = await (await server.asCli(path)).json();
  change(doc);
  const res = await server.asCli(path, { method: "PUT", body: JSON.stringify(doc) });
  expect(res.status).toBe(200);
}

const limitField = () =>
  screen.getByLabelText("Monthly limit for reading offers") as HTMLInputElement;
const errorOf = (input: HTMLElement) => {
  const id = input.getAttribute("aria-describedby");
  return id ? (document.getElementById(id)?.textContent ?? undefined) : undefined;
};

async function openSettings(fetch: (request: Request) => Promise<Response>) {
  const { user } = renderDashboard(fetch, "/settings");
  await openAdvanced(user);
  await screen.findByLabelText("Model");
  await waitFor(() => expect(limitField().disabled).toBe(false));
  // The row settles once this month's spend is in; typing before that races the load.
  await screen.findByText(/used this month/);
  return user;
}

async function limitSavedElsewhere(server: Server, user: Awaited<ReturnType<typeof openSettings>>) {
  await elsewhere(server, "/settings/analysis", (settings) => {
    settings.monthlySpendCapUsd = 7;
  });
  await user.click(screen.getByLabelText("Always read in batches"));
  const save = () => user.click(screen.getByRole("button", { name: "Save reading model" }));
  await save();
  await screen.findByText(/changed somewhere else/);
  await save();
  await screen.findByText("Saved.");
}

describe("Settings › Monthly limit: a save and the saved limit moving on", () => {
  it("still lands, and says nothing, when the limit was saved elsewhere while it was on its way", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    const hold = holdingFetch(server, "/settings/analysis");
    const user = await openSettings(hold.fetch);

    await user.clear(limitField());
    await user.type(limitField(), "9{Enter}");
    await waitFor(() => expect(hold.sent()).toBe(1));
    await limitSavedElsewhere(server, user);
    hold.release();

    await waitFor(async () =>
      expect(await stored(server, "/settings/analysis")).toMatchObject({
        monthlySpendCapUsd: 9,
        batchOnly: true,
      }),
    );
    await waitFor(() => expect(limitField().value).toBe("9"));
    expect(errorOf(limitField())).toBeUndefined();
  });

  it("drops a refusal once the saved limit changes", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    const fetch = async (request: Request) => {
      if (
        request.method === "PUT" &&
        new URL(request.url).pathname.endsWith("/settings/analysis") &&
        (await request.clone().json()).monthlySpendCapUsd === 9
      ) {
        return new Response(
          JSON.stringify({ title: "Busy", status: 503, detail: "wg-hunt is busy right now." }),
          { status: 503, headers: { "Content-Type": "application/problem+json" } },
        );
      }
      return server.fetch(request);
    };
    const user = await openSettings(fetch);

    await user.clear(limitField());
    await user.type(limitField(), "9{Enter}");
    await waitFor(() => expect(errorOf(limitField())).toBe("wg-hunt is busy right now."));

    await limitSavedElsewhere(server, user);
    expect((await stored(server, "/settings/analysis")).monthlySpendCapUsd).toBe(7);
    await waitFor(() => expect(errorOf(limitField())).toBeUndefined());
    expect(limitField().value).toBe("9");
  });

  it("keeps its wording for an amount that isn't one, and clears it on typing", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    const user = await openSettings(server.fetch);

    await user.clear(limitField());
    await user.tab();
    expect(errorOf(limitField())).toBe("Enter an amount, such as 5 or 12.50.");
    await user.type(limitField(), "6");
    expect(errorOf(limitField())).toBeUndefined();
  });
});

describe("Settings › Hide likely scams", () => {
  it("stays off while its save is on its way, then shows the saved setting", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    const hold = holdingFetch(server, "/filters");
    const { user } = renderDashboard(hold.fetch, "/settings");
    const toggle = (await screen.findByRole("switch", {
      name: "Hide likely scams",
    })) as HTMLButtonElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));
    const before = toggle.getAttribute("aria-checked") === "true";

    await user.click(toggle);
    await waitFor(() => expect(hold.sent()).toBe(1));
    expect(toggle.disabled).toBe(true);
    hold.release();

    await waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.getAttribute("aria-checked")).toBe(String(!before));
    expect(hold.sent()).toBe(1);
    expect(screen.getByText("They stay under Warned.")).toBeTruthy();
  });

  it("says what the server said when it refuses, until the next change", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    let refuse = true;
    const fetch = async (request: Request) => {
      if (
        refuse &&
        request.method === "PUT" &&
        new URL(request.url).pathname.endsWith("/filters")
      ) {
        refuse = false;
        return new Response(
          JSON.stringify({ title: "Busy", status: 503, detail: "wg-hunt is busy right now." }),
          { status: 503, headers: { "Content-Type": "application/problem+json" } },
        );
      }
      return server.fetch(request);
    };
    const { user } = renderDashboard(fetch, "/settings");
    const toggle = (await screen.findByRole("switch", {
      name: "Hide likely scams",
    })) as HTMLButtonElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));

    await user.click(toggle);
    expect(await screen.findByText("wg-hunt is busy right now.")).toBeTruthy();
    await user.click(toggle);
    await waitFor(() => expect(screen.getByText("They stay under Warned.")).toBeTruthy());
    expect(screen.queryByText("wg-hunt is busy right now.")).toBeNull();
  });
});

describe("Settings › Reading model: a refusal and the next edit", () => {
  it("drops the changed-elsewhere refusal once the seeker edits again", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    const user = await openSettings(server.fetch);
    await elsewhere(server, "/settings/analysis", (settings) => {
      settings.monthlySpendCapUsd = 7;
    });

    await user.click(screen.getByLabelText("Always read in batches"));
    await user.click(screen.getByRole("button", { name: "Save reading model" }));
    expect(await screen.findByText(/changed somewhere else/)).toBeTruthy();

    await user.click(screen.getByLabelText("Second read when unsure"));
    expect(screen.queryByText(/changed somewhere else/)).toBeNull();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });
});

const BUSY = () =>
  new Response(
    JSON.stringify({ title: "Busy", status: 503, detail: "wg-hunt is busy right now." }),
    {
      status: 503,
      headers: { "Content-Type": "application/problem+json" },
    },
  );

function heldCrawlSaves(server: Server) {
  let answer: (refuse: boolean) => void = () => {};
  let sent = 0;
  const fetch = async (request: Request) => {
    if (request.method === "PUT" && new URL(request.url).pathname.endsWith("/settings/crawl")) {
      sent += 1;
      const refuse = await new Promise<boolean>((resolve) => {
        answer = resolve;
      });
      if (refuse) return BUSY();
    }
    return server.fetch(request);
  };
  return { fetch, answer: (refuse = false) => answer(refuse), sent: () => sent };
}

const pace = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("Settings › How often to look and Quiet hours while they save", () => {
  it("shows the picked pace at once, holds the choice while it saves, and goes back on a refusal", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    const held = heldCrawlSaves(server);
    const { user } = renderDashboard(held.fetch, "/settings");
    await waitFor(() => expect(pace("Normal").getAttribute("aria-pressed")).toBe("true"));

    await user.click(pace("Gently"));
    await waitFor(() => expect(held.sent()).toBe(1));
    expect(pace("Gently").getAttribute("aria-pressed")).toBe("true");
    expect(pace("Normal").getAttribute("aria-pressed")).toBe("false");
    for (const name of ["Gently", "Normal", "Eager"]) expect(pace(name).disabled).toBe(true);

    held.answer(true);
    expect(await screen.findByText("wg-hunt is busy right now.")).toBeTruthy();
    expect(pace("Normal").getAttribute("aria-pressed")).toBe("true");
    expect(pace("Gently").getAttribute("aria-pressed")).toBe("false");
    expect(pace("Gently").disabled).toBe(false);
  });

  it("holds the quiet hours while they save", async () => {
    const server = realServer({ signedIn: true });
    await server.ready;
    const held = heldCrawlSaves(server);
    const { user } = renderDashboard(held.fetch, "/settings");
    const from = (await screen.findByLabelText("Quiet hours start")) as HTMLButtonElement;
    const until = screen.getByLabelText("Quiet hours end") as HTMLButtonElement;
    await waitFor(() => expect(from.getAttribute("data-value")).toBe("23:30"));

    await choose(user, from, "22:00");
    await waitFor(() => expect(held.sent()).toBe(1));
    expect(from.getAttribute("data-value")).toBe("22:00");
    expect(from.disabled).toBe(true);
    expect(until.disabled).toBe(true);

    held.answer();
    await waitFor(() => expect(from.disabled).toBe(false));
    expect(until.disabled).toBe(false);
    expect(from.getAttribute("data-value")).toBe("22:00");
    expect((await stored(server, "/settings/crawl")).pacing.activeHours.end).toBe("22:00");
  });
});
