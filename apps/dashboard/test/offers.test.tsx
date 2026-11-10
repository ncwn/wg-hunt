// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  driveCrawl,
  fakeSource,
  MINUTE,
  MORNING,
  offerPageWith,
  relaxCaps,
} from "../../server/test/offers-harness.js";
import { createEventSourceStream, type OfferSummary } from "../src/events.js";
import { choose, rowOf, titleLink, titles } from "./offers-page-harness.js";
import { realServer } from "./real-server.js";
import { fakeEventStream, renderDashboard } from "./render.js";

async function openOffers(
  ads: { id: number; title: string; warmRent: number }[],
  route = "/offers/all",
  prepare?: (ctx: {
    server: ReturnType<typeof realServer>;
    clock: { now: number };
  }) => Promise<void>,
) {
  const source = fakeSource();
  const clock = { now: MORNING };
  const server = realServer({ fetcher: source.fetcher, clock: () => clock.now });
  await server.signIn();
  relaxCaps(server.runtime, clock.now);
  source.site.cards = ads.map(({ id, title }) => ({ id, age: "5 Min.", title }));
  for (const ad of ads) source.site.pages.set(ad.id, offerPageWith(ad));
  if (ads.length > 0) {
    await server.call("POST", "/searches", { city: "Berlin", categories: ["flatshare-room"] });
    await driveCrawl(server.runtime, clock, clock.now + 4 * 60 * MINUTE);
  }
  await prepare?.({ server, clock });
  const events = fakeEventStream();
  const rendered = renderDashboard(server.fetch, route, events.stream);
  await screen.findByRole("heading", { level: 1, name: "Offers" });
  return { ...rendered, server, source, events, clock };
}

const list = () => within(screen.getByRole("region", { name: "Offers" }));
const detail = () => within(screen.getByRole("complementary", { name: "Offer details" }));

describe("Offers page", () => {
  it("puts the photos and the card aside while the session is lost, and gives them back after", async () => {
    const { user, server, events } = await openOffers([
      { id: 9000001, title: "Zimmer am Park", warmRent: 450 },
    ]);
    await choose(user, "Zimmer am Park");
    await user.click(await detail().findByRole("button", { name: "Show photo 1 of 3 full size" }));
    expect(screen.getByRole("dialog", { name: "Photos of Zimmer am Park" })).toBeTruthy();

    await events.endSession("expired");

    const signIn = await screen.findByRole("dialog", { name: "Sign in again" });
    expect(screen.queryByRole("dialog", { name: /Photos of/ })).toBeNull();
    expect(signIn.contains(document.activeElement)).toBe(true);
    await user.keyboard("{ArrowRight}{Escape}");
    await user.type(within(signIn).getByLabelText("Access token"), server.token);
    await user.click(within(signIn).getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sign in again" })).toBeNull());

    const lightbox = screen.getByRole("dialog", { name: "Photos of Zimmer am Park" });
    expect(within(lightbox).getByRole("img").getAttribute("alt")).toBe("Zimmer am Park, 1 of 3");
    expect(screen.getByRole("complementary", { name: "Offer details" })).toBeTruthy();
  });

  it("says an Offer is stale or no longer tracked on its card, not as a tag in the list", async () => {
    const day = 24 * 60 * MINUTE;
    const { user } = await openOffers(
      [
        { id: 9000001, title: "Zimmer am Park", warmRent: 450 },
        { id: 9000002, title: "Zimmer am Kanal", warmRent: 520 },
      ],
      "/offers/all",
      async ({ server, clock }) => {
        clock.now += 8 * day;
        const searches = (await (await server.call("GET", "/searches")).json()).items as {
          id: number;
        }[];
        await server.call("PATCH", `/searches/${searches[0]?.id}`, { enabled: false });
      },
    );

    await user.click(await screen.findByRole("switch", { name: "Show hidden" }));
    const park = await waitFor(() => rowOf("Zimmer am Park"));
    expect(park.textContent).not.toMatch(/Stale|Not tracked/);
    await choose(user, "Zimmer am Park");
    const notes = await detail().findByText(/not bumped for over a week/i);
    expect(notes.textContent).toMatch(/It comes back when it's bumped/);
    expect(notes.textContent).toMatch(/none of your Searches finds it any more/);
  });

  it("invites a first crawl when there are no Offers", async () => {
    await openOffers([]);
    expect(
      await screen.findByText(/^No offers yet\. (Next check at|wg-hunt is looking)/),
    ).toBeTruthy();
    expect(screen.queryByText(/Pick an offer/)).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Offer details" })).toBeNull();
  });

  it("lists the Offers a crawl found with their key facts", async () => {
    await openOffers([
      { id: 9000001, title: "Zimmer am Park", warmRent: 450 },
      { id: 9000002, title: "Zimmer am Kanal", warmRent: 520 },
    ]);

    const park = await waitFor(() => rowOf("Zimmer am Park"));
    expect(park.textContent).toMatch(/€ 450/);
    expect(park.textContent).toMatch(/18 m²/);
    expect(park.textContent).toMatch(/Testviertel/);
    expect(rowOf("Zimmer am Kanal").textContent).toMatch(/€ 520/);
  });

  it("shows the chosen Offer beside the list: key facts, photos, facts and its ad", async () => {
    const { user } = await openOffers([{ id: 9000001, title: "Zimmer am Park", warmRent: 450 }]);

    await choose(user, "Zimmer am Park");

    expect(await detail().findByRole("heading", { level: 2, name: "Zimmer am Park" })).toBeTruthy();

    const strip = within(detail().getByLabelText("Key facts"));
    expect(strip.getByText("Warm rent").nextSibling?.textContent).toBe("€ 450");
    expect(strip.getByText("Size").nextSibling?.textContent).toBe("18 m²");
    expect(strip.getByText("Move in").nextSibling?.textContent).toMatch(/2026|Now|\d/);
    expect(detail().getAllByText("Testviertel").length).toBeGreaterThan(0);

    // They are decorative inside the buttons that name them, so they are found as <img>s.
    const photos = Array.from(detail().getByRole("article").querySelectorAll("img"));
    expect(photos.length).toBeGreaterThanOrEqual(3);
    for (const photo of photos) {
      expect(photo.getAttribute("src")).toMatch(/^https:\/\/img\.wg-gesucht\.de\/media\/up\//);
    }
    const thumbs = within(detail().getByRole("list", { name: "Photos" })).getAllByRole("button");
    expect(thumbs.map((thumb) => thumb.getAttribute("aria-label"))).toEqual([
      "Photo 1 of 3",
      "Photo 2 of 3",
      "Photo 3 of 3",
    ]);
    expect(thumbs[0]?.getAttribute("aria-pressed")).toBe("true");
    await user.click(thumbs[1] as HTMLElement);
    expect(thumbs[1]?.getAttribute("aria-pressed")).toBe("true");

    await user.click(detail().getByRole("button", { name: "Show photo 2 of 3 full size" }));
    const lightbox = screen.getByRole("dialog", { name: "Photos of Zimmer am Park" });
    expect(within(lightbox).getByRole("img").getAttribute("alt")).toBe("Zimmer am Park, 2 of 3");
    await user.click(within(lightbox).getByRole("button", { name: "Next photo" }));
    expect(within(lightbox).getByRole("img").getAttribute("alt")).toBe("Zimmer am Park, 3 of 3");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: /Photos of/ })).toBeNull();
    expect(screen.getByRole("complementary", { name: "Offer details" })).toBeTruthy();

    const facts = within(detail().getByRole("table", { name: "Offer Facts" }));
    const row = facts.getByRole("row", { name: /Room size/ });
    expect(within(row).getByRole("rowheader").textContent).toBe("Room size");
    const cells = within(row)
      .getAllByRole("cell")
      .map((cell) => cell.textContent);
    expect(cells).toEqual(["18 m²", "Rules", "Zimmergröße: 18m²", "Override"]);

    const link = detail().getByRole("link", { name: /Open on wg-gesucht/ });
    expect(link.getAttribute("href")).toBe(
      "https://www.wg-gesucht.de/wg-zimmer-in-Teststadt-Mitte.9000001.html",
    );
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("keeps Recheck on the card and its sections folded", async () => {
    const { user } = await openOffers([{ id: 9000001, title: "Zimmer am Park", warmRent: 450 }]);
    await user.click(await waitFor(() => titleLink("Zimmer am Park")));
    expect(await detail().findByRole("button", { name: "Recheck" })).toBeTruthy();
    const facts = await detail().findByRole("button", { name: "Facts" });
    expect(facts.getAttribute("aria-expanded")).toBe("false");
    expect(detail().queryByRole("table", { name: "Offer Facts" })).toBeNull();
    await user.click(facts);
    expect(detail().getByRole("table", { name: "Offer Facts" })).toBeTruthy();
  });

  it("opens the Offer a link points at", async () => {
    const first = await openOffers([{ id: 9000001, title: "Zimmer am Park", warmRent: 450 }]);
    const id = (await (await first.server.call("GET", "/offers")).json()).items[0].id;
    first.unmount();

    renderDashboard(first.server.fetch, `/offers/all?offer=${id}`);
    expect(await screen.findByRole("heading", { level: 2, name: "Zimmer am Park" })).toBeTruthy();
  });

  it("opens an old /offer/<id> link as the card on the Offers page", async () => {
    const first = await openOffers([{ id: 9000001, title: "Zimmer am Park", warmRent: 450 }]);
    const id = (await (await first.server.call("GET", "/offers")).json()).items[0].id;
    first.unmount();

    renderDashboard(first.server.fetch, `/offer/${id}`);
    expect(await screen.findByRole("heading", { level: 2, name: "Zimmer am Park" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Offers" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Offer details" })).toBeTruthy();
  });

  it("says so when the chosen Offer is not known", async () => {
    await openOffers([], "/offers/all?offer=999");
    expect((await screen.findByRole("alert")).textContent).toMatch(/isn.t known/);
  });

  it("adds an Offer to the top of the list as soon as the server announces it", async () => {
    const { events, server } = await openOffers([
      { id: 9000001, title: "Zimmer am Park", warmRent: 450 },
    ]);
    await waitFor(() => expect(titles()).toEqual(["Zimmer am Park"]));
    const [existing] = (await (await server.call("GET", "/offers")).json()).items as OfferSummary[];
    if (!existing) throw new Error("expected an Offer");

    await events.emit({
      type: "offer-added",
      data: { ...existing, id: existing.id + 1, title: "Zimmer am Fluss" },
    });

    expect(titles()).toEqual(["Zimmer am Fluss", "Zimmer am Park"]);

    await events.emit({
      type: "offer-added",
      data: { ...existing, id: existing.id + 1, title: "Zimmer am Fluss" },
    });
    expect(titles()).toHaveLength(2);
  });

  it("puts an announced Offer bumped earlier, as a split-off one is, where its last Bump sorts it", async () => {
    const { events, server } = await openOffers([
      { id: 9000001, title: "Zimmer am Park", warmRent: 450 },
      { id: 9000002, title: "Zimmer am Hof", warmRent: 460 },
    ]);
    await waitFor(() => expect(titles()).toHaveLength(2));
    const items = (await (await server.call("GET", "/offers")).json()).items as OfferSummary[];
    const [first] = items;
    if (!first?.lastBumpAt) throw new Error("expected a bumped Offer");
    const day = 24 * 60 * MINUTE;

    await events.emit({
      type: "offer-added",
      data: {
        ...first,
        id: 99,
        title: "Zimmer am Fluss",
        lastBumpAt: new Date(Date.parse(first.lastBumpAt) - day).toISOString(),
      },
    });

    expect(titles()).toEqual([...items.map((item) => item.title), "Zimmer am Fluss"]);
  });

  it("loads more Offers when there are more than one page", async () => {
    const ads = Array.from({ length: 52 }, (_, i) => ({
      id: 9100000 + i,
      title: `Zimmer Nr ${i}`,
      warmRent: 400 + i,
    }));
    const { user } = await openOffers(ads);

    await waitFor(() => expect(titles()).toHaveLength(50));
    await user.click(list().getByRole("button", { name: "Show more" }));
    await waitFor(() => expect(titles()).toHaveLength(52));
    expect(list().queryByRole("button", { name: "Show more" })).toBeNull();
  }, 30_000);
});

describe("Recheck", () => {
  const queuedRechecks = (server: ReturnType<typeof realServer>) =>
    server.runtime.db.$client.prepare("select path from crawl_jobs where kind = 'recheck'").all();

  it("queues one Recheck of the chosen Offer from its button", async () => {
    const { user, server } = await openOffers([
      { id: 9000001, title: "Zimmer am Park", warmRent: 450 },
    ]);
    await choose(user, "Zimmer am Park");
    const button = await detail().findByRole("button", { name: "Recheck" });
    expect(queuedRechecks(server)).toEqual([]);

    await user.click(button);

    expect(await detail().findByText(/Queued/)).toBeTruthy();
    expect(queuedRechecks(server)).toEqual([
      { path: "/wg-zimmer-in-Teststadt-Mitte.9000001.html" },
    ]);
  });

  it("is switched off for an Offer no enabled Search matches", async () => {
    const { user } = await openOffers(
      [{ id: 9000001, title: "Zimmer am Park", warmRent: 450 }],
      "/offers/all",
      async ({ server }) => {
        const searches = (await (await server.call("GET", "/searches")).json()).items as {
          id: number;
        }[];
        await server.call("PATCH", `/searches/${searches[0]?.id}`, { enabled: false });
      },
    );
    await user.click(await screen.findByRole("switch", { name: "Show hidden" }));
    await choose(user, "Zimmer am Park");
    const button = await detail().findByRole("button", { name: "Recheck" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("when the event stream reconnects", () => {
  it("reads the Offers again, so those announced while it was down appear", async () => {
    const { server, source, events, clock } = await openOffers([
      { id: 9000001, title: "Zimmer am Park", warmRent: 450 },
    ]);
    await waitFor(() => expect(titles()).toEqual(["Zimmer am Park"]));

    source.site.cards = [
      { id: 9000002, age: "5 Min.", title: "Zimmer am Kanal" },
      { id: 9000001, age: "5 Min.", title: "Zimmer am Park" },
    ];
    source.site.pages.set(9000002, offerPageWith({ title: "Zimmer am Kanal", warmRent: 520 }));
    await driveCrawl(server.runtime, clock, clock.now + 2 * 60 * MINUTE);
    expect(titles()).not.toContain("Zimmer am Kanal");

    await events.reconnect();

    await waitFor(() => expect(titles()).toEqual(["Zimmer am Kanal", "Zimmer am Park"]));
  });
});

describe("the event stream over EventSource", () => {
  class FakeEventSource {
    static last: FakeEventSource | undefined;
    private listeners = new Map<string, (() => void)[]>();
    constructor(readonly url: string) {
      FakeEventSource.last = this;
    }
    addEventListener(type: string, listener: () => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    close() {}
    fire(type: string) {
      for (const listener of this.listeners.get(type) ?? []) listener();
    }
  }

  it("tells listeners about a reconnection, but not about the first connection", () => {
    const stream = createEventSourceStream({
      EventSource: FakeEventSource as unknown as typeof EventSource,
    });
    let reconnected = 0;
    stream.onReconnect(() => reconnected++);
    stream.subscribe(() => {});

    FakeEventSource.last?.fire("open");
    expect(reconnected).toBe(0);
    FakeEventSource.last?.fire("open");
    expect(reconnected).toBe(1);
  });
});
