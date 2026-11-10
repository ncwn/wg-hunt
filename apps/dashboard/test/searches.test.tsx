// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { describeSweep } from "../src/searches.js";
import { choose } from "./choose.js";
import { crawlStatus, fakeServer } from "./fake-server.js";
import { realServer } from "./real-server.js";
import { fakeEventStream, renderDashboard } from "./render.js";

const berlin = { city: "Berlin", categories: ["flatshare-room", "one-room-flat"] };

async function openSearches(seed: object[] = []) {
  const server = realServer();
  await server.signIn();
  for (const search of seed) await server.call("POST", "/searches", search);
  const { user } = renderDashboard(server.fetch, "/searches");
  await screen.findByRole("heading", { level: 1, name: "Searches" });
  return { user, server };
}

const openMore = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await screen.findByRole("button", { name: /More options/ }));

const stored = async (server: ReturnType<typeof realServer>) =>
  (await (await server.call("GET", "/searches")).json()).items;

function errorOf(input: HTMLElement): string | undefined {
  const id = input.getAttribute("aria-describedby");
  return id ? (document.getElementById(id)?.textContent ?? undefined) : undefined;
}

describe("Searches page", () => {
  it("invites the first Search when there are none", async () => {
    await openSearches();
    expect(await screen.findByText(/No searches yet/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a search" })).toBeTruthy();
  });

  it("creates a Search from the form and shows it as a card", async () => {
    const { user, server } = await openSearches();
    await user.click(await screen.findByRole("button", { name: "Add a search" }));

    await user.type(screen.getByLabelText("City"), "Berlin");
    await user.click(screen.getByRole("checkbox", { name: "Flatshare room" }));
    await user.click(screen.getByRole("checkbox", { name: "1-room flat" }));
    await user.type(screen.getByLabelText("Most you'll pay, warm"), "800");
    await choose(user, screen.getByLabelText("How recent should ads be?"), "Last 3 days");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const card = await screen.findByRole("article", { name: /in Berlin/ });
    expect(within(card).getByText(/Rooms and 1-room flats in Berlin/)).toBeTruthy();
    expect(within(card).getByText(/up to €\s800/)).toBeTruthy();
    expect(within(card).getByText(/last 3 days/)).toBeTruthy();
    expect(within(card).getByText(/Every 30–60 min/)).toBeTruthy();
    expect(within(card).getByText(/wg-gesucht\.de/)).toBeTruthy();
    expect(within(card).getByText(/^Backfill queued \d\d:\d\d$/)).toBeTruthy();
    expect(screen.queryByLabelText("City")).toBeNull();
    expect(await stored(server)).toMatchObject([
      { city: "Berlin", priceCeiling: 800, recencyDays: 3, enabled: true },
    ]);
  });

  it("shows the server's error beside the categories and keeps what was typed", async () => {
    const { user, server } = await openSearches();
    await user.click(await screen.findByRole("button", { name: "Add a search" }));
    await user.type(screen.getByLabelText("City"), "Berlin");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const categories = await screen.findByRole("group", { name: "What are you after?" });
    await waitFor(() => expect(errorOf(categories)).toBe("Pick at least one category"));
    expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe("Berlin");
    expect(await stored(server)).toEqual([]);

    await user.click(screen.getByRole("checkbox", { name: "Flat" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("article", { name: /in Berlin/ })).toBeTruthy();
    expect(await stored(server)).toHaveLength(1);
  });

  it("lists every Search with its own enabled switch, and disables one", async () => {
    const { user, server } = await openSearches([berlin, { ...berlin, city: "Hamburg" }]);
    const hamburg = await screen.findByRole("article", { name: /in Hamburg/ });
    expect(screen.getByRole("article", { name: /in Berlin/ })).toBeTruthy();

    const toggle = within(hamburg).getByRole("switch", { name: "Search on: Hamburg" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await user.click(toggle);

    await waitFor(() => expect(toggle.getAttribute("aria-checked") === "true").toBe(false));
    expect(within(hamburg).getByText("Off")).toBeTruthy();
    expect(
      (await stored(server)).map((s: { city: string; enabled: boolean }) => [s.city, s.enabled]),
    ).toEqual([
      ["Berlin", true],
      ["Hamburg", false],
    ]);

    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  });

  it("edits a Search inline and can cancel without saving", async () => {
    const { user, server } = await openSearches([berlin]);
    await user.click(await screen.findByRole("button", { name: "Edit Berlin" }));
    expect((screen.getByLabelText("City") as HTMLInputElement).value).toBe("Berlin");
    expect(
      screen.getByRole("checkbox", { name: "Flatshare room" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByRole("checkbox", { name: "House" }).getAttribute("aria-checked")).toBe(
      "false",
    );

    await user.clear(screen.getByLabelText("City"));
    await user.type(screen.getByLabelText("City"), "Leipzig");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("article", { name: /in Berlin/ })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Edit Berlin" }));
    await user.clear(screen.getByLabelText("City"));
    await user.type(screen.getByLabelText("City"), "Potsdam");
    await user.click(screen.getByRole("checkbox", { name: "House" }));
    await openMore(user);
    await user.clear(screen.getByLabelText("Shortest wait between checks"));
    await user.type(screen.getByLabelText("Shortest wait between checks"), "20");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const card = await screen.findByRole("article", { name: /in Potsdam/ });
    expect(within(card).getByText(/houses in Potsdam/)).toBeTruthy();
    expect(within(card).getByText(/Every 20–60 min/)).toBeTruthy();
    expect(await stored(server)).toMatchObject([
      {
        city: "Potsdam",
        categories: ["flatshare-room", "one-room-flat", "house"],
        pollInterval: { minMinutes: 20, maxMinutes: 60 },
      },
    ]);
  });

  it("shows validation errors inline when an edit is refused", async () => {
    const { user, server } = await openSearches([berlin]);
    await user.click(await screen.findByRole("button", { name: "Edit Berlin" }));
    await user.click(screen.getByRole("checkbox", { name: "Flatshare room" }));
    await user.click(screen.getByRole("checkbox", { name: "1-room flat" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    const categories = await screen.findByRole("group", { name: "What are you after?" });
    await waitFor(() => expect(errorOf(categories)).toBe("Pick at least one category"));
    expect((await stored(server))[0].categories).toEqual(["flatshare-room", "one-room-flat"]);
  });

  it("deletes a Search after a confirmation, and keeps it when cancelled", async () => {
    const { user, server } = await openSearches([berlin]);
    await user.click(await screen.findByRole("button", { name: "Delete Berlin" }));
    expect(screen.getByText(/stop being tracked/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.getByRole("article", { name: /in Berlin/ })).toBeTruthy();
    expect(await stored(server)).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Delete Berlin" }));
    await user.click(screen.getByRole("button", { name: "Delete search" }));
    expect(await screen.findByText(/No searches yet/)).toBeTruthy();
    expect(screen.queryByRole("article", { name: /in Berlin/ })).toBeNull();
    expect(await stored(server)).toEqual([]);
  });

  it("says why a delete failed, where the seeker can see it", async () => {
    const server = realServer();
    await server.signIn();
    await server.call("POST", "/searches", berlin);
    const { user } = renderDashboard(
      async (request) =>
        request.method === "DELETE"
          ? new Response(
              JSON.stringify({ title: "Server error", status: 500, detail: "The disk is full." }),
              { status: 500, headers: { "Content-Type": "application/problem+json" } },
            )
          : server.fetch(request),
      "/searches",
    );
    await user.click(await screen.findByRole("button", { name: "Delete Berlin" }));
    await user.click(screen.getByRole("button", { name: "Delete search" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(await within(dialog).findByText(/The disk is full/)).toBeTruthy();
    expect(await stored(server)).toHaveLength(1);
    await user.click(within(dialog).getByRole("button", { name: "Keep" }));
    expect(screen.queryByText(/The disk is full/)).toBeNull();
  });

  it("drops a field's error once the seeker changes that field", async () => {
    const { user } = await openSearches();
    await user.click(await screen.findByRole("button", { name: "Add a search" }));
    await user.type(screen.getByLabelText("City"), "Berlin");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const categories = await screen.findByRole("group", { name: "What are you after?" });
    await waitFor(() => expect(errorOf(categories)).toBe("Pick at least one category"));

    await user.click(screen.getByRole("checkbox", { name: "Flat" }));
    expect(errorOf(categories)).toBeUndefined();
  });

  it("forgets a Check now message once the Search is switched off", async () => {
    const { user } = await openSearches([berlin]);
    const card = await screen.findByRole("article", { name: /in Berlin/ });
    await user.click(within(card).getByRole("button", { name: "Check now: Berlin" }));
    expect(await within(card).findByRole("status")).toBeTruthy();

    await user.click(within(card).getByRole("switch", { name: "Search on: Berlin" }));
    await waitFor(() => expect(card.classList.contains("sc-off")).toBe(true));
    expect(within(card).queryByRole("status")).toBeNull();
  });

  it("makes a Search's poll due with Check now, and says when it will run", async () => {
    const { user, server } = await openSearches([berlin]);
    const card = await screen.findByRole("article", { name: /in Berlin/ });

    await user.click(within(card).getByRole("button", { name: "Check now: Berlin" }));

    // Whether it is "queued for 07:00" or "polling" depends on the real time of day.
    const status = await within(card).findByRole("status");
    expect(status.textContent).toMatch(/^(Queued|Polling)/);
    const crawl = await (await server.call("GET", "/crawl")).json();
    expect(crawl.nextJobs.map((job: { kind: string }) => job.kind)).toContain("poll");
  });

  it("shows when the next poll is due", async () => {
    await openSearches([berlin]);
    const card = await screen.findByRole("article", { name: /in Berlin/ });
    expect(within(card).getByText(/Next check /)).toBeTruthy();
  });

  it("can't crawl a disabled Search", async () => {
    await openSearches([{ ...berlin, enabled: false }]);
    const card = await screen.findByRole("article", { name: /in Berlin/ });
    const button = within(card).getByRole("button", { name: "Check now: Berlin" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(within(card).queryByText(/Next check /)).toBeNull();
  });

  it("warns about a city the Source's adapter doesn't know, until the city number is given", async () => {
    const { user, server } = await openSearches([{ ...berlin, city: "Teststadt" }]);
    const card = await screen.findByRole("article", { name: /in Teststadt/ });
    expect(within(card).getByText(/isn.t checked/)).toBeTruthy();
    expect(
      (within(card).getByRole("button", { name: "Check now: Teststadt" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await user.click(within(card).getByRole("button", { name: "Edit Teststadt" }));
    await openMore(user);
    await user.type(screen.getByLabelText("City number on wg-gesucht (optional)"), "4321");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByText(/isn.t checked/)).toBeNull());
    expect((await stored(server))[0].cityId).toBe("4321");
    expect(
      (screen.getByRole("button", { name: "Check now: Teststadt" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("shows the server's error beside the city number field", async () => {
    const { user } = await openSearches([berlin]);
    await user.click(await screen.findByRole("button", { name: "Edit Berlin" }));
    await openMore(user);
    await user.type(screen.getByLabelText("City number on wg-gesucht (optional)"), "abc");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const input = await screen.findByLabelText("City number on wg-gesucht (optional)");
    await waitFor(() => expect(errorOf(input)).toMatch(/is a number/));
  });

  it("says so when the Searches can't be loaded, and still shows the page", async () => {
    renderDashboard(fakeServer({ signedIn: true }).fetch, "/searches");
    expect(await screen.findByRole("heading", { level: 1, name: "Searches" })).toBeTruthy();
    expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn.t load your searches/);
  });
});

describe("keeping the Searches page current", () => {
  type Fetch = (request: Request) => Promise<Response>;

  async function openLive(seed: object[], wrap: (fetch: Fetch) => Fetch = (fetch) => fetch) {
    const server = realServer();
    await server.signIn();
    for (const search of seed) await server.call("POST", "/searches", search);
    const events = fakeEventStream();
    const { user } = renderDashboard(wrap(server.fetch), "/searches", events.stream);
    await screen.findByRole("heading", { level: 1, name: "Searches" });
    return { server, events, user };
  }

  async function quietly(check: () => void) {
    let flashed = false;
    await waitFor(() => {
      if (screen.queryByText(/Loading your searches/)) flashed = true;
      check();
    });
    expect(flashed).toBe(false);
  }

  it("reads the Searches again once the crawl's status changes, keeping the list in place", async () => {
    const { server, events } = await openLive([{ ...berlin, city: "Teststadt" }]);
    const card = await screen.findByRole("article", { name: /in Teststadt/ });
    expect(within(card).getByText(/isn.t checked/)).toBeTruthy();

    await server.call("PATCH", "/searches/1", { cityId: "4321" });
    for (let i = 0; i < 3; i++)
      await events.emit({ type: "crawl-status-changed", data: crawlStatus() });

    expect(screen.getByRole("article", { name: /in Teststadt/ })).toBe(card);
    await quietly(() => expect(within(card).queryByText(/isn.t checked/)).toBeNull());
  });

  it("reads the Searches again after the stream reconnects", async () => {
    const { server, events } = await openLive([berlin]);
    const card = await screen.findByRole("article", { name: /in Berlin/ });
    expect(card.classList.contains("sc-off")).toBe(false);

    await server.call("PATCH", "/searches/1", { enabled: false });
    await events.reconnect();

    await quietly(() => expect(card.classList.contains("sc-off")).toBe(true));
  });

  it("keeps the Check now answer until the Search's next check moves on", async () => {
    // The real server's poll would need the Source and a clock: the list read is moved on here.
    let nextAt: string | undefined;
    let lists = 0;
    const { events, user } = await openLive([berlin], (fetch) => async (request) => {
      const response = await fetch(request);
      if (request.method !== "GET" || !new URL(request.url).pathname.endsWith("/searches"))
        return response;
      lists += 1;
      if (nextAt === undefined) return response;
      const page = await response.json();
      for (const search of page.items) search.poll.nextAt = nextAt;
      return new Response(JSON.stringify(page), {
        status: response.status,
        headers: response.headers,
      });
    });
    const card = await screen.findByRole("article", { name: /in Berlin/ });

    await user.click(within(card).getByRole("button", { name: "Check now: Berlin" }));
    const status = await within(card).findByRole("status");
    expect(status.textContent).toMatch(/^(Queued|Polling)/);

    const before = lists;
    await events.emit({ type: "crawl-status-changed", data: crawlStatus() });
    await waitFor(() => expect(lists).toBeGreaterThan(before));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(within(card).queryByRole("status")).toBe(status);

    nextAt = new Date(Date.now() + 10 * 60_000).toISOString();
    await events.emit({ type: "crawl-status-changed", data: crawlStatus() });
    await waitFor(() => expect(within(card).queryByRole("status")).toBeNull());
  });
});

describe("the budget forecast on the Searches page", () => {
  it("shows no request counts on a Search's form: the table lives under Settings › Advanced", async () => {
    const { user } = await openSearches([{ ...berlin, categories: ["flatshare-room"] }]);
    await user.click(await screen.findByRole("button", { name: "Edit Berlin" }));
    await openMore(user);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/Requests per day/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Add a search" }));
    await user.click(screen.getByRole("checkbox", { name: "Flat" }));
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("warns when the draft would take polls below one per 2 h", async () => {
    const same = { ...berlin, categories: ["flatshare-room"] };
    const { user } = await openSearches([
      same,
      { ...same, categories: ["flat"] },
      { ...same, categories: ["house"] },
      { ...same, categories: ["one-room-flat"] },
    ]);
    const card = (await screen.findAllByRole("article"))[0] as HTMLElement;
    await user.click(within(card).getByRole("button", { name: /^Edit/ }));
    expect(screen.queryByText(/below one per 2 h/)).toBeNull();

    for (const label of ["One-room flat", "1-room flat", "Flat", "House"]) {
      const box = screen.queryByRole("checkbox", { name: label });
      if (box && box.getAttribute("aria-checked") !== "true") await user.click(box);
    }
    expect(await screen.findByText(/below one per 2 h/)).toBeTruthy();
  });

  it("charges nothing for a Search the Source can't read, until the form gives its city a number", async () => {
    const server = realServer();
    await server.signIn();
    const one = { ...berlin, categories: ["flatshare-room"] };
    await server.call("POST", "/searches", one);
    await server.call("POST", "/searches", { ...one, city: "Hamburg", cityId: "55" });
    await server.call("POST", "/searches", {
      city: "Teststadt",
      categories: ["flatshare-room", "one-room-flat", "flat", "house"],
    });
    const drafted: { warnings: { type: string }[] }[] = [];
    const { user } = renderDashboard(async (request) => {
      const response = await server.fetch(request);
      if (request.method === "POST" && request.url.endsWith("/crawl/forecast")) {
        drafted.push(await response.clone().json());
      }
      return response;
    }, "/searches");

    await user.click(await screen.findByRole("button", { name: "Edit Teststadt" }));
    await openMore(user);
    await waitFor(() => expect(drafted).toHaveLength(1));
    expect(drafted[0]?.warnings).toEqual([]);

    await user.type(screen.getByLabelText(/City number on wg-gesucht/), "4711");
    expect(
      await screen.findByText(/requests a day are expected against a cap of 300/),
    ).toBeTruthy();
  });
});

describe("describeSweep", () => {
  const now = new Date(2026, 10, 9, 12, 0);
  const sweep = {
    status: "idle" as const,
    mode: null,
    startAt: null,
    pagesRead: 0,
    lastFinishedAt: null,
  };

  it("names the Sweep in every state, and nothing while there is none", () => {
    expect(describeSweep(sweep, now)).toBeUndefined();
    expect(
      describeSweep({ ...sweep, status: "running", mode: "backfill", pagesRead: 2 }, now),
    ).toBe("Backfill in progress");
    expect(describeSweep({ ...sweep, status: "running", mode: "daily" }, now)).toBe(
      "Sweep in progress",
    );
    const tomorrow = new Date(2026, 10, 10, 7, 23).toISOString();
    expect(
      describeSweep({ ...sweep, status: "scheduled", mode: "daily", startAt: tomorrow }, now),
    ).toBe("Next Sweep 10 Nov 07:23");
  });
});

describe("a price ceiling the form can't send as it stands", () => {
  async function openRecorded(seed: object[] = []) {
    const server = realServer();
    await server.signIn();
    for (const search of seed) await server.call("POST", "/searches", search);
    const writes: unknown[] = [];
    const { user } = renderDashboard(async (request) => {
      const searches = /\/searches(\/\d+)?$/.test(new URL(request.url).pathname);
      if (searches && request.method !== "GET") writes.push(await request.clone().json());
      return server.fetch(request);
    }, "/searches");
    await screen.findByRole("heading", { level: 1, name: "Searches" });
    return { user, server, writes };
  }

  const price = () => screen.getByLabelText("Most you'll pay, warm") as HTMLInputElement;

  it("refuses a ceiling it can't read as a number, and keeps the Search's ceiling", async () => {
    const { user, server, writes } = await openRecorded([{ ...berlin, priceCeiling: 700 }]);
    await user.click(await screen.findByRole("button", { name: "Edit Berlin" }));
    await user.clear(price());
    await user.type(price(), "800,5");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(errorOf(price())).toBe("Enter a whole number of euros, or leave it empty"),
    );
    expect(price().getAttribute("aria-invalid")).toBe("true");
    expect(price().value).toBe("800,5");
    expect(writes).toEqual([]);
    expect((await stored(server))[0].priceCeiling).toBe(700);
  });

  it("refuses it on a new Search too, says why for each kind of value, and saves once it is fixed", async () => {
    const { user, server, writes } = await openRecorded();
    await user.click(await screen.findByRole("button", { name: "Add a search" }));
    await user.type(screen.getByLabelText("City"), "Berlin");
    await user.click(screen.getByRole("checkbox", { name: "Flat" }));

    for (const [typed, said] of [
      ["abc", "Enter a whole number of euros, or leave it empty"],
      ["800.5", "Enter a whole number of euros, or leave it empty"],
      ["0", "Enter at least €\u00a01, or leave it empty"],
      ["-5", "Enter at least €\u00a01, or leave it empty"],
    ]) {
      await user.clear(price());
      await user.type(price(), typed as string);
      expect(errorOf(price())).toBeUndefined();
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(errorOf(price())).toBe(said));
    }
    expect(writes).toEqual([]);
    expect(await stored(server)).toEqual([]);

    await user.clear(price());
    await user.type(price(), "800");
    expect(errorOf(price())).toBeUndefined();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("article", { name: /in Berlin/ })).toBeTruthy();
    expect(await stored(server)).toMatchObject([{ priceCeiling: 800 }]);
  });

  it("still saves an emptied ceiling as no ceiling", async () => {
    const { user, server, writes } = await openRecorded([{ ...berlin, priceCeiling: 700 }]);
    const card = await screen.findByRole("article", { name: /in Berlin/ });
    expect(within(card).getByText(/up to €\s700/)).toBeTruthy();
    await user.click(within(card).getByRole("button", { name: "Edit Berlin" }));
    await user.clear(price());
    await user.click(screen.getByRole("button", { name: "Save" }));

    const saved = await screen.findByRole("article", { name: /in Berlin/ });
    await waitFor(() => expect(within(saved).queryByText(/up to/)).toBeNull());
    expect(writes).toEqual([{ priceCeiling: null }]);
    expect((await stored(server))[0].priceCeiling).toBeNull();
  });

  it("takes exactly the bounds the server's own schema takes", async () => {
    const { user, server, writes } = await openRecorded([berlin]);
    const document = await (await server.call("GET", "/openapi.json")).json();
    const { minimum, maximum } = document.components.schemas.NewSearch.properties.priceCeiling;

    const euros = (bound: number) => `€\u00a0${bound.toLocaleString("en")}`;
    for (const [refused, taken, said] of [
      [minimum - 1, minimum, `Enter at least ${euros(minimum)}, or leave it empty`],
      [maximum + 1, maximum, `Enter at most ${euros(maximum)}`],
    ] as const) {
      await user.click(await screen.findByRole("button", { name: "Edit Berlin" }));
      await user.clear(price());
      await user.type(price(), String(refused));
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(errorOf(price())).toBe(said));
      expect(writes).toEqual([]);

      await user.clear(price());
      await user.type(price(), String(taken));
      await user.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByRole("button", { name: "Edit Berlin" });
      expect(writes.splice(0)).toEqual([{ priceCeiling: taken }]);
      expect((await stored(server))[0].priceCeiling).toBe(taken);
    }
  });
});
