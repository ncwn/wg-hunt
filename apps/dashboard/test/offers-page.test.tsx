// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MINUTE } from "../../server/test/offers-harness.js";
import { choose } from "./choose.js";
import {
  crawlMore,
  detail,
  limitRent,
  list,
  newBadge,
  openDetails,
  openOffers,
  rowOf,
  show,
  THREE,
  titleLink,
  titles,
} from "./offers-page-harness.js";
import { renderDashboard } from "./render.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the list", () => {
  it("lists Matches and Near matches under All, in band order, and leaves Hidden out", async () => {
    await openOffers(THREE, "/offers/all", ({ server }) => limitRent(server));

    await waitFor(() => expect(titles()).toEqual(["Cheap room", "Dear room"]));
    expect(rowOf("Cheap room").textContent).toMatch(/Match/);
    expect(rowOf("Dear room").textContent).toMatch(/Near match/);
  });

  it("lists the Hidden band only while Show hidden is on", async () => {
    const { user } = await openOffers(THREE, "/offers/all", ({ server }) => limitRent(server));
    await waitFor(() => expect(titles()).toHaveLength(2));

    await user.click(screen.getByRole("switch", { name: "Show hidden" }));
    await waitFor(() => expect(titles()).toEqual(["Cheap room", "Dear room", "Dearest room"]));
    expect(rowOf("Dearest room").textContent).toMatch(/Hidden/);

    await user.click(screen.getByRole("switch", { name: "Show hidden" }));
    await waitFor(() => expect(titles()).toEqual(["Cheap room", "Dear room"]));
  });

  it("chooses Matches, Near matches or All from the Segmented, and keeps the address in step", async () => {
    const { user, location } = await openOffers(THREE, "/offers/all", ({ server }) =>
      limitRent(server),
    );
    await waitFor(() => expect(titles()).toHaveLength(2));
    expect(show().getByRole("button", { name: /^All/ }).getAttribute("aria-pressed")).toBe("true");

    await user.click(show().getByRole("button", { name: /^Near matches/ }));
    await waitFor(() => expect(titles()).toEqual(["Dear room"]));
    expect(location().pathname).toBe("/offers/near-match");
    expect(
      show()
        .getByRole("button", { name: /^Near matches/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    await user.click(show().getByRole("button", { name: /^Matches/ }));
    await waitFor(() => expect(titles()).toEqual(["Cheap room"]));
    expect(screen.queryByRole("switch", { name: "Show hidden" })).toBeNull();

    await user.click(show().getByRole("button", { name: /^All/ }));
    await waitFor(() => expect(titles()).toEqual(["Cheap room", "Dear room"]));
    expect(location().pathname).toBe("/offers/all");
  });

  it("opens on Matches from /offers, keeping a card the link asks for", async () => {
    const { server, unmount } = await openOffers(THREE, "/offers", ({ server }) =>
      limitRent(server),
    );
    await waitFor(() => expect(titles()).toEqual(["Cheap room"]));
    expect(
      show()
        .getByRole("button", { name: /^Matches/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    const [cheap] = (await (await server.call("GET", "/offers")).json()).items;
    unmount();

    const again = renderDashboard(server.fetch, `/offers?offer=${cheap.id}`);
    expect(await screen.findByRole("heading", { level: 2, name: "Cheap room" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Offer details" })).toBeTruthy();
    expect(again.location().pathname).toBe("/offers/match");
    expect(again.location().search).toBe(`?offer=${cheap.id}`);
  });

  it("opens one band from a /offers/<band> link", async () => {
    await openOffers(THREE, "/offers/near-match", ({ server }) => limitRent(server));
    await waitFor(() => expect(titles()).toEqual(["Dear room"]));
    expect(
      show()
        .getByRole("button", { name: /^Near matches/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.queryByRole("switch", { name: "Show hidden" })).toBeNull();
  });

  it("reaches the Hidden band on its own address", async () => {
    await openOffers(THREE, "/offers/hidden", ({ server }) => limitRent(server));
    await waitFor(() => expect(titles()).toEqual(["Dearest room"]));
  });

  it("says when everything is hidden, and where to look", async () => {
    await openOffers(
      [{ id: 9000003, title: "Dearest room", warmRent: 700 }],
      "/offers/all",
      ({ server }) => limitRent(server),
    );
    expect((await list().findByText(/are hidden/)).textContent).toMatch(/All 1 offers/);
  });

  it("says what happens next when a band is empty", async () => {
    await openOffers(
      [{ id: 9000003, title: "Dearest room", warmRent: 700 }],
      "/offers/match",
      ({ server }) => limitRent(server),
    );
    expect(
      await list().findByText(/^No matches yet\. (Next check at|wg-hunt is looking)/),
    ).toBeTruthy();
  });
});

async function star(server: Parameters<typeof limitRent>[0], titlesToStar: string[]) {
  const items = (await (await server.call("GET", "/offers?includeHidden=true")).json()).items;
  for (const item of items as { id: number; title: string }[]) {
    if (titlesToStar.includes(item.title))
      await server.call("PATCH", `/offers/${item.id}/marks`, { shortlisted: true });
  }
}

describe("the Shortlisted view", () => {
  it("lists the starred rooms from every band, Hidden too, at /offers/shortlisted", async () => {
    await openOffers(THREE, "/offers/shortlisted", async ({ server }) => {
      await limitRent(server);
      await star(server, ["Dear room", "Dearest room"]);
    });
    await waitFor(() => expect(titles()).toEqual(["Dear room", "Dearest room"]));
    expect(rowOf("Dearest room").textContent).toMatch(/Hidden/);
    expect(show().getByRole("button", { name: "Shortlisted" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.queryByRole("switch", { name: "Show hidden" })).toBeNull();
  });

  it("is chosen from the Segmented, and a room un-starred there leaves it", async () => {
    const { user, location } = await openOffers(THREE, "/offers/all", async ({ server }) => {
      await limitRent(server);
      await star(server, ["Cheap room", "Dear room"]);
    });
    await waitFor(() => expect(titles()).toHaveLength(2));

    await user.click(show().getByRole("button", { name: "Shortlisted" }));
    await waitFor(() => expect(location().pathname).toBe("/offers/shortlisted"));
    await waitFor(() => expect(titles()).toEqual(["Cheap room", "Dear room"]));

    await user.click(within(rowOf("Cheap room")).getByRole("button", { name: "Shortlist" }));
    await waitFor(() => expect(titles()).toEqual(["Dear room"]));
  });

  it("says how to fill it when nothing is starred", async () => {
    await openOffers(THREE, "/offers/shortlisted", ({ server }) => limitRent(server));
    expect(await list().findByText(/Nothing shortlisted yet/)).toBeTruthy();
  });
});

describe("the Segmented counts", () => {
  it("show each band's count, the same as the API's", async () => {
    const { server } = await openOffers(THREE, "/offers/all", ({ server }) => limitRent(server));
    const api = (await (await server.call("GET", "/offers/counts")).json()).bands;
    expect(api).toEqual({ match: 1, "near-match": 1, warned: 0, hidden: 1 });

    await waitFor(() =>
      expect(show().getByRole("button", { name: /^Matches/ }).textContent).toBe(
        `Matches ${api.match}`,
      ),
    );
    expect(show().getByRole("button", { name: /^Near matches/ }).textContent).toBe(
      `Near matches ${api["near-match"]}`,
    );
  });

  it("follow a band change the server announces", async () => {
    const { server, events } = await openOffers(THREE, "/offers/all", ({ server }) =>
      limitRent(server),
    );
    await waitFor(() => expect(titles()).toEqual(["Cheap room", "Dear room"]));
    const matches = () => show().getByRole("button", { name: /^Matches/ }).textContent;
    await waitFor(() => expect(matches()).toBe("Matches 1"));

    const filters = await (await server.call("GET", "/filters")).json();
    filters.maxRent.limit = 600;
    await server.call("PUT", "/filters", filters);
    const [dear] = (await (await server.call("GET", "/offers?band=match")).json()).items.filter(
      (o: { title: string }) => o.title === "Dear room",
    );
    await events.emit({
      type: "offer-band-changed",
      data: {
        offerId: dear.id,
        band: "match",
        bandChangedAt: dear.bandChangedAt,
      },
    });

    await waitFor(() => expect(matches()).toBe("Matches 2"));
    await waitFor(() => expect(rowOf("Dear room").textContent).toMatch(/Match/));
    expect(rowOf("Dear room").textContent).not.toMatch(/Near match/);
  });
});

async function clickHolding(
  user: ReturnType<typeof renderDashboard>["user"],
  key: string,
  button: string,
  target: Element,
) {
  if (key) await user.keyboard(`{${key}>}`);
  await user.pointer({ keys: button, target });
  if (key) await user.keyboard(`{/${key}}`);
}

describe("a row in the table", () => {
  it("shows the title, warm rent, size, when it is free and its band", async () => {
    await openOffers(THREE, "/offers/all", ({ server }) => limitRent(server));
    await waitFor(() => expect(titles()).toHaveLength(2));
    const row = rowOf("Cheap room");
    const cells = Array.from(row.querySelectorAll("td")).map((td) => td.textContent);
    expect(row.textContent).toMatch(/Testviertel/);
    expect(cells).toContain("€ 450");
    expect(cells).toContain("18 m²");
    expect(cells.at(3)).toMatch(/\d{1,2} \w{3}|Now/);
    expect(cells.at(4)).toBe("Match");
  });

  it("opens the card from a click anywhere on the row, and never folds open in place", async () => {
    const { user } = await openOffers(THREE, "/offers/all", ({ server }) => limitRent(server));
    await waitFor(() => expect(titles()).toHaveLength(2));
    const dear = rowOf("Dear room");
    expect(dear.querySelector(".wh-col-fold")).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Offer details" })).toBeNull();

    await user.click(dear.querySelector(".wh-col-size") as Element);
    expect(await detail().findByRole("heading", { level: 2, name: "Dear room" })).toBeTruthy();
    expect(dear.nextElementSibling?.querySelector(".wh-reasons") ?? null).toBeNull();
    expect(within(rowOf("Dear room")).getByRole("link", { name: "Dear room" })).toBeTruthy();
    expect(rowOf("Dear room").classList.contains("is-open")).toBe(true);
  });

  it.each([
    ["Cmd", "Meta", "[MouseLeft]"],
    ["Ctrl", "Control", "[MouseLeft]"],
    ["middle", "", "[MouseMiddle]"],
  ])("opens a new tab from a %s click on the row, as on its title", async (_, held, button) => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    const { user, location } = await openOffers(THREE, "/offers/all", ({ server }) =>
      limitRent(server),
    );
    await waitFor(() => expect(titles()).toHaveLength(2));
    const dear = rowOf("Dear room");
    const href = titleLink("Dear room").getAttribute("href");

    await clickHolding(user, held, button, dear.querySelector(".wh-col-size") as Element);

    expect(opened).toHaveBeenCalledOnce();
    expect(opened.mock.calls[0]?.[0]).toBe(href);
    expect(opened.mock.calls[0]?.[1]).toBe("_blank");
    expect(location().search).not.toMatch(/offer=/);
    expect(screen.queryByRole("complementary", { name: "Offer details" })).toBeNull();
    expect(dear.classList.contains("is-open")).toBe(false);
  });

  it.each([
    ["Cmd", "Meta", "[MouseLeft]"],
    ["middle", "", "[MouseMiddle]"],
  ])("opens nothing from a %s click on the Save star", async (_, held, button) => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    const { user, location } = await openOffers(THREE, "/offers/all", ({ server }) =>
      limitRent(server),
    );
    await waitFor(() => expect(titles()).toHaveLength(2));

    const star = within(rowOf("Dear room")).getByRole("button", { name: "Shortlist" });
    await clickHolding(user, held, button, star);

    expect(opened).not.toHaveBeenCalled();
    expect(location().search).not.toMatch(/offer=/);
    expect(screen.queryByRole("complementary", { name: "Offer details" })).toBeNull();
  });

  it("draws a Warned Offer from the announcement, with the word Warned", async () => {
    const { events } = await openOffers(THREE, "/offers/all", ({ server }) => limitRent(server));
    await waitFor(() => expect(titles()).toHaveLength(2));
    await events.emit({
      type: "offer-added",
      data: {
        id: 99,
        title: "Looks like a scam",
        band: "warned",
        reasons: [],
        chips: [],
        marks: { dismissed: false, shortlisted: false, contacted: false },
        hiddenBecause: null,
        visibility: { hidden: [], actions: { recheck: true, undismiss: false } },
        bandChangedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        firstSeenAt: new Date().toISOString(),
        lastBumpAt: null,
        keyFacts: { warmRent: null, size: null, district: null, availableFrom: null },
        distance: null,
        category: "flatshare-room",
        url: "https://example.test/99",
        pageStatus: "active",
        stale: false,
        tracked: true,
        analysisState: "pending",
        analysisStatus: {
          status: "queued",
          next: "wait",
          reason: null,
          at: null,
          willRead: true,
        },
      },
    });
    await waitFor(() => expect(titles()).toContain("Looks like a scam"));
    expect(rowOf("Looks like a scam").querySelector(".wh-tag-warned")?.textContent).toBe("Warned");
    expect(rowOf("Cheap room").querySelector(".wh-tag-match")).not.toBeNull();
    expect(list().queryByText(/Awaiting analysis|Not tracked|Analysis failed/)).toBeNull();
  });
});

describe("New marks", () => {
  it("show on every Offer before anything has been marked seen, and on the rail's Offers entry", async () => {
    await openOffers(THREE, "/offers/all", ({ server }) => limitRent(server));
    await waitFor(() => expect(titles()).toHaveLength(2));

    expect(list().getAllByText("New")).toHaveLength(2);
    await waitFor(() => expect(newBadge()?.textContent).toBe("2 new"));
  });

  it("clear with Mark all seen, and the nav count goes with them", async () => {
    const { user } = await openOffers(THREE, "/offers/all", ({ server }) => limitRent(server));
    await waitFor(() => expect(titles()).toHaveLength(2));
    await waitFor(() => expect(newBadge()?.textContent).toBe("2 new"));

    await user.click(screen.getByRole("button", { name: "Mark all seen" }));

    await waitFor(() => expect(list().queryAllByText("New")).toHaveLength(0));
    await waitFor(() => expect(newBadge()).toBeNull());
  });

  it("stay cleared after a reload, because the time is kept in the browser", async () => {
    const first = await openOffers(THREE, "/offers/all", ({ server }) => limitRent(server));
    await waitFor(() => expect(titles()).toHaveLength(2));
    await first.user.click(screen.getByRole("button", { name: "Mark all seen" }));
    first.unmount();

    renderDashboard(first.server.fetch, "/offers/all");
    await screen.findByRole("region", { name: "Offers" });
    await waitFor(() => expect(titles()).toHaveLength(2));
    expect(list().queryAllByText("New")).toHaveLength(0);
  });

  it("come back for an Offer that arrives afterwards", async () => {
    const ctx = await openOffers(THREE, "/offers/all", ({ server }) => limitRent(server));
    await waitFor(() => expect(titles()).toHaveLength(2));
    await ctx.user.click(screen.getByRole("button", { name: "Mark all seen" }));
    await waitFor(() => expect(list().queryAllByText("New")).toHaveLength(0));

    const arrived = await crawlMore(ctx, { id: 9000004, title: "Fresh room", warmRent: 400 });
    await ctx.events.emit({ type: "offer-added", data: arrived });

    await waitFor(() => expect(titles()).toContain("Fresh room"));
    expect(rowOf("Fresh room").querySelector(".wh-new")?.textContent).toBe("New");
    expect(rowOf("Cheap room").querySelector(".wh-new")).toBeNull();
    await waitFor(() => expect(newBadge()?.textContent).toBe("1 new"));
  });

  it("are not shown on hidden Offers", async () => {
    const { user } = await openOffers(THREE, "/offers/all", ({ server }) => limitRent(server));
    await user.click(await screen.findByRole("switch", { name: "Show hidden" }));
    await waitFor(() => expect(titles()).toContain("Dearest room"));
    expect(rowOf("Dearest room").querySelector(".wh-new")).toBeNull();
  });
});

describe("the sort", () => {
  const rents = [
    { id: 9000001, title: "Middle room", warmRent: 450 },
    { id: 9000002, title: "Cheapest room", warmRent: 300 },
    { id: 9000003, title: "Priciest room", warmRent: 480 },
  ];
  const sort = () => screen.getByRole("combobox", { name: "Sort" });

  it("orders Offers by the chosen sort", async () => {
    const { user, requests } = await openOffers(rents);
    await waitFor(() => expect(titles()).toHaveLength(3));

    await choose(user, sort(), "Cheapest first");

    await waitFor(() =>
      expect(titles()).toEqual(["Cheapest room", "Middle room", "Priciest room"]),
    );
    expect(requests.some((r) => r.includes("sort=warm-rent"))).toBe(true);
  });

  it("says so when a distance sort has no Place to measure to, and a sort that works brings the list back", async () => {
    const { user } = await openOffers(rents);
    await waitFor(() => expect(titles()).toHaveLength(3));

    await choose(user, sort(), "Closest to work");
    expect((await screen.findByRole("alert")).textContent).toMatch(/Place/);

    await choose(user, sort(), "Biggest first");
    await waitFor(() => expect(titles()).toHaveLength(3));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("names every sort the API has in plain words", async () => {
    const { user } = await openOffers(rents);
    await user.click(sort());
    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(options.map((o) => [o.getAttribute("data-value"), o.textContent])).toEqual([
      ["recency", "Best fit"],
      ["warm-rent", "Cheapest first"],
      ["rent-per-sqm", "Best value per m²"],
      ["size", "Biggest first"],
      ["available-from", "Free soonest"],
      ["distance", "Closest to work"],
    ]);
  });
});

describe("marks", () => {
  const card = () => detail();

  it("hides a dismissed Offer at once, and it stays hidden after a reload", async () => {
    const ctx = await openOffers(THREE, "/offers/all", ({ server }) => limitRent(server));
    await waitFor(() => expect(titles()).toHaveLength(2));
    await ctx.user.click(within(rowOf("Cheap room")).getByRole("link", { name: "Cheap room" }));
    await ctx.user.click(await card().findByRole("button", { name: "Not for me" }));

    await waitFor(() => expect(titles()).toEqual(["Dear room"]));
    expect(
      card().getByRole("button", { name: "Undo: not for me" }).getAttribute("aria-pressed"),
    ).toBe("true");
    const counts = await (await ctx.server.call("GET", "/offers/counts")).json();
    expect(counts.bands).toMatchObject({ match: 0, hidden: 2 });

    ctx.unmount();
    renderDashboard(ctx.server.fetch, "/offers/all");
    await screen.findByRole("region", { name: "Offers" });
    await waitFor(() => expect(titles()).toEqual(["Dear room"]));
  });

  it("brings the Offer back with Undo, and it shows as Hidden with Show hidden on meanwhile", async () => {
    const ctx = await openOffers(THREE, "/offers/all", ({ server }) => limitRent(server));
    await waitFor(() => expect(titles()).toHaveLength(2));
    await ctx.user.click(within(rowOf("Cheap room")).getByRole("link", { name: "Cheap room" }));
    await ctx.user.click(await card().findByRole("button", { name: "Not for me" }));
    await waitFor(() => expect(titles()).toEqual(["Dear room"]));

    await ctx.user.click(screen.getByRole("switch", { name: "Show hidden" }));
    await waitFor(() => expect(titles()).toContain("Cheap room"));
    expect(rowOf("Cheap room").textContent).toMatch(/Hidden/);

    await ctx.user.click(card().getByRole("button", { name: "Undo: not for me" }));
    await waitFor(() => expect(rowOf("Cheap room").textContent).toMatch(/Match/));
  });

  it("shortlists from the card and from the star, and the two agree", async () => {
    const ctx = await openOffers(THREE, "/offers/all", ({ server }) => limitRent(server));
    await waitFor(() => expect(titles()).toHaveLength(2));
    await ctx.user.click(within(rowOf("Cheap room")).getByRole("link", { name: "Cheap room" }));

    const shortlist = await card().findByRole("button", { name: "Shortlist" });
    expect(shortlist.getAttribute("aria-pressed")).toBe("false");
    await ctx.user.click(shortlist);
    await waitFor(() =>
      expect(card().getByRole("button", { name: "Shortlisted" }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
    await waitFor(() =>
      expect(
        within(rowOf("Cheap room"))
          .getByRole("button", { name: "Shortlist" })
          .getAttribute("aria-pressed"),
      ).toBe("true"),
    );

    await ctx.user.click(within(rowOf("Cheap room")).getByRole("button", { name: "Shortlist" }));
    await waitFor(() => expect(card().getByRole("button", { name: "Shortlist" })).toBeTruthy());
  });

  it("marks contacted from the card's actions", async () => {
    const ctx = await openOffers(THREE, "/offers/all", ({ server }) => limitRent(server));
    await waitFor(() => expect(titles()).toHaveLength(2));
    await ctx.user.click(within(rowOf("Cheap room")).getByRole("link", { name: "Cheap room" }));

    await ctx.user.click(await card().findByRole("button", { name: "Mark contacted" }));

    const contacted = await card().findByRole("button", { name: "Contacted" });
    expect(contacted.getAttribute("aria-pressed")).toBe("true");
  });

  it("puts the card's actions in order: Open on wg-gesucht, Shortlist, Mark contacted, Not for me", async () => {
    const ctx = await openOffers(THREE, "/offers/all", ({ server }) => limitRent(server));
    await waitFor(() => expect(titles()).toHaveLength(2));
    await ctx.user.click(within(rowOf("Cheap room")).getByRole("link", { name: "Cheap room" }));
    await card().findByRole("button", { name: "Not for me" });

    const actions = card().getByRole("article").querySelector(".wh-offer-actions") as HTMLElement;
    expect(Array.from(actions.children).map((el) => el.textContent)).toEqual([
      "Open on wg-gesucht",
      "Shortlist",
      "Mark contacted",
      "Not for me",
    ]);
    const tools = card().getByRole("article").querySelector(".od-tools") as HTMLElement;
    expect(
      within(tools)
        .getAllByRole("button")
        .map((el) => el.textContent),
    ).toEqual(["Recheck", "Re-analyse"]);
    expect(actions.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      card()
        .getByRole("link", { name: /Open on wg-gesucht/ })
        .getAttribute("target"),
    ).toBe("_blank");
  });

  it("shows the Offer's band, four facts and reasons on the card", async () => {
    const ctx = await openOffers(THREE, "/offers/all", ({ server }) => limitRent(server));
    await waitFor(() => expect(titles()).toHaveLength(2));
    await ctx.user.click(within(rowOf("Dear room")).getByRole("link", { name: "Dear room" }));
    await card().findByRole("heading", { level: 2, name: "Dear room" });
    expect(card().getByRole("article").querySelector(".wh-tag-near")?.textContent).toBe(
      "Near match",
    );
    const facts = card().getByLabelText("Key facts");
    expect(facts.textContent).toMatch(/€ 520/);
    expect(facts.children).toHaveLength(4);
    expect(card().queryByText(/Awaiting analysis/)).toBeNull();
  });
});

describe("keyboard and screen readers", () => {
  it("lets Tab reach the controls and every row's button, and Enter open an Offer", async () => {
    const ctx = await openOffers(THREE, "/offers/all", ({ server }) => limitRent(server));
    await waitFor(() => expect(titles()).toHaveLength(2));

    const reached: string[] = [];
    for (let i = 0; i < 40; i++) {
      await ctx.user.tab();
      const el = document.activeElement as HTMLElement;
      reached.push(el.getAttribute("aria-label") ?? el.textContent ?? "");
    }
    expect(reached).toContain("Sort");
    expect(reached).toContain("Mark all seen");
    expect(reached.some((r) => r.includes("Show hidden"))).toBe(true);
    expect(reached.some((r) => r.includes("Cheap room"))).toBe(true);

    within(rowOf("Cheap room")).getByRole("link", { name: "Cheap room" }).focus();
    await ctx.user.keyboard("{Enter}");
    expect(await detail().findByRole("heading", { level: 2, name: "Cheap room" })).toBeTruthy();
  });

  it("works Show hidden and Mark all seen from the keyboard", async () => {
    const ctx = await openOffers(THREE, "/offers/all", ({ server }) => limitRent(server));
    await waitFor(() => expect(titles()).toHaveLength(2));

    screen.getByRole("switch", { name: "Show hidden" }).focus();
    await ctx.user.keyboard(" ");
    await waitFor(() => expect(titles()).toContain("Dearest room"));

    screen.getByRole("button", { name: "Mark all seen" }).focus();
    await ctx.user.keyboard("{Enter}");
    await waitFor(() => expect(list().queryAllByText("New")).toHaveLength(0));
  });
});

describe("live updates", () => {
  it("moves an Offer out of the list when the server announces it hidden", async () => {
    const ctx = await openOffers(THREE, "/offers/all", ({ server }) => limitRent(server));
    await waitFor(() => expect(titles()).toHaveLength(2));
    const [cheap] = (await (await ctx.server.call("GET", "/offers")).json()).items;

    const marked = await (
      await ctx.server.call("PATCH", `/offers/${cheap.id}/marks`, { dismissed: true })
    ).json();
    await ctx.events.emit({
      type: "offer-band-changed",
      data: {
        offerId: cheap.id,
        band: "hidden",
        bandChangedAt: marked.bandChangedAt,
      },
    });

    await waitFor(() => expect(titles()).toEqual(["Dear room"]));
  });

  it("reads the list again when the connection comes back", async () => {
    const ctx = await openOffers(THREE.slice(0, 2), "/offers/all", ({ server }) =>
      limitRent(server),
    );
    await waitFor(() => expect(titles()).toHaveLength(2));
    await crawlMore(ctx, { id: 9000004, title: "Missed room", warmRent: 410 }, 30 * MINUTE);
    expect(titles()).not.toContain("Missed room");

    await ctx.events.reconnect();

    await waitFor(() => expect(titles()[0]).toBe("Missed room"));
  });
});

describe("the open card", () => {
  it("stays as it is, folds open, when its row is starred in the list", async () => {
    const ctx = await openOffers(THREE, "/offers/all", ({ server }) => limitRent(server));
    await waitFor(() => expect(titles()).toHaveLength(2));
    await ctx.user.click(within(rowOf("Cheap room")).getByRole("link", { name: "Cheap room" }));
    await openDetails(ctx.user);
    const opened = detail().getAllByRole("button", { expanded: true }).length;
    expect(opened).toBeGreaterThan(0);

    await ctx.user.click(within(rowOf("Cheap room")).getByRole("button", { name: "Shortlist" }));
    await waitFor(() =>
      expect(
        detail().getByRole("button", { name: "Shortlisted" }).getAttribute("aria-pressed"),
      ).toBe("true"),
    );
    expect(detail().queryByText("Loading…")).toBeNull();
    expect(detail().getAllByRole("button", { expanded: true })).toHaveLength(opened);
  });

  it("shows a star made from the list when its card opens before the star is saved", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ctx = await openOffers(
      THREE,
      "/offers/all",
      ({ server }) => limitRent(server),
      (fetch) => async (request) => {
        if (request.method === "PATCH") await held;
        return fetch(request);
      },
    );
    await waitFor(() => expect(titles()).toHaveLength(2));
    await ctx.user.click(within(rowOf("Cheap room")).getByRole("button", { name: "Shortlist" }));
    await ctx.user.click(within(rowOf("Cheap room")).getByRole("link", { name: "Cheap room" }));
    // The card may read the Offer while the star is still on its way.
    await new Promise((resolve) => setTimeout(resolve, 100));

    release();
    await waitFor(() =>
      expect(
        detail().getByRole("button", { name: "Shortlisted" }).getAttribute("aria-pressed"),
      ).toBe("true"),
    );
  });

  it("forgets a failed star from the list once the view changes", async () => {
    const ctx = await openOffers(
      THREE,
      "/offers/all",
      ({ server }) => limitRent(server),
      (fetch) => async (request) =>
        request.method === "PATCH"
          ? new Response(JSON.stringify({ title: "Busy", status: 503, detail: "Try later." }), {
              status: 503,
              headers: { "Content-Type": "application/problem+json" },
            })
          : fetch(request),
    );
    await waitFor(() => expect(titles()).toHaveLength(2));
    await ctx.user.click(within(rowOf("Cheap room")).getByRole("button", { name: "Shortlist" }));
    expect(await list().findByText(/Try later/)).toBeTruthy();

    await ctx.user.click(show().getByRole("button", { name: /^Matches/ }));
    await waitFor(() => expect(titles()).toEqual(["Cheap room"]));
    expect(list().queryByText(/Try later/)).toBeNull();
  });

  it("is in the address, so it can be linked", async () => {
    const ctx = await openOffers(THREE, "/offers/all", ({ server }) => limitRent(server));
    await waitFor(() => expect(titles()).toHaveLength(2));
    const link = within(rowOf("Cheap room")).getByRole("link", { name: "Cheap room" });
    expect(link.getAttribute("href")).toMatch(/^\/offers\/all\?offer=\d+$/);
    await ctx.user.click(link);
    await detail().findByRole("heading", { level: 2, name: "Cheap room" });
    expect(ctx.location().pathname).toBe("/offers/all");
    expect(ctx.location().search).toMatch(/^\?offer=\d+$/);
  });

  it("closes with Esc, and focus goes back to its row", async () => {
    const ctx = await openOffers(THREE, "/offers/all", ({ server }) => limitRent(server));
    await waitFor(() => expect(titles()).toHaveLength(2));
    await ctx.user.click(within(rowOf("Cheap room")).getByRole("link", { name: "Cheap room" }));
    await detail().findByRole("heading", { level: 2, name: "Cheap room" });

    await ctx.user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Offer details" })).toBeNull(),
    );
    expect(ctx.location().search).toBe("");
    expect(document.activeElement?.textContent).toBe("Cheap room");
  });

  it("closes with its Close button, and on a band page stays on that band", async () => {
    const ctx = await openOffers(THREE, "/offers/match", ({ server }) => limitRent(server));
    await waitFor(() => expect(titles()).toEqual(["Cheap room"]));
    await ctx.user.click(within(rowOf("Cheap room")).getByRole("link", { name: "Cheap room" }));
    await detail().findByRole("heading", { level: 2, name: "Cheap room" });
    expect(ctx.location().pathname).toBe("/offers/match");

    await ctx.user.click(detail().getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Offer details" })).toBeNull(),
    );
    expect(ctx.location().pathname).toBe("/offers/match");
  });

  it("closes when its open row is clicked again: the row is a toggle", async () => {
    const ctx = await openOffers(THREE, "/offers/all", ({ server }) => limitRent(server));
    await waitFor(() => expect(titles()).toHaveLength(2));
    const link = () => within(rowOf("Cheap room")).getByRole("link", { name: "Cheap room" });
    await ctx.user.click(link());
    await detail().findByRole("heading", { level: 2, name: "Cheap room" });

    await ctx.user.click(link());
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Offer details" })).toBeNull(),
    );
    expect(ctx.location().search).toBe("");

    await ctx.user.click(link());
    await detail().findByRole("heading", { level: 2, name: "Cheap room" });
  });

  it("closes with the browser's Back", async () => {
    const ctx = await openOffers(THREE, "/offers/all", ({ server }) => limitRent(server));
    await waitFor(() => expect(titles()).toHaveLength(2));
    await ctx.user.click(within(rowOf("Cheap room")).getByRole("link", { name: "Cheap room" }));
    await detail().findByRole("heading", { level: 2, name: "Cheap room" });
    await ctx.user.click(within(rowOf("Dear room")).getByRole("link", { name: "Dear room" }));
    await detail().findByRole("heading", { level: 2, name: "Dear room" });

    await ctx.back();
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Offer details" })).toBeNull(),
    );
    expect(ctx.location().search).toBe("");
  });
});
