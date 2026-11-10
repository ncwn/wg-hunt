// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rentSeries } from "../src/rent-series.js";
import { markAllSeen } from "../src/seen.js";
import { crawlStatus } from "./fake-server.js";
import { offer, serverWithOffers } from "./overview-harness.js";
import { fakeEventStream, renderDashboard } from "./render.js";

afterEach(() => localStorage.clear());

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

describe("Overview", () => {
  it("says what happens next when there are no matches", async () => {
    renderDashboard(serverWithOffers([]).fetch);
    expect(
      await screen.findByText("No matches yet. wg-hunt is looking for new rooms."),
    ).toBeTruthy();
  });

  it("doesn't promise a check that isn't coming while hunting is paused", async () => {
    const { fetch } = serverWithOffers([]);
    renderDashboard(async (request) =>
      new URL(request.url).pathname === "/api/v1/crawl"
        ? new Response(
            JSON.stringify(
              crawlStatus({
                state: "paused",
                paused: {
                  reason: "user",
                  cause: null,
                  since: new Date().toISOString(),
                  path: null,
                  savedAs: null,
                },
              }),
            ),
            { headers: { "Content-Type": "application/json" } },
          )
        : fetch(request),
    );
    expect(
      await screen.findByText("No matches yet. Hunting is paused until you resume it."),
    ).toBeTruthy();
  });

  it("waits for the counts before giving a number of Near matches, saying nothing failed", async () => {
    const { fetch } = serverWithOffers([
      offer({ id: 1, band: "near-match", createdAt: daysAgo(3), bandChangedAt: daysAgo(3) }),
      offer({ id: 2, band: "near-match" }),
    ]);
    markAllSeen(Date.now() - 86_400_000);
    let counted!: () => void;
    const counts = new Promise<void>((resolve) => {
      counted = resolve;
    });
    renderDashboard(async (request) => {
      if (new URL(request.url).pathname === "/api/v1/offers/counts") await counts;
      return fetch(request);
    });
    const near = await screen.findByRole("button", { name: /Near matches/ });
    await screen.findByRole("table", { name: "New for you" });
    const value = () => near.querySelector(".wh-stat-value")?.textContent;
    expect(value()).toBe("–");
    expect(screen.queryByText("Couldn't count your offers")).toBeNull();
    counted();
    await waitFor(() => expect(value()).toBe("2"));
  });

  it("counts Matches, Near matches and the shortlisted rooms, and says what is new", async () => {
    const { fetch } = serverWithOffers([
      offer({ id: 1 }),
      offer({ id: 2, band: "near-match" }),
      offer({
        id: 3,
        marks: { dismissed: false, shortlisted: true, contacted: true, scam: null },
      } as never),
    ]);
    renderDashboard(fetch);
    expect(await screen.findByText("3 new rooms since you last looked")).toBeTruthy();
    const matches = await screen.findByRole("button", { name: /Matches/ });
    expect(within(matches).getByText("2")).toBeTruthy();
    const shortlisted = screen.getByRole("button", { name: /Shortlisted/ });
    expect(within(shortlisted).getByText("1 contacted")).toBeTruthy();
  });

  it("asks the server for the shortlist instead of reading every room, and the view lists it", async () => {
    const many = Array.from({ length: 2101 }, (_, i) =>
      offer({ id: i + 1, band: "hidden", title: `Room ${i + 1}` }),
    );
    const last = many.at(-1) as (typeof many)[number];
    last.title = "Far down";
    last.marks = { dismissed: false, shortlisted: true, contacted: true };
    const server = serverWithOffers(many, { paged: true });
    const { user } = renderDashboard(server.fetch);
    const card = await screen.findByRole("button", { name: /Shortlisted/ });
    await waitFor(() => expect(within(card).getByText("1 contacted")).toBeTruthy());
    expect(server.listQueries.map((q) => q.get("band") ?? q.get("shortlisted"))).toEqual([
      "match",
      "near-match",
      "true",
    ]);

    await user.click(card);
    const list = within(await screen.findByRole("region", { name: "Offers" }));
    expect(await list.findByText("Far down")).toBeTruthy();
    expect(server.listQueries.at(-1)?.get("shortlisted")).toBe("true");
    expect(server.listQueries).toHaveLength(4);
  });

  it("reads only the Near matches that are new since the seeker last looked", async () => {
    markAllSeen(Date.now() - 60_000);
    const server = serverWithOffers([
      offer({
        id: 1,
        band: "near-match",
        title: "Old near",
        createdAt: daysAgo(3),
        bandChangedAt: daysAgo(3),
      }),
      offer({ id: 2, band: "near-match", title: "New near" }),
    ]);
    renderDashboard(server.fetch);
    const table = await screen.findByRole("table", { name: "New for you" });
    expect(within(table).getByText("New near")).toBeTruthy();
    expect(within(table).queryByText("Old near")).toBeNull();
    const near = server.listQueries.find((q) => q.get("band") === "near-match");
    expect(near?.get("since")).toBeTruthy();
  });

  it("shows a room the server announces at once, with no read", async () => {
    const server = serverWithOffers([offer({ id: 1, title: "Bright room" })]);
    const events = fakeEventStream();
    renderDashboard(server.fetch, "/", events.stream);
    const table = await screen.findByRole("table", { name: "New for you" });
    const reads = server.listQueries.length;
    await events.emit({ type: "offer-added", data: offer({ id: 2, title: "Fresh room" }) });
    expect(within(table).getByText("Fresh room")).toBeTruthy();
    expect(server.listQueries).toHaveLength(reads);
  });

  it("shortlists an announced room that comes with the star, as a split-off one does", async () => {
    const marks = { dismissed: false, shortlisted: true, contacted: true, scam: null };
    const server = serverWithOffers([offer({ id: 1, marks } as never)]);
    const events = fakeEventStream();
    renderDashboard(server.fetch, "/", events.stream);
    const shortlisted = await screen.findByRole("button", { name: /Shortlisted/ });
    expect(await within(shortlisted).findByText("1 contacted")).toBeTruthy();
    await events.emit({
      type: "offer-added",
      data: offer({ id: 2, band: "hidden", marks } as never),
    });
    expect(within(shortlisted).getByText("2 contacted")).toBeTruthy();
  });

  it("keeps a room announced while the lists are being read", async () => {
    const offers = [offer({ id: 1, title: "Bright room" })];
    const server = serverWithOffers(offers);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const fetch = async (request: Request) => {
      const response = await server.fetch(request);
      if (!held && new URL(request.url).searchParams.get("band") === "match") {
        held = true;
        await gate;
      }
      return response;
    };
    const events = fakeEventStream();
    renderDashboard(fetch, "/", events.stream);
    await waitFor(() => expect(held).toBe(true));
    const fresh = offer({ id: 2, title: "Fresh room" });
    offers.push(fresh);
    await events.emit({ type: "offer-added", data: fresh });
    release();
    const table = await screen.findByRole("table", { name: "New for you" });
    expect(await within(table).findByText("Fresh room")).toBeTruthy();
  });

  it("reads the lists once after a burst of band changes", async () => {
    const server = serverWithOffers([offer({ id: 1 }), offer({ id: 2 })]);
    const events = fakeEventStream();
    renderDashboard(server.fetch, "/", events.stream);
    await screen.findByRole("table", { name: "New for you" });
    const reads = server.listQueries.length;
    for (const id of [1, 2, 1, 2]) {
      await events.emit({
        type: "offer-band-changed",
        data: { offerId: id, band: "near-match", bandChangedAt: daysAgo(0) },
      });
    }
    await waitFor(() => expect(server.listQueries).toHaveLength(reads + 3));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(server.listQueries).toHaveLength(reads + 3);
  });

  it("shows no counts while the offers are being read, rather than zeros", async () => {
    const { fetch } = serverWithOffers([offer({ id: 1 })]);
    let listed!: () => void;
    const list = new Promise<void>((resolve) => {
      listed = resolve;
    });
    let counted!: () => void;
    const counts = new Promise<void>((resolve) => {
      counted = resolve;
    });
    renderDashboard(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/v1/offers") await list;
      if (path === "/api/v1/offers/counts") await counts;
      return fetch(request);
    });
    const shortlisted = await screen.findByRole("button", { name: /Shortlisted/ });
    const matches = screen.getByRole("button", { name: /Matches/ });
    const value = (card: HTMLElement) => card.querySelector(".wh-stat-value")?.textContent;
    expect(value(shortlisted)).toBe("–");
    expect(value(matches)).toBe("–");
    expect(within(shortlisted).queryByText(/contacted/)).toBeNull();
    expect(screen.queryByText("No matches with a rent yet")).toBeNull();
    expect(screen.queryByText("Couldn't count your offers")).toBeNull();

    listed();
    counted();
    await waitFor(() => expect(value(shortlisted)).toBe("0"));
    expect(within(shortlisted).getByText("0 contacted")).toBeTruthy();
    expect(value(matches)).toBe("1");
  });

  it("shows the server's words under the sentence when the offers couldn't be read", async () => {
    const { fetch } = serverWithOffers([offer({ id: 1, title: "Bright room" })]);
    renderDashboard(async (request) =>
      new URL(request.url).pathname === "/api/v1/offers"
        ? new Response(JSON.stringify({ detail: "The offers are resting.", status: 503 }), {
            status: 503,
            headers: { "Content-Type": "application/problem+json" },
          })
        : fetch(request),
    );
    expect(await screen.findByText("Couldn't read your offers")).toBeTruthy();
    expect(screen.getByText("The offers are resting.")).toBeTruthy();
  });

  it("offers Try again after the offers couldn't be read, and shows them once they can", async () => {
    const { fetch } = serverWithOffers([offer({ id: 1, title: "Bright room" })]);
    let down = true;
    const { user } = renderDashboard(async (request) =>
      down && new URL(request.url).pathname === "/api/v1/offers"
        ? new Response(JSON.stringify({ title: "Server error", status: 500 }), {
            status: 500,
            headers: { "Content-Type": "application/problem+json" },
          })
        : fetch(request),
    );
    expect(await screen.findByText("Couldn't read your offers")).toBeTruthy();
    expect(screen.queryByText(/reload the page/)).toBeNull();
    const shortlisted = screen.getByRole("button", { name: /Shortlisted/ });
    expect(shortlisted.querySelector(".wh-stat-value")?.textContent).toBe("–");
    expect(screen.queryByText("No matches with a rent yet")).toBeNull();

    down = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    const table = await screen.findByRole("table", { name: "New for you" });
    expect(within(table).getByText("Bright room")).toBeTruthy();
    expect(screen.queryByText("Couldn't read your offers")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("says the offers couldn't be counted, and Try again counts them", async () => {
    const { fetch } = serverWithOffers([offer({ id: 1, band: "near-match" })]);
    let down = true;
    const { user } = renderDashboard(async (request) =>
      down && new URL(request.url).pathname === "/api/v1/offers/counts"
        ? new Response(JSON.stringify({ title: "Server error", status: 500 }), {
            status: 500,
            headers: { "Content-Type": "application/problem+json" },
          })
        : fetch(request),
    );
    expect(await screen.findByText("Couldn't count your offers")).toBeTruthy();
    const near = screen.getByRole("button", { name: /Near matches/ });
    const value = () => near.querySelector(".wh-stat-value")?.textContent;
    expect(value()).toBe("–");

    down = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(value()).toBe("1"));
    expect(screen.getByText("1 new room since you last looked")).toBeTruthy();
    expect(screen.queryByText("Couldn't count your offers")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("opens the Shortlisted view of Offers from the Shortlisted card", async () => {
    const { user, location } = renderDashboard(serverWithOffers([offer({ id: 1 })]).fetch);
    await user.click(await screen.findByRole("button", { name: /Shortlisted/ }));
    expect(location().pathname).toBe("/offers/shortlisted");
    expect(await screen.findByRole("heading", { level: 1, name: "Offers" })).toBeTruthy();
  });

  it("links to all Offers from New for you", async () => {
    renderDashboard(serverWithOffers([offer({ id: 1 })]).fetch);
    const more = await screen.findByRole("link", { name: "See all" });
    expect(more.getAttribute("href")).toBe("/offers");
  });

  it("lists new rooms, and the star shortlists one", async () => {
    const { fetch, marksSent } = serverWithOffers([offer({ id: 1, title: "Bright room" })]);
    const { user } = renderDashboard(fetch);
    const table = await screen.findByRole("table", { name: "New for you" });
    expect(within(table).getByText("Bright room")).toBeTruthy();
    await user.click(within(table).getByRole("button", { name: "Shortlist" }));
    expect(marksSent).toEqual([{ id: 1, body: { shortlisted: true } }]);
  });

  it("opens a room's card on the Offers page from a click anywhere on its row", async () => {
    const { fetch } = serverWithOffers([
      offer({
        id: 1,
        title: "Bright room",
        reasons: [{ filter: "anmeldung", strength: "want", outcome: "pass" } as never],
      }),
    ]);
    const { user } = renderDashboard(fetch);
    const table = await screen.findByRole("table", { name: "New for you" });
    expect(within(table).queryByRole("button", { name: /Open Bright room/ })).toBeNull();
    const row = within(table).getByRole("link", { name: "Bright room" }).closest("tr") as Element;
    await user.click(row.querySelector(".wh-col-size") as Element);
    expect(await screen.findByRole("heading", { level: 1, name: "Offers" })).toBeTruthy();
    expect(await screen.findByRole("complementary", { name: "Offer details" })).toBeTruthy();
  });
});

describe("rent chart", () => {
  it("shows any day's rent from the arrow keys", async () => {
    const { fetch } = serverWithOffers([
      offer({ id: 1, createdAt: daysAgo(2.5), keyFacts: facts(700) }),
      offer({ id: 2, createdAt: daysAgo(0.5), keyFacts: facts(500) }),
    ]);
    const { user } = renderDashboard(fetch);
    const plot = await screen.findByRole("slider", { name: /Typical rent of your matches/ });
    expect(plot.getAttribute("aria-valuetext")).toBe("€ 600, Today");
    plot.focus();
    await user.keyboard("{ArrowLeft}");
    expect(plot.getAttribute("aria-valuetext")).toMatch(/^€ 700, \d+ \w{3}$/);
    expect(within(plot).getByText("€ 700")).toBeTruthy();
    await user.keyboard("{End}");
    expect(plot.getAttribute("aria-valuetext")).toBe("€ 600, Today");
  });
});

describe("rent series", () => {
  // `now` and each `daysAgo` read the clock separately: a tick between them moves a Match to just
  // after its day's slot. Freeze it so they all read the same instant.
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
  afterEach(() => vi.useRealTimers());

  it("is the median rent of the Matches made by each day, with the change", () => {
    const now = new Date();
    const series = rentSeries(
      [
        offer({ id: 1, createdAt: daysAgo(25), keyFacts: facts(700) }),
        offer({ id: 2, createdAt: daysAgo(2), keyFacts: facts(600) }),
        offer({ id: 3, createdAt: daysAgo(1), band: "near-match", keyFacts: facts(100) }),
      ],
      "30D",
      now,
    );
    expect(series.slots).toBe(30);
    expect(series.points).toHaveLength(26);
    expect(series.points[0]?.rent).toBe(700);
    expect(series.points.at(-1)).toEqual({ rent: 650, label: "Today" });
    expect(series.change).toBe("−€ 50 in 26 days");
  });

  it("holds one slot a day for each range, and keeps the days it has", () => {
    const now = new Date();
    const offers = [
      offer({ id: 1, createdAt: daysAgo(200), keyFacts: facts(500) }),
      offer({ id: 2, createdAt: daysAgo(3.5), keyFacts: facts(700) }),
    ];
    const week = rentSeries(offers, "7D", now);
    expect(week.slots).toBe(7);
    expect(week.points.map((p) => p.rent)).toEqual([500, 500, 500, 600, 600, 600, 600]);
    expect(week.change).toBe("+€ 100 in 7 days");
    expect(rentSeries(offers, "90D", now).points).toHaveLength(90);
    const all = rentSeries(offers, "All", now);
    expect(all.slots).toBe(Math.ceil(201 / 7));
    expect(all.points).toHaveLength(all.slots);
  });

  it("has no points without a Match that states a rent", () => {
    expect(rentSeries([], "30D")).toEqual({ points: [], slots: 0 });
  });
});

const facts = (amount: number) => ({
  warmRent: { amount, converted: false },
  size: 15,
  district: null,
  availableFrom: null,
});
