// @vitest-environment jsdom
import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { writeJson } from "../../server/src/crawl/kv.js";
import { crawlRequests } from "../../server/src/db/schema.js";
import { LOW_DISK_BYTES } from "../../server/src/retention/constants.js";
import { formatBytes } from "../src/settings/bytes.js";
import { openAdvanced, openFold } from "./advanced.js";
import { choose } from "./choose.js";
import { crawlStatus, fakeServer } from "./fake-server.js";
import { realServer } from "./real-server.js";
import { fakeEventStream, liveFrom, renderDashboard } from "./render.js";

type Server = ReturnType<typeof realServer>;

async function openCrawl(
  options: {
    server?: Server;
    events?: ReturnType<typeof fakeEventStream>;
    intercept?: (request: Request) => Response | Promise<Response> | undefined;
  } = {},
) {
  const server = options.server ?? realServer();
  await server.signIn();
  const requests: string[] = [];
  const fetch = async (request: Request) => {
    requests.push(`${request.method} ${new URL(request.url).pathname.replace("/api/v1", "")}`);
    return options.intercept?.(request) ?? server.fetch(request);
  };
  const { user } = renderDashboard(fetch, "/settings", options.events?.stream);
  await openAdvanced(user);
  await screen.findByRole("heading", { level: 3, name: "Checking wg-gesucht" });
  await openFold(user, "Pacing");
  await openFold(user, "Request log");
  return { user, server, requests };
}

const addSearch = (server: Server, change: object = {}) =>
  server.call("POST", "/searches", {
    city: "Berlin",
    categories: ["flatshare-room"],
    ...change,
  });

type Row = Partial<typeof crawlRequests.$inferInsert>;

function logRequests(server: Server, rows: Row[]) {
  for (const row of rows) {
    server.runtime.db
      .insert(crawlRequests)
      .values({
        at: row.at ?? new Date(),
        kind: row.kind ?? "poll",
        path: row.path ?? "/wg-zimmer-in-Berlin.8.0.1.0.html",
        status: row.status === undefined ? 200 : row.status,
        outcome: row.outcome ?? "ok",
        marker: row.marker ?? null,
      })
      .run();
  }
}

const tile = (name: string) => within(screen.getByRole("region", { name }));

describe("Crawl page tiles", () => {
  it("read the Shell's one crawl status, so a Pause anywhere shows here too", async () => {
    const { user, requests } = await openCrawl();
    await screen.findByRole("region", { name: "Today" });
    expect(requests.filter((r) => r === "GET /crawl")).toHaveLength(1);

    const keep = screen.getByRole("switch", { name: /Keep hunting/ });
    await user.click(keep);
    await waitFor(() => expect(keep.getAttribute("aria-checked")).toBe("false"));
    expect(requests.filter((r) => r === "GET /crawl")).toHaveLength(1);
  });

  it("shows today's requests against the cap and this hour's", async () => {
    const server = realServer();
    logRequests(server, [{}, {}, {}, {}, {}, {}, {}]);
    await openCrawl({ server });
    const today = tile("Today");
    await waitFor(() =>
      expect(today.getByText("Requests today").nextSibling?.textContent).toMatch(/7\s*\/\s*300/),
    );
    expect(today.getByText("This hour").nextSibling?.textContent).toMatch(/7\s*\/\s*30/);
    expect(today.getByRole("meter", { name: "Requests today" })).toBeTruthy();
  });

  it("lists the next due jobs in the order they will run", async () => {
    const server = realServer();
    server.runtime.crawl.enqueue({
      kind: "recheck",
      path: "/wg-zimmer-in-Berlin.9.html",
      dueAt: Date.parse("2026-06-10T10:00:00Z"),
    });
    server.runtime.crawl.enqueue({
      kind: "poll",
      path: "/wg-zimmer-in-Berlin.8.0.1.0.html",
      dueAt: Date.parse("2026-06-10T10:05:00Z"),
    });
    await openCrawl({ server });
    const next = tile("Up next");
    const items = await next.findAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringMatching(/Poll.*wg-zimmer-in-Berlin\.8\.0\.1\.0\.html/),
      expect.stringMatching(/Recheck.*wg-zimmer-in-Berlin\.9\.html/),
    ]);
  });

  it("says when nothing is queued", async () => {
    await openCrawl();
    expect(await tile("Up next").findByText(/Nothing is queued/)).toBeTruthy();
  });

  it("shows the budget forecast for the stored Searches", async () => {
    const server = realServer();
    await server.signIn();
    await addSearch(server);
    await openCrawl({ server });
    const forecast = tile("Expected per day");
    const expected = await (await server.call("GET", "/crawl/forecast")).json();
    const row = (name: RegExp) => forecast.getByRole("row", { name }).textContent ?? "";
    await waitFor(() => expect(row(/^Polls/)).toContain(String(expected.requests.polls)));
    expect(expected.requests.polls).toBeGreaterThan(0);
    expect(row(/^Sweeps/)).toContain(String(expected.requests.sweeps));
    expect(row(/Left for Rechecks/)).toContain(String(expected.requests.rechecks));
    expect(forecast.getByText(/Daily limit 300/)).toBeTruthy();
  });

  it("says the forecast couldn't be worked out, and Try again reads it", async () => {
    const server = realServer();
    await server.signIn();
    await addSearch(server);
    let broken = true;
    const { user } = await openCrawl({
      server,
      intercept: (request) =>
        broken && request.method === "GET" && new URL(request.url).pathname.endsWith("/forecast")
          ? new Response("{}", { status: 500 })
          : undefined,
    });
    const forecast = tile("Expected per day");
    expect((await forecast.findByRole("alert")).textContent).toMatch(/Couldn't work out/);
    broken = false;
    await user.click(forecast.getByRole("button", { name: "Try again" }));
    expect(await forecast.findByRole("row", { name: /^Polls/ })).toBeTruthy();
    expect(forecast.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("shows the server's words when the forecast is refused with some", async () => {
    const server = realServer();
    await server.signIn();
    await addSearch(server);
    await openCrawl({
      server,
      intercept: (request) =>
        request.method === "GET" && new URL(request.url).pathname.endsWith("/forecast")
          ? Response.json({ detail: "The forecast is resting." }, { status: 503 })
          : undefined,
    });
    const alert = await tile("Expected per day").findByRole("alert");
    expect(alert.textContent).toBe("The forecast is resting.");
  });

  it("keeps its own sentence when the forecast is refused with only a title", async () => {
    const server = realServer();
    await server.signIn();
    await addSearch(server);
    await openCrawl({
      server,
      intercept: (request) =>
        request.method === "GET" && new URL(request.url).pathname.endsWith("/forecast")
          ? Response.json({ title: "Internal server error", status: 500 }, { status: 500 })
          : undefined,
    });
    const alert = await tile("Expected per day").findByRole("alert");
    expect(alert.textContent).toBe("Couldn't work out the forecast.");
  });

  it("reads a forecast that failed again on reconnect", async () => {
    const server = realServer();
    await server.signIn();
    await addSearch(server);
    const events = fakeEventStream();
    let broken = true;
    await openCrawl({
      server,
      events,
      intercept: (request) =>
        broken && request.method === "GET" && new URL(request.url).pathname.endsWith("/forecast")
          ? new Response("{}", { status: 500 })
          : undefined,
    });
    const forecast = tile("Expected per day");
    await forecast.findByRole("alert");
    broken = false;
    await events.reconnect();
    expect(await forecast.findByRole("row", { name: /^Polls/ })).toBeTruthy();
  });

  it("says the daily limit is halved, and until when, after a Cooldown", async () => {
    const server = realServer();
    await server.signIn();
    const until = Date.now() + 3_600_000;
    writeJson(server.runtime.db, "crawl.engine", { halfBudgetUntil: until }, Date.now());
    await openCrawl({ server });
    const forecast = tile("Expected per day");
    expect(await forecast.findByText(/Daily limit 150, half of 300 until/)).toBeTruthy();
  });

  it("warns when polls would drop below one every 2 hours", async () => {
    const server = realServer();
    await server.signIn();
    await server.call("PUT", "/settings/crawl", {
      pacing: {
        gapMinSeconds: 20,
        gapMaxSeconds: 60,
        sessionSize: 15,
        breakMinMinutes: 10,
        breakMaxMinutes: 30,
        hourlyCap: 30,
        dailyCap: 40,
        activeHours: { start: "07:00", end: "23:30" },
      },
      recheck: { enabled: true, maxPageAgeHours: 72 },
    });
    await addSearch(server);
    await openCrawl({ server });
    const forecast = tile("Expected per day");
    const alerts = await forecast.findAllByRole("alert");
    expect(alerts.map((a) => a.textContent).join(" ")).toMatch(/below one per 2 h/);
  });

  it("shows the last Bot check and a pause for a changed page layout", async () => {
    const server = fakeServer({
      signedIn: true,
      crawl: crawlStatus({
        state: "layout-changed",
        paused: {
          reason: "layout-changed",
          cause: "unexpected-page",
          since: "2026-06-10T10:00:00.000Z",
          path: "/wg-zimmer-in-Berlin.8.0.1.0.html",
          savedAs: "unexpected-pages/page-1.html",
        },
        lastBotCheck: {
          at: "2026-06-09T10:35:00.000Z",
          path: "/wg-zimmer-in-Berlin.8.0.1.0.html",
          marker: "checkform",
          hourCount: 4,
          dayCount: 21,
        },
      }),
    });
    const { user } = renderDashboard(server.fetch, "/settings");
    await openAdvanced(user);
    await screen.findByRole("heading", { level: 3, name: "Checking wg-gesucht" });
    const today = tile("Today");
    expect(await today.findByText(/last asked whether you're a person/)).toBeTruthy();
    expect(today.getByText(/checkform/)).toBeTruthy();
    const note = (await screen.findAllByRole("alert")).find((alert) =>
      /stopped: a page looked different/.test(alert.textContent ?? ""),
    ) as HTMLElement;
    expect(note.textContent).toMatch(/a page wg-hunt doesn't understand at \/wg-zimmer-in-Berlin/);
    expect(note.textContent).toMatch(/unexpected-pages\/page-1\.html/);
  });

  it("says wg-hunt failed while handling a page, that a Resume tries again, and where the answer is", async () => {
    const server = fakeServer({
      signedIn: true,
      crawl: crawlStatus({
        state: "layout-changed",
        paused: {
          reason: "layout-changed",
          cause: "handler-error",
          since: "2026-06-10T10:00:00.000Z",
          path: "/wg-zimmer-in-Berlin.8.0.1.0.html",
          savedAs: "unexpected-pages/page-1.html",
        },
      }),
    });
    const { user } = renderDashboard(server.fetch, "/settings");
    await openAdvanced(user);
    const note = (await screen.findAllByRole("alert")).find((alert) =>
      /stopped: it couldn't finish handling a page/.test(alert.textContent ?? ""),
    ) as HTMLElement;
    expect(note.textContent).toMatch(
      /wg-hunt failed while handling the page at \/wg-zimmer-in-Berlin\.8\.0\.1\.0\.html/,
    );
    expect(note.textContent).toMatch(/Keep hunting back on tries again/);
    expect(note.textContent).toMatch(/the disk, the database, or a page wg-hunt can't handle/);
    expect(note.textContent).toMatch(/the server's log has the error/);
    expect(note.textContent).toMatch(/newest "Handling failed" row of the request log/);
    expect(note.textContent).toMatch(/unexpected-pages\/page-1\.html/);
    expect(screen.queryByText(/a page looked different$/)).toBeNull();
    expect(note.textContent).not.toMatch(/doesn't understand/);
  });

  it("explains a pause for a nearly full disk, and what to do", async () => {
    const server = fakeServer({
      signedIn: true,
      crawl: crawlStatus({
        state: "disk-full",
        paused: {
          reason: "disk-full",
          cause: null,
          since: "2026-06-10T10:00:00.000Z",
          path: null,
          savedAs: null,
        },
      }),
    });
    const { user } = renderDashboard(server.fetch, "/settings");
    await openAdvanced(user);
    const note = (await screen.findAllByRole("alert")).find((alert) =>
      /the disk is nearly full/.test(alert.textContent ?? ""),
    ) as HTMLElement;
    expect(note.textContent).toContain(`Less than ${formatBytes(LOW_DISK_BYTES)} is free`);
    expect(note.textContent).toMatch(/Keep hunting back on/);
  });
});

describe("pacing editor", () => {
  const pacing = () => within(screen.getByRole("region", { name: "Pacing" }));
  const field = async (label: string) => {
    const region = await screen.findByRole("region", { name: "Pacing" });
    return (await within(region).findByLabelText(label)) as HTMLInputElement;
  };
  const stored = async (server: Server) =>
    await (await server.call("GET", "/settings/crawl")).json();

  const errorOf = (input: HTMLElement) => {
    const id = input.getAttribute("aria-describedby");
    return id ? (document.getElementById(id)?.textContent ?? undefined) : undefined;
  };

  async function change(
    user: Awaited<ReturnType<typeof openCrawl>>["user"],
    label: string,
    value: string,
  ) {
    const input = await field(label);
    await user.clear(input);
    await user.type(input, value);
  }

  it("reads the forecasts again when the half budget starts or ends, drafts too", async () => {
    const server = realServer();
    await server.signIn();
    const live = fakeEventStream();
    const { user } = await openCrawl({ server, events: live });
    const forecast = tile("Expected per day");
    expect(await forecast.findByText(/^Daily limit 300$/)).toBeTruthy();
    await change(user, "Most requests a day", "200");
    const draft = within(await screen.findByRole("region", { name: "Requests per day" }));
    expect(await draft.findByText(/^Daily limit 200$/)).toBeTruthy();
    const publishStatus = async () =>
      live.emit({
        type: "crawl-status-changed",
        data: await (await server.call("GET", "/crawl")).json(),
      });

    writeJson(
      server.runtime.db,
      "crawl.engine",
      { halfBudgetUntil: Date.now() + 3_600_000 },
      Date.now(),
    );
    await publishStatus();
    expect(await forecast.findByText(/Daily limit 150, half of 300 until/)).toBeTruthy();
    expect(await draft.findByText(/Daily limit 100, half of 200 until/)).toBeTruthy();

    writeJson(server.runtime.db, "crawl.engine", {}, Date.now());
    await publishStatus();
    expect(await forecast.findByText(/^Daily limit 300$/)).toBeTruthy();
    expect(await draft.findByText(/^Daily limit 200$/)).toBeTruthy();
  });

  it("shows the stored pacing in labelled fields", async () => {
    await openCrawl();
    expect((await field("Shortest gap")).value).toBe("20");
    expect((await field("Longest gap")).value).toBe("60");
    expect((await field("Requests per session")).value).toBe("15");
    expect((await field("Shortest break")).value).toBe("10");
    expect((await field("Longest break")).value).toBe("30");
    expect((await field("Most requests an hour")).value).toBe("30");
    expect((await field("Most requests a day")).value).toBe("300");
    expect((await field("Checks from")).getAttribute("data-value")).toBe("07:00");
    expect((await field("Checks until")).getAttribute("data-value")).toBe("23:30");
    expect((await field("Automatic rechecks")).getAttribute("aria-checked")).toBe("true");
    expect((await field("Recheck pages older than")).value).toBe("72");
    expect(pacing().queryByRole("button", { name: "Save pacing" })).toBeNull();
  });

  it("shows the forecast now against the draft before anything is saved", async () => {
    const server = realServer();
    await server.signIn();
    await addSearch(server);
    const { user, requests } = await openCrawl({ server });
    await change(user, "Most requests a day", "40");

    const draft = within(await screen.findByRole("region", { name: "Requests per day" }));
    const cells = (name: RegExp) =>
      within(draft.getByRole("row", { name }))
        .getAllByRole("cell")
        .map((c) => c.textContent);
    const now = (await (await server.call("GET", "/crawl/forecast")).json()).requests.rechecks;
    expect(now).toBeGreaterThan(0);
    await waitFor(() => expect(cells(/Left for Rechecks/)).toEqual([String(now), "0"]));
    expect(await draft.findByText(/Daily limit 40/)).toBeTruthy();

    expect(requests).not.toContain("PUT /settings/crawl");
    expect((await stored(server)).pacing.dailyCap).toBe(300);
    expect(pacing().getByRole("button", { name: "Save pacing" })).toBeTruthy();
  });

  it("saves the draft, and the budget forecast tile follows", async () => {
    const server = realServer();
    await server.signIn();
    await addSearch(server);
    const { user } = await openCrawl({ server });
    await change(user, "Most requests a day", "200");
    await user.click(await pacing().findByRole("button", { name: "Save pacing" }));

    await waitFor(async () => expect((await stored(server)).pacing.dailyCap).toBe(200));
    await waitFor(() => expect(pacing().queryByRole("button", { name: "Save pacing" })).toBeNull());
    expect(
      await within(screen.getByRole("region", { name: "Expected per day" })).findByText(
        /Daily limit 200/,
      ),
    ).toBeTruthy();
    expect((await field("Most requests a day")).value).toBe("200");
  });

  it("shows a saved daily limit on the Today tile without a reload", async () => {
    const server = realServer();
    const { user, requests } = await openCrawl({ server, events: liveFrom(server) });
    const usedOfCap = () => tile("Today").getByText("Requests today").nextSibling?.textContent;
    await waitFor(() => expect(usedOfCap()).toMatch(/0\s*\/\s*300/));

    await change(user, "Most requests a day", "200");
    await user.click(await pacing().findByRole("button", { name: "Save pacing" }));

    await waitFor(() => expect(usedOfCap()).toMatch(/0\s*\/\s*200/));
    expect(requests.filter((r) => r === "GET /crawl")).toHaveLength(1);
  });

  it("discards the draft and sends nothing", async () => {
    const server = realServer();
    const { user, requests } = await openCrawl({ server });
    await change(user, "Most requests an hour", "12");
    await user.click(await pacing().findByRole("button", { name: "Discard" }));
    expect((await field("Most requests an hour")).value).toBe("30");
    expect(pacing().queryByRole("button", { name: "Save pacing" })).toBeNull();
    expect(requests).not.toContain("PUT /settings/crawl");
  });

  it("saves the active hours and the Recheck settings", async () => {
    const server = realServer();
    const { user } = await openCrawl({ server });
    await choose(user, await field("Checks from"), "08:00");
    await user.click(await field("Automatic rechecks"));
    await change(user, "Recheck pages older than", "48");
    await user.click(await pacing().findByRole("button", { name: "Save pacing" }));
    await waitFor(async () => {
      const settings = await stored(server);
      expect(settings.pacing.activeHours).toEqual({ start: "08:00", end: "23:30" });
      expect(settings.recheck).toEqual({ enabled: false, maxPageAgeHours: 48 });
    });
  });

  it.each([
    ["Shortest gap", "10", /15 s/],
    ["Longest gap", "5", /15 s/],
    ["Most requests a day", "601", /600/],
    ["Most requests an hour", "601", /600/],
  ])(
    "refuses %s = %s inline, before saving, naming the constant",
    async (label, value, message) => {
      const server = realServer();
      const { user, requests } = await openCrawl({ server });
      await change(user, label, value);
      const input = await field(label);
      await waitFor(() => expect(errorOf(input)).toMatch(message));
      expect(input.getAttribute("aria-invalid")).toBe("true");
      const save = pacing().getByRole("button", { name: "Save pacing" }) as HTMLButtonElement;
      expect(save.disabled).toBe(true);
      expect(requests.filter((r) => r === "POST /crawl/forecast")).toEqual([]);
      expect(requests).not.toContain("PUT /settings/crawl");
    },
  );

  it("refuses a shortest gap above the longest, and active hours that end before they start", async () => {
    const { user } = await openCrawl();
    await change(user, "Shortest gap", "90");
    await waitFor(async () => expect(errorOf(await field("Shortest gap"))).toMatch(/longest gap/i));
    await user.click(await pacing().findByRole("button", { name: "Discard" }));
    await choose(user, await field("Checks until"), "06:00");
    await waitFor(async () =>
      expect(errorOf(await field("Checks until"))).toMatch(/start before they end/i),
    );
  });

  it("shows the server's refusal beside the field when it still refuses a save", async () => {
    const { user } = await openCrawl({
      intercept: (request) =>
        request.method === "PUT" && new URL(request.url).pathname.endsWith("/settings/crawl")
          ? new Response(
              JSON.stringify({
                type: "validation-error",
                title: "Invalid request",
                status: 400,
                detail: "pacing.dailyCap: at most 250 requests per day",
                errors: [{ path: "pacing.dailyCap", message: "at most 250 requests per day" }],
              }),
              { status: 400, headers: { "Content-Type": "application/problem+json" } },
            )
          : undefined,
    });
    await change(user, "Most requests a day", "280");
    await user.click(await pacing().findByRole("button", { name: "Save pacing" }));
    const input = await field("Most requests a day");
    await waitFor(() => expect(errorOf(input)).toBe("at most 250 requests per day"));
    expect(input.value).toBe("280");
  });

  it("shows the constants read-only beside the editor", async () => {
    await openCrawl();
    const constants = within(await screen.findByRole("region", { name: "Fixed limits" }));
    for (const text of [
      /One request at a time/,
      /At least 15 s between requests/,
      /At most 600 requests a day/,
      /same address, browser and cookies/i,
      /nothing under \/api\/ and nothing behind a login/i,
      /2 h, 4 h, 8 h, then 24 h/,
      /half pace for 24 h/i,
    ]) {
      expect(constants.getByText(text)).toBeTruthy();
    }
    expect(constants.queryAllByRole("textbox")).toEqual([]);
    expect(constants.queryAllByRole("spinbutton")).toEqual([]);
  });
});

describe("request log", () => {
  const log = async () => within(await screen.findByRole("table", { name: "Request log" }));
  const bodyRows = async () => (await log()).getAllByRole("row").slice(1);
  const HOUR = 3_600_000;

  it("says so when nothing has been requested yet", async () => {
    await openCrawl();
    expect(await screen.findByText(/No requests yet/)).toBeTruthy();
  });

  it("lists time, kind, path, status, outcome and marker, newest first", async () => {
    const server = realServer();
    logRequests(server, [
      { at: new Date("2026-06-10T12:35:07Z"), kind: "poll", path: "/older.html" },
      {
        at: new Date("2026-06-10T12:36:30Z"),
        kind: "new-offer",
        path: "/wg-zimmer-in-Berlin.123.html",
        status: 200,
        outcome: "ok",
      },
    ]);
    await openCrawl({ server });
    const rows = await waitFor(async () => {
      const found = await bodyRows();
      expect(found).toHaveLength(2);
      return found;
    });
    const cells = (row: HTMLElement) =>
      within(row)
        .getAllByRole("cell")
        .map((c) => c.textContent);
    expect(within(rows[0] as HTMLElement).getByRole("rowheader").textContent).toBe(
      "10 Jun 14:36:30",
    );
    expect(cells(rows[0] as HTMLElement)).toEqual([
      "New Offer",
      "/wg-zimmer-in-Berlin.123.html",
      "200",
      "OK",
      "–",
    ]);
    expect(within(rows[1] as HTMLElement).getByRole("rowheader").textContent).toBe(
      "10 Jun 14:35:07",
    );
    expect(rows.map((r) => r.getAttribute("data-flag"))).toEqual([null, null]);
  });

  it("highlights Bot check rows and both kinds that paused the crawl, in words as well as colour", async () => {
    const server = realServer();
    logRequests(server, [
      { outcome: "bot-check", status: 200, marker: "checkform", path: "/a.html" },
      { outcome: "unexpected-page", path: "/b.html" },
      { outcome: "http-error", status: 500, path: "/c.html" },
      { outcome: "handler-error", status: 200, path: "/d.html" },
    ]);
    await openCrawl({ server });
    const rows = await waitFor(async () => {
      const found = await bodyRows();
      expect(found).toHaveLength(4);
      return found;
    });
    const byPath = (path: string) => rows.find((r) => r.textContent?.includes(path)) as HTMLElement;
    const bot = byPath("/a.html");
    expect(bot.getAttribute("data-flag")).toBe("bot-check");
    expect(bot.textContent).toMatch(/Bot check/);
    expect(bot.textContent).toMatch(/checkform/);
    const unexpected = byPath("/b.html");
    expect(unexpected.getAttribute("data-flag")).toBe("unexpected-page");
    expect(unexpected.textContent).toMatch(/Unexpected page/);
    const failed = byPath("/d.html");
    expect(failed.getAttribute("data-flag")).toBe("unexpected-page");
    expect(failed.textContent).toMatch(/Handling failed/);
    expect(byPath("/c.html").getAttribute("data-flag")).toBeNull();
    expect(byPath("/c.html").textContent).toMatch(/HTTP error/);
  });

  it("pages through 30 days of entries, 50 at a time", async () => {
    const server = realServer();
    const now = Date.now();
    // The log is written as it happens, so the oldest goes in first.
    logRequests(
      server,
      Array.from({ length: 160 }, (_, i) => ({
        at: new Date(now - i * 4.5 * HOUR),
        path: `/page-${i}.html`,
      })).reverse(),
    );
    const { user } = await openCrawl({ server });
    await waitFor(async () => expect(await bodyRows()).toHaveLength(50));
    expect((await bodyRows())[0]?.textContent).toContain("/page-0.html");
    expect((await bodyRows())[49]?.textContent).toContain("/page-49.html");

    await user.click(await screen.findByRole("button", { name: "Show older requests" }));
    await waitFor(async () => expect(await bodyRows()).toHaveLength(100));
    await user.click(screen.getByRole("button", { name: "Show older requests" }));
    await waitFor(async () => expect(await bodyRows()).toHaveLength(150));
    await user.click(screen.getByRole("button", { name: "Show older requests" }));
    await waitFor(async () => expect(await bodyRows()).toHaveLength(160));

    const rows = await bodyRows();
    expect(rows[159]?.textContent).toContain("/page-159.html");
    expect(screen.queryByRole("button", { name: "Show older requests" })).toBeNull();
    expect(rows.map((r) => r.textContent?.match(/page-(\d+)/)?.[1])).toEqual(
      Array.from({ length: 160 }, (_, i) => String(i)),
    );
  });

  it("adds new requests at the top when the newest page reaches the rows held, and updates ones in flight", async () => {
    const server = realServer();
    logRequests(server, [{ outcome: "pending", status: null, path: "/in-flight.html" }]);
    const live = fakeEventStream();
    await openCrawl({ server, events: live });
    await waitFor(async () => expect((await bodyRows())[0]?.textContent).toMatch(/In flight/));

    server.runtime.db.$client
      .prepare("UPDATE crawl_requests SET outcome = 'ok', status = 200 WHERE path = ?")
      .run("/in-flight.html");
    logRequests(server, [{ path: "/newer.html", at: new Date(Date.now() + 1000) }]);
    await live.emit({ type: "crawl-status-changed", data: crawlStatus() });

    await waitFor(async () => {
      const rows = await bodyRows();
      expect(rows).toHaveLength(2);
      expect(rows[0]?.textContent).toContain("/newer.html");
      expect(rows[1]?.textContent).toMatch(/\/in-flight\.html.*200.*OK/);
    });
  });

  it("replaces the rows when the newest page doesn't reach them, rather than hide the gap", async () => {
    const server = realServer();
    const paths = (from: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ path: `/${from}-${i}.html` }));
    logRequests(server, paths("old", 60));
    const live = fakeEventStream();
    const { user } = await openCrawl({ server, events: live });
    await waitFor(async () => expect(await bodyRows()).toHaveLength(50));

    logRequests(server, paths("new", 60));
    await live.emit({ type: "crawl-status-changed", data: crawlStatus() });
    await waitFor(async () => expect((await bodyRows())[0]?.textContent).toContain("/new-59.html"));
    const shown = async () =>
      (await bodyRows()).map((row) => row.textContent?.match(/\/(old|new)-\d+/)?.[0]);
    expect(await shown()).toHaveLength(50);
    expect((await shown()).every((path) => path?.startsWith("/new"))).toBe(true);

    await user.click(screen.getByRole("button", { name: "Show older requests" }));
    await waitFor(async () => expect(await bodyRows()).toHaveLength(100));
    expect(await shown()).toEqual([
      ...Array.from({ length: 60 }, (_, i) => `/new-${59 - i}`),
      ...Array.from({ length: 40 }, (_, i) => `/old-${59 - i}`),
    ]);
  });

  it("drops an older page that answers as the rows it was asked for are replaced", async () => {
    const server = realServer();
    logRequests(
      server,
      Array.from({ length: 120 }, (_, i) => ({ path: `/old-${i}.html` })),
    );
    const live = fakeEventStream();
    const held: { newest?: Promise<void>; older?: Promise<void> } = {};
    const release: Partial<Record<"newest" | "older", () => void>> = {};
    const gate = (which: "newest" | "older") => {
      held[which] = new Promise<void>((resolve) => {
        release[which] = resolve;
      });
    };
    const { user } = await openCrawl({
      server,
      events: live,
      intercept: (request) => {
        const url = new URL(request.url);
        if (!url.pathname.endsWith("/crawl/requests")) return undefined;
        const which = url.searchParams.has("cursor") ? "older" : "newest";
        const wait = held[which];
        if (!wait) return undefined;
        held[which] = undefined;
        return wait.then(() => server.fetch(request));
      },
    });
    await waitFor(async () => expect(await bodyRows()).toHaveLength(50));

    gate("older");
    await user.click(screen.getByRole("button", { name: "Show older requests" }));
    logRequests(
      server,
      Array.from({ length: 60 }, (_, i) => ({ path: `/new-${i}.html` })),
    );
    gate("newest");
    await live.emit({ type: "crawl-status-changed", data: crawlStatus() });
    await act(async () => {
      release.newest?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
      release.older?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const rows = await bodyRows();
    expect(rows).toHaveLength(50);
    expect(rows.every((row) => row.textContent?.includes("/new-"))).toBe(true);
  });

  it("starts over from the newest page after a reconnect", async () => {
    const server = realServer();
    logRequests(
      server,
      Array.from({ length: 60 }, (_, i) => ({ path: `/old-${i}.html` })),
    );
    const live = fakeEventStream();
    const { user } = await openCrawl({ server, events: live });
    await waitFor(async () => expect(await bodyRows()).toHaveLength(50));
    await user.click(screen.getByRole("button", { name: "Show older requests" }));
    await waitFor(async () => expect(await bodyRows()).toHaveLength(60));

    logRequests(server, [{ path: "/after.html" }]);
    await live.reconnect();
    await waitFor(async () => expect(await bodyRows()).toHaveLength(50));
    expect((await bodyRows())[0]?.textContent).toContain("/after.html");
    expect(screen.getByRole("button", { name: "Show older requests" })).toBeTruthy();
  });

  it("says when the log cannot be loaded, and tries again on request", async () => {
    let failing = true;
    const { user } = await openCrawl({
      intercept: (request) =>
        failing && new URL(request.url).pathname.endsWith("/crawl/requests")
          ? new Response("{}", { status: 500 })
          : undefined,
    });
    expect((await screen.findByText(/Couldn't load the request log/)).textContent).toBeTruthy();
    failing = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/No requests yet/)).toBeTruthy();
  });

  it("shows the server's words when the log is refused with some", async () => {
    await openCrawl({
      intercept: (request) =>
        new URL(request.url).pathname.endsWith("/crawl/requests")
          ? Response.json({ detail: "The log is resting." }, { status: 503 })
          : undefined,
    });
    expect(await screen.findByText("The log is resting.")).toBeTruthy();
    expect(screen.queryByText(/Couldn't load the request log/)).toBeNull();
  });

  it("keeps its own sentence when the log is refused with only a title", async () => {
    await openCrawl({
      intercept: (request) =>
        new URL(request.url).pathname.endsWith("/crawl/requests")
          ? Response.json({ title: "Unauthorized", status: 401 }, { status: 401 })
          : undefined,
    });
    expect(await screen.findByText("Couldn't load the request log.")).toBeTruthy();
    expect(screen.queryByText(/Unauthorized/)).toBeNull();
  });

  it("loads a log that failed again once the connection comes back", async () => {
    let failing = true;
    const events = fakeEventStream();
    await openCrawl({
      events,
      intercept: (request) =>
        failing && new URL(request.url).pathname.endsWith("/crawl/requests")
          ? new Response("{}", { status: 500 })
          : undefined,
    });
    await screen.findByText(/Couldn't load the request log/);
    failing = false;
    await events.reconnect();
    expect(await screen.findByText(/No requests yet/)).toBeTruthy();
  });

  it("keeps the rows and offers another try when an older page fails", async () => {
    const server = realServer();
    logRequests(
      server,
      Array.from({ length: 60 }, (_, i) => ({ at: new Date(Date.now() - (60 - i) * 1000) })),
    );
    let failing = false;
    const { user } = await openCrawl({
      server,
      intercept: (request) =>
        failing && new URL(request.url).searchParams.has("cursor")
          ? new Response("{}", { status: 500 })
          : undefined,
    });
    await waitFor(async () => expect(await bodyRows()).toHaveLength(50));
    failing = true;
    await user.click(screen.getByRole("button", { name: "Show older requests" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/older requests/);
    expect(await bodyRows()).toHaveLength(50);
    failing = false;
    await user.click(screen.getByRole("button", { name: "Show older requests" }));
    await waitFor(async () => expect(await bodyRows()).toHaveLength(60));
  });
});
