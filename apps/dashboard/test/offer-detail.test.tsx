// @vitest-environment jsdom

import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fakeProvider,
  outputWith,
  sure,
  unsure,
} from "../../../packages/core/src/analysis/testing.js";
import { offerAds, offerPairOverrides } from "../../server/src/db/schema.js";
import {
  driveCrawl,
  fakeSource,
  MINUTE,
  MORNING,
  offerPageWith,
  relaxCaps,
} from "../../server/test/offers-harness.js";
import { chosenLabel, choose as pickOption } from "./choose.js";
import { choose, openDetails, rowOf, titleLink } from "./offers-page-harness.js";
import { realServer } from "./real-server.js";
import { fakeEventStream, renderDashboard } from "./render.js";

const KEY = "sk-ant-api03-dashboard-test-key-0123456789";

type Ad = { id: number; title: string; warmRent: number };

const THREE: Ad[] = [
  { id: 9000001, title: "Cheap room", warmRent: 450 },
  { id: 9000002, title: "Dear room", warmRent: 520 },
  { id: 9000003, title: "Dearest room", warmRent: 700 },
];

async function open(
  options: {
    ads?: Ad[];
    script?: Parameters<typeof fakeProvider>[0];
    needAnmeldung?: boolean;
    page?: (html: string) => string;
    select?: string;
    wrap?: (
      fetch: (request: Request) => Promise<Response>,
    ) => (request: Request) => Promise<Response>;
    prepare?: (ctx: {
      server: ReturnType<typeof realServer>;
      idOf: (title: string) => Promise<number>;
    }) => Promise<void>;
  } = {},
) {
  const { ads = THREE, script, needAnmeldung = false, page = (html) => html } = options;
  const fake = fakeProvider(script ?? [outputWith({})]);
  const source = fakeSource();
  const clock = { now: MORNING };
  const server = realServer({
    fetcher: source.fetcher,
    clock: () => clock.now,
    analysis: { providerFor: () => fake.provider, sleep: async () => {} },
  });
  await server.signIn();
  relaxCaps(server.runtime, clock.now);
  if (script !== undefined) await server.call("PUT", "/secrets/anthropic", { value: KEY });
  const filters = await (await server.call("GET", "/filters")).json();
  filters.maxRent.limit = 500;
  filters.maxRent.margin = { value: 50, unit: "absolute" };
  await server.call("PUT", "/filters", filters);
  if (needAnmeldung) {
    const profile = await (await server.call("GET", "/profile")).json();
    await server.call("PUT", "/profile", { ...profile, anmeldungNeeded: true });
  }
  source.site.cards = ads.map(({ id, title }) => ({ id, age: "5 Min.", title }));
  for (const ad of ads) source.site.pages.set(ad.id, page(offerPageWith(ad)));
  await server.call("POST", "/searches", { city: "Berlin", categories: ["flatshare-room"] });
  await driveCrawl(server.runtime, clock, clock.now + 4 * 60 * MINUTE);
  await server.runtime.analysis.idle();
  vi.setSystemTime(clock.now);
  const idOf = async (title: string): Promise<number> => {
    const items = (await (await server.call("GET", "/offers?includeHidden=true")).json()).items;
    return items.find((item: { title: string }) => item.title === title).id;
  };
  await options.prepare?.({ server, idOf });
  const events = fakeEventStream();
  const route =
    options.select === undefined
      ? "/offers/all"
      : `/offers/all?offer=${await idOf(options.select)}`;
  const fetch = options.wrap ? options.wrap(server.fetch) : server.fetch;
  const rendered = renderDashboard(fetch, route, events.stream);
  await screen.findByRole("heading", { level: 1 });
  if (options.select !== undefined) await openDetails(rendered.user);
  return { ...rendered, server, events, idOf, ...fake };
}

const detail = () => within(screen.getByRole("complementary", { name: "Offer details" }));

const selected = chosenLabel;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

async function likelyNotice(user: { click: (el: Element) => Promise<void> }) {
  const head = await detail().findByRole("button", { name: /Might be a scam/ });
  if (head.getAttribute("aria-expanded") === "false") await user.click(head);
  return head.closest(".wh-notice") as HTMLElement;
}

const band = () =>
  detail().getByRole("article").querySelector(".wh-offer-head .wh-tag")?.textContent ?? "";
const bandIs = (word: string) => waitFor(() => expect(band()).toBe(word));

function order(pane: ReturnType<typeof detail>): string[] {
  const marks: [string, Element | null][] = [
    ["photos", pane.queryByRole("button", { name: /^Show photo 1 of \d+ full size$/ })],
    ["title", pane.getByRole("heading", { level: 2 })],
    ["notes", pane.queryByText(/^Hidden( by a dealbreaker)?:/)],
    ["scam", pane.queryByRole("button", { name: /Might be a scam/ })],
    ["rent history", pane.queryByRole("region", { name: "Rent history" })],
    ["key facts", pane.queryByLabelText("Key facts")],
    ["more about", pane.queryByLabelText("More about this room")],
    ["reasons", pane.queryByRole("group", { name: "How it fits you" })],
    ["asks for", pane.queryByRole("group", { name: "The ad asks for" })],
    ["actions", pane.getByRole("button", { name: /^Shortlist/ })],
    ["more actions", pane.getByRole("button", { name: "Recheck" })],
    ["scam", pane.queryByRole("region", { name: "Scam check" })],
    ["facts", pane.getByRole("region", { name: "Facts" })],
  ];
  return marks
    .filter((mark): mark is [string, Element] => mark[1] !== null)
    .sort(([, a], [, b]) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    )
    .map(([name]) => name);
}

const TOP = ["photos", "title"];
const BODY = ["rent history", "key facts", "more about"];
const BOTTOM = ["actions", "more actions", "scam", "facts"];

describe("the sections of the card", () => {
  it("come in the designed order for a Match", async () => {
    const { user } = await open();
    await choose(user, "Cheap room");
    await detail().findByRole("table", { name: "Offer Facts" });
    expect(order(detail())).toEqual([...TOP, ...BODY, ...BOTTOM]);
  });

  it("come in the designed order for a Near match", async () => {
    const { user } = await open();
    await choose(user, "Dear room");
    await detail().findByRole("table", { name: "Offer Facts" });
    expect(order(detail())).toEqual([...TOP, ...BODY, "reasons", ...BOTTOM]);
  });

  it("come in the designed order for a Warned Offer, with the scam Notice first", async () => {
    await open({
      select: "Cheap room",
      prepare: async ({ server, idOf }) => {
        await server.call("PATCH", `/offers/${await idOf("Cheap room")}/marks`, { scam: "scam" });
      },
    });
    await detail().findByRole("table", { name: "Offer Facts" });
    expect(order(detail())).toEqual([
      ...TOP,
      "scam",
      ...BODY,
      ...BOTTOM.filter((name) => name !== "scam"),
    ]);
    expect(detail().getByRole("alert").textContent).toMatch(/Might be a scam/);
  });

  it("come in the designed order for a Hidden Offer, with why it is hidden under the title", async () => {
    await open({ select: "Dearest room" });
    await detail().findByRole("table", { name: "Offer Facts" });
    expect(order(detail())).toEqual([...TOP, "notes", ...BODY, "reasons", ...BOTTOM]);
  });

  it("are folded until opened, with no explanation beside their names", async () => {
    const { user } = await open();
    await user.click(await waitFor(() => titleLink("Cheap room")));
    await detail().findByRole("article");
    for (const name of ["Scam check", "Facts"]) {
      const head = within(detail().getByRole("region", { name })).getByRole("button");
      expect(head.getAttribute("aria-expanded")).toBe("false");
      expect(head.textContent).toBe(name);
    }
    expect(detail().getByLabelText("More about this room").closest(".wh-disclosure")).toBeNull();
  });
});

describe("the card's reason chips", () => {
  const chips = () =>
    within(detail().getByRole("group", { name: "How it fits you" }))
      .getAllByRole("listitem")
      .map((item) => item.textContent ?? "");

  it("give a chip per Filter that is a concern, its outcome said first, with no glyph", async () => {
    const { user } = await open();
    await choose(user, "Dear room");
    await bandIs("Near match");

    expect(chips()).toContain("Check: Warm rent");
    const group = detail().getByRole("group", { name: "How it fits you" });
    expect(group.textContent).not.toMatch(/[✓⚠✗]/);
  });

  it("say Doesn't fit for a Filter that misses, and the card names the Dealbreaker that hides it", async () => {
    await open({ select: "Dearest room" });
    await bandIs("Hidden");
    expect(chips()[0]).toBe("Doesn't fit: Warm rent");
    const note = detail().getByText(/Hidden by a dealbreaker/);
    expect(note.closest(".wh-notice")).not.toBeNull();
    expect(note.textContent).toMatch(/Hidden by a dealbreaker: Warm rent\./);
  });

  it("leave out what fits and the key facts already show, so a Match has none", async () => {
    const { user } = await open();
    await choose(user, "Cheap room");
    await bandIs("Match");
    expect(detail().queryByRole("group", { name: "How it fits you" })).toBeNull();
    const facts = within(detail().getByLabelText("Key facts"));
    expect(facts.getByText("Warm rent").nextSibling?.textContent).toBe("€ 450");
  });

  it("go with the reason an Offer is Hidden, whatever the Filters say", async () => {
    await open({
      select: "Cheap room",
      prepare: async ({ server, idOf }) => {
        await server.call("PATCH", `/offers/${await idOf("Cheap room")}/marks`, {
          dismissed: true,
        });
      },
    });
    expect(
      await detail().findByText(
        /Hidden: you marked it not for me.*\. It comes back when you undo it\./,
      ),
    ).toBeTruthy();
    await bandIs("Hidden");
  });
});

describe("the Recheck button", () => {
  it("says why it can't recheck when the Offer is Tracked but its current Ad ID is not", async () => {
    await open({
      select: "Cheap room",
      prepare: async ({ server, idOf }) => {
        server.runtime.db
          .insert(offerAds)
          .values({
            source: "wg-gesucht",
            adId: "9000099",
            offerId: await idOf("Cheap room"),
            path: "/wg-zimmer-in-Berlin-Mitte.9000099.html",
            firstSeenAt: new Date(Date.now()),
            lastBumpAt: new Date(Date.now()),
            pageStatus: "active",
          })
          .run();
      },
    });
    const button = await detail().findByRole("button", { name: "Recheck" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("title")).toBe(
      "No Search lists this Offer's current ad, so wg-hunt doesn't crawl it",
    );
  });

  it("says no Search finds the Offer when none does", async () => {
    await open({
      select: "Cheap room",
      prepare: async ({ server }) => {
        const [search] = (await (await server.call("GET", "/searches")).json()).items;
        await server.call("PATCH", `/searches/${search.id}`, { enabled: false });
      },
    });
    const button = await detail().findByRole("button", { name: "Recheck" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("title")).toBe("None of your Searches finds this Offer");
  });
});

describe("the Likely scam panel", () => {
  it("offers Mark as scam on an Offer without signals, and the band changes at once", async () => {
    const { user } = await open();
    await choose(user, "Cheap room");

    const panel = await detail().findByRole("region", { name: "Scam check" });
    expect(panel.textContent).toMatch(/No Scam signals/);
    expect(within(panel).queryByRole("button", { name: "Clear my mark" })).toBeNull();

    await user.click(within(panel).getByRole("button", { name: "Mark as scam" }));

    const marked = await likelyNotice(user);
    expect(marked.textContent).toMatch(/You marked it as a scam/);
    await bandIs("Warned");
    await waitFor(() =>
      expect(rowOf("Cheap room").querySelector(".wh-tag-warned")?.textContent).toBe("Warned"),
    );
  });

  it("clears the mark so the computed verdict stands again", async () => {
    const { user } = await open();
    await choose(user, "Cheap room");
    await user.click(await detail().findByRole("button", { name: "Mark as scam" }));
    await likelyNotice(user);

    await user.click(detail().getByRole("button", { name: "Clear my mark" }));

    await detail().findByRole("region", { name: "Scam check" });
    await bandIs("Match");
    expect(detail().queryByRole("button", { name: "Clear my mark" })).toBeNull();
  });

  it("lists strong and soft signals with their quotes, which are text and never markup", async () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const { user, idOf } = await open({
      ads: [{ id: 9000001, title: "Cheap room", warmRent: 450 }],
      script: [
        outputWith({
          scamSignals: [
            { kind: "money_before_viewing", ...sure(hostile) },
            { kind: "off_platform_contact", ...sure("Anmeldung ist möglich") },
          ],
        }),
      ],
      page: (html) =>
        html.replace(
          "Anmeldung ist möglich.",
          `Anmeldung ist möglich. &lt;img src=x onerror=alert(1)&gt;`,
        ),
    });
    await idOf("Cheap room");
    await choose(user, "Cheap room");

    const panel = await likelyNotice(user);
    expect(panel.getAttribute("role")).toBe("alert");
    const signals = within(panel).getAllByRole("listitem");
    expect(signals).toHaveLength(2);
    expect(signals[0]?.textContent).toMatch(/^Strong: /);
    expect(signals[0]?.textContent).toContain(hostile);
    expect(signals[1]?.textContent).toMatch(/^Soft: /);
    expect(signals[1]?.textContent).toContain("Anmeldung ist möglich");
    expect(document.querySelector("img[src='x']")).toBeNull();
    expect(panel.querySelector("img")).toBeNull();
    expect(panel.textContent).toMatch(/Why it is a Likely scam|strong/i);
  });

  it("lets Not a scam override strong signals", async () => {
    const { user, server, idOf } = await open();
    const id = await idOf("Cheap room");
    await server.call("PUT", `/offers/${id}/facts/scamSignals`, { value: ["keys_by_post"] });
    await choose(user, "Cheap room");
    const panel = await likelyNotice(user);

    await user.click(within(panel).getByRole("button", { name: "Not a scam" }));

    const after = await detail().findByRole("region", { name: "Scam check" });
    await user.click(within(after).getByRole("button", { name: "Scam check" }));
    expect(after.textContent).toMatch(/You marked it as not a scam/);
    expect(within(after).getByRole("button", { name: "Clear my mark" })).toBeTruthy();
    await bandIs("Match");
  });

  it("shows a signal's evidence when a rule worked it out", async () => {
    await open({
      ads: [{ id: 9000001, title: "Cheap room", warmRent: 450 }],
      select: "Cheap room",
      prepare: async ({ server, idOf }) => {
        const id = await idOf("Cheap room");
        await server.call("PUT", `/offers/${id}/facts/memberSince`, { value: "2026-11" });
        await server.call("PUT", `/offers/${id}/facts/verified`, { value: false });
        await server.call("PUT", `/offers/${id}/facts/companyProfile`, { value: "unknown" });
      },
    });
    const panel = await detail().findByRole("region", { name: "Scam check" });
    const [signal] = within(panel).getAllByRole("listitem");
    expect(signal?.textContent).toMatch(/^Soft: /);
    expect(signal?.textContent).toContain("member since 2026-11, not Verifiziert");
  });
});

describe("the Offer Facts table", () => {
  it("shows an Anmeldung the model read, and lets you override it with a value that wins", async () => {
    const { user, idOf, server } = await open({
      ads: [{ id: 9000001, title: "Cheap room", warmRent: 450 }],
      script: [
        outputWith({ anmeldung: { value: "not_possible", ...sure("Anmeldung ist möglich") } }),
      ],
      needAnmeldung: true,
      select: "Cheap room",
    });
    const id = await idOf("Cheap room");
    await bandIs("Hidden");

    await user.click(await detail().findByRole("button", { name: "Override Anmeldung" }));
    const form = detail().getByRole("form", { name: "Override Anmeldung" });
    await pickOption(user, within(form).getByRole("combobox"), "possible");
    await user.click(within(form).getByRole("button", { name: "Save override" }));

    await bandIs("Match");
    const row = within(detail().getByRole("table", { name: "Offer Facts" })).getByRole("row", {
      name: /Anmeldung/,
    });
    expect(row.textContent).toMatch(/possible/);
    expect(row.textContent).toMatch(/You/);
    expect(row.textContent).toMatch(/Your correction/);
    expect(row.textContent).toMatch(/not possible/);
    const stored = await (await server.call("GET", `/offers/${id}`)).json();
    expect(stored.facts.anmeldung.origin).toBe("manual");
    await waitFor(() => expect(rowOf("Cheap room").querySelector(".wh-tag-match")).not.toBeNull());
  });

  const editTheAds = (server: ReturnType<typeof realServer>) =>
    server.runtime.db
      .update(offerAds)
      .set({ contentHash: "f".repeat(64) })
      .run();

  it("says so beside a correction when the ad's words changed since it was made", async () => {
    await open({
      ads: [{ id: 9000001, title: "Cheap room", warmRent: 450 }],
      select: "Cheap room",
      prepare: async ({ server, idOf }) => {
        const id = await idOf("Cheap room");
        await server.call("PUT", `/offers/${id}/facts/roomSize`, { value: 25 });
        await server.call("PUT", `/offers/${id}/facts/scamSignals`, { value: [] });
        editTheAds(server);
      },
    });
    const row = within(await detail().findByRole("table", { name: "Offer Facts" })).getByRole(
      "row",
      { name: /Room size/ },
    );
    expect(row.textContent).toMatch(/Your correction.*The ad changed since/);
    const silent = within(detail().getByRole("list", { name: "Facts without a value" }));
    expect(silent.getByText("Scam signals").closest("li")?.textContent).toMatch(
      /The ad changed since/,
    );
  });

  it("says it once for a list fact, not on each of its items", async () => {
    await open({
      ads: [{ id: 9000001, title: "Cheap room", warmRent: 450 }],
      select: "Cheap room",
      prepare: async ({ server, idOf }) => {
        const id = await idOf("Cheap room");
        await server.call("PUT", `/offers/${id}/facts/scamSignals`, {
          value: ["keys_by_post", "money_before_viewing"],
        });
        editTheAds(server);
      },
    });
    const table = await detail().findByRole("table", { name: "Offer Facts" });
    expect(within(table).getAllByRole("row", { name: /Scam signals/ })).toHaveLength(2);
    expect(within(table).getAllByText("The ad changed since.")).toHaveLength(1);
  });

  it("says nothing more beside a correction made on the words the ad still shows", async () => {
    await open({
      ads: [{ id: 9000001, title: "Cheap room", warmRent: 450 }],
      select: "Cheap room",
      prepare: async ({ server, idOf }) => {
        const id = await idOf("Cheap room");
        await server.call("PUT", `/offers/${id}/facts/roomSize`, { value: 25 });
      },
    });
    const row = within(await detail().findByRole("table", { name: "Offer Facts" })).getByRole(
      "row",
      { name: /Room size/ },
    );
    expect(row.textContent).toMatch(/Your correction/);
    expect(row.textContent).not.toMatch(/changed since/);
  });

  it("reverts an override to what the model read", async () => {
    const { user } = await open({
      ads: [{ id: 9000001, title: "Cheap room", warmRent: 450 }],
      script: [
        outputWith({ anmeldung: { value: "not_possible", ...sure("Anmeldung ist möglich") } }),
      ],
      needAnmeldung: true,
      select: "Cheap room",
      prepare: async ({ server, idOf }) => {
        const id = await idOf("Cheap room");
        await server.call("PUT", `/offers/${id}/facts/anmeldung`, { value: "possible" });
      },
    });
    await bandIs("Match");

    await user.click(await detail().findByRole("button", { name: "Revert Anmeldung" }));

    await bandIs("Hidden");
    const row = within(detail().getByRole("table", { name: "Offer Facts" })).getByRole("row", {
      name: /Anmeldung/,
    });
    expect(row.textContent).toMatch(/not possible/);
    expect(row.textContent).toMatch(/Model/);
    expect(detail().queryByRole("button", { name: "Revert Anmeldung" })).toBeNull();
  });

  it("can't send a Revert twice while the first is on its way", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reverts = 0;
    const { user } = await open({
      ads: [{ id: 9000001, title: "Cheap room", warmRent: 450 }],
      select: "Cheap room",
      prepare: async ({ server, idOf }) => {
        const id = await idOf("Cheap room");
        await server.call("PUT", `/offers/${id}/facts/roomSize`, { value: 25 });
      },
      wrap: (fetch) => async (request) => {
        if (request.method === "DELETE" && /\/facts\/roomSize$/.test(request.url)) {
          reverts += 1;
          await held;
        }
        return fetch(request);
      },
    });
    const revert = await detail().findByRole("button", { name: "Revert Room size" });
    await user.click(revert);
    await waitFor(() => expect((revert as HTMLButtonElement).disabled).toBe(true));
    await user.click(revert);
    expect(reverts).toBe(1);

    release();
    await waitFor(() =>
      expect(detail().queryByRole("button", { name: "Revert Room size" })).toBeNull(),
    );
  });

  it("corrects a number with a number field and says when the server refuses a value", async () => {
    const { user } = await open({ ads: [{ id: 9000001, title: "Cheap room", warmRent: 450 }] });
    await choose(user, "Cheap room");

    await user.click(await detail().findByRole("button", { name: "Override Room size" }));
    const form = detail().getByRole("form", { name: "Override Room size" });
    const field = within(form).getByRole("textbox");
    await user.clear(field);
    await user.type(field, "25");
    await user.click(within(form).getByRole("button", { name: "Save override" }));

    const row = await within(detail().getByRole("table", { name: "Offer Facts" })).findByRole(
      "row",
      { name: /Room size.*25 m²/ },
    );
    expect(row.textContent).toMatch(/18 m²/);

    await user.click(await detail().findByRole("button", { name: "Override Coordinates" }));
    const json = detail().getByRole("form", { name: "Override Coordinates" });
    await user.click(within(json).getByRole("textbox"));
    await user.paste("{ nope");
    await user.click(within(json).getByRole("button", { name: "Save override" }));
    expect((await within(json).findByRole("alert")).textContent).toMatch(/JSON/);
  });

  it("is read again after a reconnect, since what changed meanwhile went unannounced", async () => {
    const { user, server, events, idOf } = await open({
      ads: [{ id: 9000001, title: "Cheap room", warmRent: 450 }],
    });
    await choose(user, "Cheap room");
    const facts = () => within(detail().getByRole("table", { name: "Offer Facts" }));
    await facts().findByRole("row", { name: /Room size.*18 m²/ });

    const id = await idOf("Cheap room");
    await server.call("PUT", `/offers/${id}/facts/roomSize`, { value: 25 });
    expect(facts().queryByRole("row", { name: /Room size.*25 m²/ })).toBeNull();

    await events.reconnect();
    expect(await facts().findByRole("row", { name: /Room size.*25 m²/ })).toBeTruthy();
  });

  it("keeps a correction saved while the read after a reconnect was on its way", async () => {
    const held: { hold: boolean; release?: () => void } = { hold: false };
    const { user, events } = await open({
      ads: [{ id: 9000001, title: "Cheap room", warmRent: 450 }],
      wrap: (fetch) => async (request) => {
        const answer = await fetch(request);
        if (held.hold && request.method === "GET" && /\/offers\/\d+$/.test(request.url)) {
          held.hold = false;
          await new Promise<void>((resolve) => {
            held.release = resolve;
          });
        }
        return answer;
      },
    });
    await choose(user, "Cheap room");
    const facts = () => within(detail().getByRole("table", { name: "Offer Facts" }));
    await facts().findByRole("row", { name: /Room size.*18 m²/ });

    held.hold = true;
    await events.reconnect();
    await waitFor(() => expect(held.release).toBeDefined());

    await user.click(detail().getByRole("button", { name: "Override Room size" }));
    const form = detail().getByRole("form", { name: "Override Room size" });
    await user.clear(within(form).getByRole("textbox"));
    await user.type(within(form).getByRole("textbox"), "25");
    await user.click(within(form).getByRole("button", { name: "Save override" }));
    await facts().findByRole("row", { name: /Room size.*25 m²/ });

    held.release?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(facts().getByRole("row", { name: /Room size.*25 m²/ })).toBeTruthy();
  });

  it("can set a fact the Offer does not say, from the list of what it leaves out", async () => {
    const { user } = await open({ ads: [{ id: 9000001, title: "Cheap room", warmRent: 450 }] });
    await choose(user, "Cheap room");

    await user.click(await detail().findByRole("button", { name: "Override Anmeldung" }));
    const form = detail().getByRole("form", { name: "Override Anmeldung" });
    await pickOption(user, within(form).getByRole("combobox"), "conditional");
    await user.click(within(form).getByRole("button", { name: "Save override" }));

    const row = await within(detail().getByRole("table", { name: "Offer Facts" })).findByRole(
      "row",
      { name: /Anmeldung/ },
    );
    expect(row.textContent).toMatch(/conditional/);
    expect(row.textContent).toMatch(/You/);
  });

  describe("the Scam signals override", () => {
    const KEYS_QUOTE = "Die Schlüssel schicke ich per Post";

    const keysByPost = () =>
      open({
        ads: [{ id: 9000001, title: "Cheap room", warmRent: 450 }],
        script: [outputWith({ scamSignals: [{ kind: "keys_by_post", ...sure(KEYS_QUOTE) }] })],
        page: (html) =>
          html.replace("Anmeldung ist möglich.", `Anmeldung ist möglich. ${KEYS_QUOTE}.`),
        select: "Cheap room",
      });

    const openForm = async (user: { click: (element: Element) => Promise<void> }) => {
      await user.click(await detail().findByRole("button", { name: "Override Scam signals" }));
      return within(detail().getByRole("form", { name: "Override Scam signals" }));
    };

    it("is a tick box per signal the model reads, ticked as the Offer is now, with the model's quote", async () => {
      const { user } = await keysByPost();
      const form = await openForm(user);

      const group = within(form.getByRole("group", { name: "Scam signals" }));
      const boxes = group.getAllByRole("checkbox");
      const names = [
        "Money asked before a viewing",
        "Keys sent by post",
        "Can't show the place in person",
        "Deposit over three months' rent",
        "Contact moved off the platform",
        "ID copy asked for before a viewing",
      ];
      expect(boxes).toEqual(names.map((name) => group.getByRole("checkbox", { name })));
      const keys = group.getByRole("checkbox", { name: "Keys sent by post" });
      expect(keys.getAttribute("aria-checked") === "true").toBe(true);
      expect(keys.getAttribute("aria-describedby")).toBeTruthy();
      expect(
        document.getElementById(keys.getAttribute("aria-describedby") ?? "")?.textContent,
      ).toContain(KEYS_QUOTE);
      const others = boxes.filter((box) => box !== keys);
      expect(others.map((box) => box.getAttribute("aria-checked") === "true")).toEqual([
        false,
        false,
        false,
        false,
        false,
      ]);
      expect(form.queryByRole("textbox")).toBeNull();
      expect(form.queryByRole("button", { name: "Set to unknown" })).toBeNull();
    });

    it("saves the ticked signals as your correction, and the Offer is re-banded at once", async () => {
      const { user, server, idOf } = await keysByPost();
      const id = await idOf("Cheap room");
      const form = await openForm(user);

      await user.click(form.getByRole("checkbox", { name: "Money asked before a viewing" }));
      await user.click(form.getByRole("button", { name: "Save override" }));

      const panel = await likelyNotice(user);
      expect(within(panel).getAllByRole("listitem")).toHaveLength(2);
      const stored = await (await server.call("GET", `/offers/${id}`)).json();
      expect(stored.facts.scamSignals.map((fact: { value: string }) => fact.value)).toEqual([
        "keys_by_post",
        "money_before_viewing",
      ]);
      const rows = within(detail().getByRole("table", { name: "Offer Facts" })).getAllByRole(
        "row",
        { name: /Scam signals/ },
      );
      expect(rows.map((row) => row.textContent)).toEqual([
        expect.stringMatching(/keys by post.*You.*Your correction/),
        expect.stringMatching(/money before viewing.*You.*Your correction/),
      ]);
    });

    it("unticking every signal says the text has none, and Revert brings back the model's", async () => {
      const { user, server, idOf } = await keysByPost();
      const id = await idOf("Cheap room");
      await bandIs("Warned");
      const form = await openForm(user);

      await user.click(form.getByRole("checkbox", { name: "Keys sent by post" }));
      await user.click(form.getByRole("button", { name: "Save override" }));

      await bandIs("Match");
      const panel = detail().getByRole("region", { name: "Scam check" });
      expect(panel.textContent).toMatch(/No Scam signals were found/);
      const stored = await (await server.call("GET", `/offers/${id}`)).json();
      expect(stored.facts.scamSignals ?? []).toEqual([]);
      expect(stored.overrides).toContain("scamSignals");

      await user.click(await detail().findByRole("button", { name: "Revert Scam signals" }));

      await bandIs("Warned");
      const row = within(detail().getByRole("table", { name: "Offer Facts" })).getByRole("row", {
        name: /Scam signals/,
      });
      expect(row.textContent).toMatch(/keys by post.*Model/);
      expect(row.textContent).toContain(KEYS_QUOTE);
    });

    it("is used from the keyboard: Tab reaches each box and Space ticks it", async () => {
      const { user } = await keysByPost();
      const form = await openForm(user);
      const money = form.getByRole("checkbox", { name: "Money asked before a viewing" });
      expect(document.activeElement).toBe(money);

      await user.keyboard(" ");
      expect(money.getAttribute("aria-checked") === "true").toBe(true);
      await user.tab();
      expect(document.activeElement).toBe(
        form.getByRole("checkbox", { name: "Keys sent by post" }),
      );
      await user.keyboard(" ");
      expect(
        form.getByRole("checkbox", { name: "Keys sent by post" }).getAttribute("aria-checked") ===
          "true",
      ).toBe(false);
    });
  });

  describe("the Requirements override", () => {
    const VEGAN_QUOTE = "Wir kochen nur vegan";

    const veganOnly = () =>
      open({
        ads: [{ id: 9000001, title: "Cheap room", warmRent: 450 }],
        script: [
          outputWith({
            requirements: [
              { kind: "diet", strictness: "required", value: "vegan", ...sure(VEGAN_QUOTE) },
            ],
          }),
        ],
        page: (html) =>
          html.replace("Anmeldung ist möglich.", `Anmeldung ist möglich. ${VEGAN_QUOTE}.`),
        select: "Cheap room",
        prepare: async (ctx) => {
          const profile = await (await ctx.server.call("GET", "/profile")).json();
          await ctx.server.call("PUT", "/profile", { ...profile, diet: "omnivore" });
        },
      });

    const openForm = async (user: { click: (element: Element) => Promise<void> }) => {
      await user.click(await detail().findByRole("button", { name: "Override Requirements" }));
      return within(detail().getByRole("form", { name: "Override Requirements" }));
    };

    it("is a row per Requirement the Offer has, with the model's quote, and no JSON", async () => {
      const { user } = await veganOnly();
      await bandIs("Hidden");
      const form = await openForm(user);

      const rows = form.getAllByRole("group", { name: /^Requirement \d/ });
      expect(rows).toHaveLength(1);
      const row = within(rows[0] as HTMLElement);
      expect(selected(row.getByRole("combobox", { name: "Kind" }))).toBe("Diet");
      expect(selected(row.getByRole("combobox", { name: "Strictness" }))).toBe("Must meet");
      expect(selected(row.getByRole("combobox", { name: "Diet" }))).toBe("Vegan");
      expect(row.getByRole("button", { name: "Remove Requirement 1" })).toBeTruthy();
      expect((rows[0] as HTMLElement).textContent).toContain(VEGAN_QUOTE);
      expect(form.queryByRole("textbox")).toBeNull();
      expect(form.getByRole("button", { name: "Add Requirement" })).toBeTruthy();
      expect(form.queryByRole("button", { name: "Set to unknown" })).toBeNull();
    });

    it("saves a changed row as your correction, and the Offer is ranked again at once", async () => {
      const { user, server, idOf } = await veganOnly();
      const id = await idOf("Cheap room");
      await bandIs("Hidden");
      const form = await openForm(user);
      const row = within(form.getByRole("group", { name: "Requirement 1" }));

      await pickOption(user, row.getByRole("combobox", { name: "Diet" }), "Vegetarian");
      await pickOption(user, row.getByRole("combobox", { name: "Strictness" }), "Should meet");
      await user.click(form.getByRole("button", { name: "Save override" }));

      await bandIs("Match");
      const stored = await (await server.call("GET", `/offers/${id}`)).json();
      expect(stored.facts.requirements.map((fact: { value: unknown }) => fact.value)).toEqual([
        { kind: "diet", strictness: "preferred", value: "vegetarian" },
      ]);
      const facts = within(detail().getByRole("table", { name: "Offer Facts" }));
      expect(facts.getByRole("row", { name: /Requirements/ }).textContent).toMatch(
        /vegetarian.*You.*Your correction/,
      );
    });

    const storedRequirements = async (server: ReturnType<typeof realServer>, id: number) => {
      const stored = await (await server.call("GET", `/offers/${id}`)).json();
      return {
        values: (stored.facts.requirements ?? []).map((fact: { value: unknown }) => fact.value),
        corrected: (stored.overrides as string[]).includes("requirements"),
      };
    };

    it("adds a row, and a kind whose value is implied sends it", async () => {
      const { user, server, idOf } = await veganOnly();
      const id = await idOf("Cheap room");
      const form = await openForm(user);

      await user.click(form.getByRole("button", { name: "Add Requirement" }));
      const row = within(form.getByRole("group", { name: "Requirement 2" }));
      await pickOption(user, row.getByRole("combobox", { name: "Kind" }), "Non-smokers");
      expect(selected(row.getByRole("combobox", { name: "Strictness" }))).toBe("Must meet");
      expect(row.getAllByRole("combobox")).toHaveLength(2);
      expect(row.queryByRole("textbox")).toBeNull();
      await user.click(form.getByRole("button", { name: "Save override" }));

      await waitFor(async () =>
        expect((await storedRequirements(server, id)).values).toEqual([
          { kind: "diet", strictness: "required", value: "vegan" },
          { kind: "smoking", strictness: "required", value: "non_smoker" },
        ]),
      );
    });

    it("takes a language as a two-letter code, lowercased, and refuses anything else before saving", async () => {
      const { user, server, idOf } = await veganOnly();
      const id = await idOf("Cheap room");
      const form = await openForm(user);
      await user.click(form.getByRole("button", { name: "Add Requirement" }));
      const row = within(form.getByRole("group", { name: "Requirement 2" }));
      await pickOption(user, row.getByRole("combobox", { name: "Kind" }), "Language");
      const code = row.getByRole("textbox", { name: "Language code" });
      expect(code.getAttribute("aria-describedby")).toBeTruthy();
      expect(
        document.getElementById(code.getAttribute("aria-describedby") ?? "")?.textContent,
      ).toMatch(/two letters/i);

      await user.type(code, "Deutsch");
      await user.click(form.getByRole("button", { name: "Save override" }));
      expect((await form.findByRole("alert")).textContent).toMatch(
        /Requirement 2: enter the language as a two-letter code/,
      );
      expect((await storedRequirements(server, id)).corrected).toBe(false);

      await user.clear(code);
      await user.type(code, "DE");
      await user.click(form.getByRole("button", { name: "Save override" }));
      await waitFor(async () =>
        expect((await storedRequirements(server, id)).values).toEqual([
          { kind: "diet", strictness: "required", value: "vegan" },
          { kind: "language", strictness: "required", value: "de" },
        ]),
      );
    });

    it("refuses a religion or other Requirement with no text", async () => {
      const { user, server, idOf } = await veganOnly();
      const id = await idOf("Cheap room");
      const form = await openForm(user);
      await user.click(form.getByRole("button", { name: "Add Requirement" }));
      const row = within(form.getByRole("group", { name: "Requirement 2" }));

      for (const kind of ["Religion", "Other"]) {
        await pickOption(user, row.getByRole("combobox", { name: "Kind" }), kind);
        await user.type(row.getByRole("textbox", { name: "What it says" }), "   ");
        await user.click(form.getByRole("button", { name: "Save override" }));
        expect((await form.findByRole("alert")).textContent).toMatch(/Requirement 2: say what/);
      }
      expect((await storedRequirements(server, id)).corrected).toBe(false);
    });

    it("resets a row's value to fit its new kind", async () => {
      const { user, server, idOf } = await veganOnly();
      const id = await idOf("Cheap room");
      const form = await openForm(user);
      const row = within(form.getByRole("group", { name: "Requirement 1" }));

      await pickOption(user, row.getByRole("combobox", { name: "Kind" }), "Religion");
      expect((row.getByRole("textbox", { name: "What it says" }) as HTMLInputElement).value).toBe(
        "",
      );
      await pickOption(user, row.getByRole("combobox", { name: "Kind" }), "Occupation");
      expect(selected(row.getByRole("combobox", { name: "Occupation" }))).toBe("Choose…");
      expect(row.queryByRole("combobox", { name: "Diet" })).toBeNull();
      await user.click(form.getByRole("button", { name: "Save override" }));
      expect((await form.findByRole("alert")).textContent).toMatch(
        /Requirement 1: choose the occupation/,
      );
      expect((await storedRequirements(server, id)).corrected).toBe(false);

      await pickOption(user, row.getByRole("combobox", { name: "Occupation" }), "Students");
      await user.click(form.getByRole("button", { name: "Save override" }));
      await waitFor(async () =>
        expect((await storedRequirements(server, id)).values).toEqual([
          { kind: "occupation", strictness: "required", value: "student" },
        ]),
      );
    });

    it("removing every row says the Offer states none, and Revert brings back the model's", async () => {
      const { user, server, idOf } = await veganOnly();
      const id = await idOf("Cheap room");
      await bandIs("Hidden");
      const notes = () =>
        detail().queryByRole("group", { name: "The ad asks for" })?.textContent ?? "";
      expect(notes()).toMatch(/Requires a vegan diet/);
      const asks = detail().getByRole("group", { name: "The ad asks for" });
      const reasons = detail().getByRole("group", { name: "How it fits you" });
      expect(asks.closest(".wh-offer-fit")).toBe(reasons.closest(".wh-offer-fit"));
      expect(asks.closest(".od-fold")).toBeNull();
      expect(reasons.compareDocumentPosition(asks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const form = await openForm(user);

      await user.click(form.getByRole("button", { name: "Remove Requirement 1" }));
      expect(form.queryByRole("group", { name: /^Requirement \d/ })).toBeNull();
      await user.click(form.getByRole("button", { name: "Save override" }));

      await bandIs("Match");
      expect(detail().queryByText(/Hidden by a dealbreaker/)).toBeNull();
      expect(notes()).not.toMatch(/Requires/);
      expect(await storedRequirements(server, id)).toEqual({ values: [], corrected: true });

      await user.click(await detail().findByRole("button", { name: "Revert Requirements" }));

      await bandIs("Hidden");
      const row = within(detail().getByRole("table", { name: "Offer Facts" })).getByRole("row", {
        name: /Requirements/,
      });
      expect(row.textContent).toMatch(/vegan.*Model/);
      expect(row.textContent).toContain(VEGAN_QUOTE);
    });

    it("is used from the keyboard alone, starting empty when the Offer states none", async () => {
      const { user } = await open({
        ads: [{ id: 9000001, title: "Cheap room", warmRent: 450 }],
        select: "Cheap room",
      });
      const form = await openForm(user);
      expect(form.queryByRole("group", { name: /^Requirement \d/ })).toBeNull();
      const add = form.getByRole("button", { name: "Add Requirement" });
      expect(document.activeElement).toBe(add);

      await user.keyboard("{Enter}");
      const row = within(form.getByRole("group", { name: "Requirement 1" }));
      expect(document.activeElement).toBe(row.getByRole("combobox", { name: "Kind" }));
      await user.tab();
      expect(document.activeElement).toBe(row.getByRole("combobox", { name: "Strictness" }));
      await user.tab();
      expect(document.activeElement).toBe(row.getByRole("combobox", { name: "Diet" }));
      await user.tab();
      expect(document.activeElement).toBe(
        row.getByRole("button", { name: "Remove Requirement 1" }),
      );
      await user.keyboard("{Enter}");
      expect(form.queryByRole("group", { name: /^Requirement \d/ })).toBeNull();
      expect(document.activeElement).toBe(add);
    });
  });

  it("shows a Doubtful fact's reasons and what else was read", async () => {
    const { user } = await open({
      ads: [{ id: 9000001, title: "Cheap room", warmRent: 450 }],
      script: [
        outputWith({ anmeldung: { value: "conditional", ...unsure("Anmeldung ist möglich") } }),
      ],
    });
    await choose(user, "Cheap room");
    const row = within(await detail().findByRole("table", { name: "Offer Facts" })).getByRole(
      "row",
      { name: /Anmeldung/ },
    );
    expect(row.textContent).toMatch(/Doubtful: the model found the wording ambiguous/);
  });
});

describe("the Retention fold", () => {
  const splitApart = async ({ server }: { server: ReturnType<typeof realServer> }) => {
    server.runtime.db
      .insert(offerPairOverrides)
      .values({
        source: "wg-gesucht",
        adIdA: "9000001",
        adIdB: "9000002",
        verdict: "different",
        createdAt: new Date(MORNING),
      })
      .run();
  };

  it("says an Offer a Search finds keeps no clock", async () => {
    await open({ select: "Cheap room" });
    const fold = within(detail().getByRole("region", { name: "Retention" }));
    expect(fold.getByText(/^Kept while a Search finds it and it isn't stale\.$/)).toBeTruthy();
    expect(fold.queryByRole("button", { name: "Let it expire" })).toBeNull();
  });

  it("names what keeps it, and lets a merge or split's pin go without undoing it", async () => {
    const { user, server, idOf } = await open({ select: "Cheap room", prepare: splitApart });
    const fold = within(detail().getByRole("region", { name: "Retention" }));
    expect(
      fold.getByText(/Once it is, it is kept because of a merge or split you made\./),
    ).toBeTruthy();

    await user.click(fold.getByRole("button", { name: "Let it expire" }));
    await waitFor(() => expect(fold.queryByRole("button", { name: "Let it expire" })).toBeNull());
    expect(fold.getByText(/^Kept while a Search finds it and it isn't stale\.$/)).toBeTruthy();
    expect(server.runtime.db.select().from(offerPairOverrides).all()).toHaveLength(1);
    const other = await (await server.call("GET", `/offers/${await idOf("Dear room")}`)).json();
    expect(other.retention.keptBecause).toEqual(["pair-override"]);
  });

  it("keeps the pin released while a read sent before it was on its way", async () => {
    const held: { hold: boolean; release?: () => void } = { hold: false };
    const { user, events } = await open({
      select: "Cheap room",
      prepare: splitApart,
      wrap: (fetch) => async (request) => {
        const answer = await fetch(request);
        if (held.hold && request.method === "GET" && /\/offers\/\d+$/.test(request.url)) {
          held.hold = false;
          await new Promise<void>((resolve) => {
            held.release = resolve;
          });
        }
        return answer;
      },
    });
    const fold = within(detail().getByRole("region", { name: "Retention" }));
    held.hold = true;
    await events.reconnect();
    await waitFor(() => expect(held.release).toBeDefined());

    await user.click(fold.getByRole("button", { name: "Let it expire" }));
    await waitFor(() => expect(fold.queryByRole("button", { name: "Let it expire" })).toBeNull());

    held.release?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fold.queryByRole("button", { name: "Let it expire" })).toBeNull();
  });
});

describe("a refused mark", () => {
  it("reads the generic line when the refusal carries no words", async () => {
    const { user } = await open({
      ads: [{ id: 9000001, title: "Cheap room", warmRent: 450 }],
      select: "Cheap room",
      wrap: (fetch) => async (request) =>
        request.method === "PATCH" && request.url.endsWith("/marks")
          ? Response.json({}, { status: 403 })
          : fetch(request),
    });
    await user.click(await detail().findByRole("button", { name: /^Shortlist/ }));
    expect(
      await detail().findByText(
        "Couldn't save that. wg-hunt couldn't do that just now. Try again in a moment.",
      ),
    ).toBeTruthy();
  });
});
