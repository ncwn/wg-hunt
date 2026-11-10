// @vitest-environment jsdom
import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CRAWL_RETRY_MS } from "../src/crawl-status.js";
import { createEventSourceStream, type ServerEvent } from "../src/events.js";
import { crawlStatus, fakeServer } from "./fake-server.js";
import { fakeEventStream, renderDashboard } from "./render.js";

// 14:35 in Berlin (summer time) on 10 June 2026.
const UNTIL = "2026-06-10T12:35:00.000Z";

const card = async () => within(await screen.findByRole("region", { name: "Hunting status" }));
const pill = async () => within(await screen.findByRole("banner"));
const alarm = async () => {
  const alerts = await screen.findAllByRole("alert");
  const found = alerts.find((a) => a.classList.contains("hunt-alert"));
  if (!found) throw new Error("No hunting alarm on the page");
  return within(found);
};
const statusEvent = (change: Parameters<typeof crawlStatus>[0]): ServerEvent => ({
  type: "crawl-status-changed",
  data: crawlStatus(change),
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-10T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("hunting status", () => {
  it("says hunting is on, in the top bar and on the Overview, with a Pause", async () => {
    renderDashboard(fakeServer({ signedIn: true }).fetch);
    expect(await (await pill()).findByText("Hunting")).toBeTruthy();
    const c = await card();
    expect(await c.findByRole("heading", { name: "Hunting is on" })).toBeTruthy();
    expect(c.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(c.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(screen.queryByText(/12\s*\/\s*300/)).toBeNull();
  });

  it("says when it checks next, in the pill's tooltip", async () => {
    renderDashboard(
      fakeServer({
        signedIn: true,
        crawl: crawlStatus({
          nextJobs: [{ kind: "poll", path: "/p.html", dueAt: "2026-06-10T10:20:00.000Z" }],
          nextRequest: { at: "2026-06-10T10:20:00.000Z", waitingFor: null },
        }),
      }).fetch,
    );
    const tip = await (await pill()).findByRole("tooltip");
    expect(tip.textContent).toBe("Next check at 12:20");
  });

  it("takes the next check's time from the server, not from the queue", async () => {
    renderDashboard(
      fakeServer({
        signedIn: true,
        crawl: crawlStatus({
          nextJobs: [{ kind: "poll", path: "/p.html", dueAt: "2026-06-10T10:20:00.000Z" }],
          nextRequest: { at: "2026-06-11T05:00:00.000Z", waitingFor: "daily-cap" },
        }),
      }).fetch,
    );
    const tip = await (await pill()).findByRole("tooltip");
    expect(tip.textContent).toBe("Next check at Thu 07:00");
  });

  it("shows the status on every page", async () => {
    const { user } = renderDashboard(fakeServer({ signedIn: true }).fetch);
    await (await pill()).findByText("Hunting");
    await user.click(screen.getByRole("link", { name: "Searches" }));
    expect(await (await pill()).findByText("Hunting")).toBeTruthy();
  });

  it("pauses and resumes through the API", async () => {
    const server = fakeServer({ signedIn: true });
    const { user } = renderDashboard(server.fetch);
    const c = await card();
    await user.click(await c.findByRole("button", { name: "Pause" }));
    expect(await c.findByRole("heading", { name: "Hunting is paused" })).toBeTruthy();
    expect(server.state.requests).toContain("POST /api/v1/crawl/pause");

    await user.click(c.getByRole("button", { name: "Resume" }));
    expect(await c.findByRole("heading", { name: "Hunting is on" })).toBeTruthy();
    expect(server.state.requests).toContain("POST /api/v1/crawl/resume");
  });

  it("follows the live events", async () => {
    const live = fakeEventStream();
    renderDashboard(fakeServer({ signedIn: true }).fetch, "/", live.stream);
    const c = await card();
    await c.findByRole("heading", { name: "Hunting is on" });
    await live.emit(
      statusEvent({
        state: "paused",
        paused: { reason: "user", cause: null, since: UNTIL, path: null, savedAs: null },
      }),
    );
    expect(await c.findByRole("heading", { name: "Hunting is paused" })).toBeTruthy();
    expect(c.getByRole("button", { name: "Resume" })).toBeTruthy();
    expect((await pill()).getByText("Paused")).toBeTruthy();
  });

  it("stops listening when the dashboard goes away", async () => {
    const live = fakeEventStream();
    const { unmount } = renderDashboard(fakeServer({ signedIn: true }).fetch, "/", live.stream);
    await (await card()).findByRole("heading", { name: "Hunting is on" });
    expect(live.listening()).toBeGreaterThanOrEqual(1);
    unmount();
    expect(live.listening()).toBe(0);
  });

  describe("during a break after wg-gesucht asked whether you're a person", () => {
    const cooling = crawlStatus({
      state: "cooling-down",
      cooldown: { until: UNTIL, level: 1, needsResume: false },
      lastBotCheck: {
        at: "2026-06-10T10:35:00.000Z",
        path: "/wg-zimmer-in-Berlin.8.0.1.0.html",
        marker: "checkform",
        hourCount: 4,
        dayCount: 21,
      },
    });

    it("says when it is back, and offers no Resume, since a break can't be cut short", async () => {
      renderDashboard(fakeServer({ signedIn: true, crawl: cooling }).fetch);
      const c = await card();
      expect(await c.findByRole("heading", { name: "Taking a short break" })).toBeTruthy();
      expect(c.getByText(/Back at 14:35/)).toBeTruthy();
      expect(c.queryByRole("button", { name: "Resume" })).toBeNull();
      expect((await pill()).getByRole("tooltip").textContent).toBe("Back at 14:35");
    });

    it("still lets you Pause, and then offers nothing until the break is over", async () => {
      const { user } = renderDashboard(fakeServer({ signedIn: true, crawl: cooling }).fetch);
      const c = await card();
      await user.click(await c.findByRole("button", { name: "Pause" }));
      await waitFor(() => expect(c.queryByRole("button", { name: "Pause" })).toBeNull());
      expect(c.queryByRole("button", { name: "Resume" })).toBeNull();
      expect(
        c.getByText(/until 14:35\. It stays paused after that until you resume it\./),
      ).toBeTruthy();
      expect(c.queryByText(/Back at/)).toBeNull();
      expect((await pill()).getByRole("tooltip").textContent).toBe("On a break until 14:35");
    });

    it("doesn't promise to be back after a second question today: it will wait for you", async () => {
      renderDashboard(
        fakeServer({
          signedIn: true,
          crawl: crawlStatus({
            state: "cooling-down",
            cooldown: { until: UNTIL, level: 2, needsResume: true },
          }),
        }).fetch,
      );
      const c = await card();
      expect(
        await c.findByText(
          "wg-gesucht asked twice today whether you're a person, so wg-hunt is taking a break until 14:35. After that it waits for you to resume.",
        ),
      ).toBeTruthy();
      expect(c.queryByText(/Back at/)).toBeNull();
      expect(c.queryByRole("button", { name: "Resume" })).toBeNull();
      expect(c.getByRole("button", { name: "Pause" })).toBeTruthy();
      expect((await pill()).getByRole("tooltip").textContent).toBe("On a break until 14:35");
    });

    it("offers Resume once a paused hunt's break has ended", async () => {
      renderDashboard(
        fakeServer({
          signedIn: true,
          crawl: crawlStatus({
            state: "paused",
            paused: { reason: "user", cause: null, since: UNTIL, path: null, savedAs: null },
            cooldown: { until: "2026-06-10T09:00:00.000Z", level: 1, needsResume: false },
          }),
        }).fetch,
      );
      expect(await (await card()).findByRole("button", { name: "Resume" })).toBeTruthy();
    });

    it("learns about the question live and says when it is back", async () => {
      const live = fakeEventStream();
      renderDashboard(fakeServer({ signedIn: true }).fetch, "/", live.stream);
      const c = await card();
      await c.findByRole("heading", { name: "Hunting is on" });
      await live.emit(statusEvent(cooling));
      expect(await c.findByText(/Back at 14:35/)).toBeTruthy();
    });

    it("names the day when the break ends on another day", async () => {
      renderDashboard(
        fakeServer({
          signedIn: true,
          crawl: {
            ...cooling,
            cooldown: { until: "2026-06-11T10:35:00.000Z", level: 4, needsResume: false },
          },
        }).fetch,
      );
      expect(await (await card()).findByText(/Back at Thu 12:35/)).toBeTruthy();
    });
  });

  it("says a pause also lifts the stop after a second question today", async () => {
    renderDashboard(
      fakeServer({
        signedIn: true,
        crawl: crawlStatus({
          state: "paused",
          paused: { reason: "user", cause: null, since: UNTIL, path: null, savedAs: null },
          cooldown: { until: "2026-06-10T09:00:00.000Z", level: 2, needsResume: true },
        }),
      }).fetch,
    );
    const c = await card();
    expect(
      await c.findByText(
        "Hunting is paused until you resume it. wg-gesucht asked twice today whether you're a person, so resume when you're ready.",
      ),
    ).toBeTruthy();
    expect(c.getByRole("button", { name: "Resume" })).toBeTruthy();
  });

  it("stops and asks for a Resume after wg-gesucht asked twice, on every page", async () => {
    const { user } = renderDashboard(
      fakeServer({
        signedIn: true,
        crawl: crawlStatus({
          state: "needs-resume",
          cooldown: { until: UNTIL, level: 2, needsResume: true },
        }),
      }).fetch,
    );
    const a = await alarm();
    const why =
      "wg-gesucht asked twice today whether you're a person, so wg-hunt stopped to be safe.";
    expect(a.getByText(why)).toBeTruthy();
    expect((a.getByRole("button", { name: "Resume" }) as HTMLButtonElement).disabled).toBe(false);
    expect((await pill()).getByText("Needs you")).toBeTruthy();

    const fold = a.getByRole("button", { name: why });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    await user.click(fold);
    expect(a.getByText("Resume when you're ready.")).toBeTruthy();

    await user.click(screen.getByRole("link", { name: "Searches" }));
    expect((await alarm()).getByText(why)).toBeTruthy();
  });

  it("opens the alarm's fold to explain a refused Resume", async () => {
    const server = fakeServer({
      signedIn: true,
      crawl: crawlStatus({
        state: "needs-resume",
        cooldown: { until: UNTIL, level: 2, needsResume: true },
      }),
    });
    server.state.refuseResume = "Cooling down after a Bot check.";
    const { user } = renderDashboard(server.fetch, "/searches");
    await user.click((await alarm()).getByRole("button", { name: "Resume" }));
    const a = await alarm();
    expect(await a.findByText(/Cooling down/)).toBeTruthy();
    expect(a.getByRole("button", { expanded: true })).toBeTruthy();
  });

  it("resumes from the alarm", async () => {
    const server = fakeServer({
      signedIn: true,
      crawl: crawlStatus({
        state: "needs-resume",
        cooldown: { until: UNTIL, level: 2, needsResume: true },
      }),
    });
    const { user } = renderDashboard(server.fetch, "/searches");
    await user.click((await alarm()).getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(document.querySelector(".hunt-alert")).toBeNull());
    expect(server.state.requests).toContain("POST /api/v1/crawl/resume");
  });

  it("stops after a page it didn't expect, with a Resume", async () => {
    renderDashboard(
      fakeServer({
        signedIn: true,
        crawl: crawlStatus({
          state: "layout-changed",
          paused: {
            reason: "layout-changed",
            cause: "unexpected-page",
            since: UNTIL,
            path: "/p.html",
            savedAs: "x",
          },
        }),
      }).fetch,
    );
    const a = await alarm();
    expect(a.getByText(/a page wg-hunt didn't expect/)).toBeTruthy();
    expect(a.getByText("Resume once wg-hunt is up to date.")).toBeTruthy();
    expect(a.getByRole("button", { name: "Resume" })).toBeTruthy();
  });

  it("stops after failing to handle a page, and says where the answer is if it comes back", async () => {
    renderDashboard(
      fakeServer({
        signedIn: true,
        crawl: crawlStatus({
          state: "layout-changed",
          paused: {
            reason: "layout-changed",
            cause: "handler-error",
            since: UNTIL,
            path: "/p.html",
            savedAs: "x",
          },
        }),
      }).fetch,
    );
    const a = await alarm();
    expect(a.getByText(/wg-hunt failed while handling a page/)).toBeTruthy();
    const next = a.getByText(/Resume to try again\. If it stops again/).textContent ?? "";
    expect(next).toMatch(/the disk, the database, or a page wg-hunt can't handle/);
    expect(next).toMatch(/the server's log has the error/);
    expect(next).toMatch(/the request log under Settings › Advanced names the page/);
    expect(a.queryByText(/didn't expect/)).toBeNull();
    expect(a.queryByText(/up to date/)).toBeNull();
    expect(a.getByRole("button", { name: "Resume" })).toBeTruthy();
  });

  it("words a layout stop without a cause, from before causes were recorded, as a changed page", async () => {
    renderDashboard(
      fakeServer({
        signedIn: true,
        crawl: crawlStatus({
          state: "layout-changed",
          paused: {
            reason: "layout-changed",
            cause: null,
            since: UNTIL,
            path: "/p.html",
            savedAs: null,
          },
        }),
      }).fetch,
    );
    expect((await alarm()).getByText(/a page wg-hunt didn't expect/)).toBeTruthy();
  });

  it("stops when the disk is nearly full, with a Resume and no Pause", async () => {
    renderDashboard(
      fakeServer({
        signedIn: true,
        crawl: crawlStatus({
          state: "disk-full",
          paused: { reason: "disk-full", cause: null, since: UNTIL, path: null, savedAs: null },
        }),
      }).fetch,
    );
    const a = await alarm();
    expect(a.getByText(/almost out of space/)).toBeTruthy();
    expect(a.getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });

  it("is paused after a wipe, without an alarm, and resumes to read every Search again", async () => {
    renderDashboard(
      fakeServer({
        signedIn: true,
        crawl: crawlStatus({
          state: "wiped",
          paused: { reason: "wiped", cause: null, since: UNTIL, path: null, savedAs: null },
        }),
      }).fetch,
    );
    const c = await card();
    expect(await c.findByRole("heading", { name: "Hunting is paused" })).toBeTruthy();
    expect(c.getByText(/because you deleted all offer data/)).toBeTruthy();
    expect(c.getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(document.querySelector(".hunt-alert")).toBeNull();
  });

  it("offers no Resume while the wipe still runs", async () => {
    renderDashboard(
      fakeServer({
        signedIn: true,
        crawl: crawlStatus({
          state: "wiped",
          paused: { reason: "wiped", cause: null, since: UNTIL, path: null, savedAs: null },
          actions: { pause: false, resume: false },
        }),
      }).fetch,
    );
    const c = await card();
    expect(await c.findByText(/wg-hunt is deleting all offer data/)).toBeTruthy();
    const resume = c.queryByRole("button", { name: "Resume" }) as HTMLButtonElement | null;
    expect(resume === null || resume.disabled).toBe(true);
  });

  it("rests outside the hours you set", async () => {
    renderDashboard(
      fakeServer({ signedIn: true, crawl: crawlStatus({ state: "outside-hours" }) }).fetch,
    );
    const c = await card();
    expect(await c.findByRole("heading", { name: "Resting for the night" })).toBeTruthy();
    expect(c.getByText(/outside the hours you set/)).toBeTruthy();
    expect((await pill()).getByText("Resting")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("explains a refused Resume instead of failing silently", async () => {
    const server = fakeServer({ signedIn: true });
    server.state.refuseResume = "Cooling down after a Bot check until 2026-06-10T12:35:00.000Z.";
    const { user } = renderDashboard(server.fetch, "/");
    const c = await card();
    await user.click(await c.findByRole("button", { name: "Pause" }));
    await user.click(await c.findByRole("button", { name: "Resume" }));
    expect((await c.findByRole("alert")).textContent).toMatch(/Cooling down/);
  });

  it("says so when the status cannot be read", async () => {
    const server = fakeServer({ signedIn: true });
    renderDashboard(async (request) =>
      new URL(request.url).pathname === "/api/v1/crawl"
        ? new Response("{}", { status: 500 })
        : server.fetch(request),
    );
    expect(await screen.findByText(/Couldn't tell whether wg-hunt is hunting/)).toBeTruthy();
  });

  it("asks for an unreadable status again once the connection comes back", async () => {
    const server = fakeServer({ signedIn: true });
    const events = fakeEventStream();
    let broken = true;
    renderDashboard(
      async (request) =>
        broken && new URL(request.url).pathname === "/api/v1/crawl"
          ? new Response("{}", { status: 500 })
          : server.fetch(request),
      "/",
      events.stream,
    );
    await screen.findByText(/Couldn't tell whether wg-hunt is hunting/);
    broken = false;
    await events.reconnect();
    expect(await (await pill()).findByText("Hunting")).toBeTruthy();
  });

  it("asks for an unreadable status again by itself, without waiting for an event", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const server = fakeServer({ signedIn: true });
    let broken = true;
    renderDashboard(async (request) =>
      broken && new URL(request.url).pathname === "/api/v1/crawl"
        ? new Response("{}", { status: 500 })
        : server.fetch(request),
    );
    await screen.findByText(/Couldn't tell whether wg-hunt is hunting/);
    broken = false;
    await act(() => vi.advanceTimersByTimeAsync(CRAWL_RETRY_MS));
    expect(await (await pill()).findByText("Hunting")).toBeTruthy();
  });
});

describe("the event stream over EventSource", () => {
  class FakeEventSource {
    static last: FakeEventSource | undefined;
    closed = false;
    private listeners = new Map<string, ((e: MessageEvent) => void)[]>();
    constructor(readonly url: string) {
      FakeEventSource.last = this;
    }
    addEventListener(type: string, listener: (e: MessageEvent) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    close() {
      this.closed = true;
    }
    emit(type: string, data: string) {
      for (const l of this.listeners.get(type) ?? []) l(new MessageEvent(type, { data }));
    }
  }

  it("opens one connection to /api/v1/events while anyone listens and types what arrives", () => {
    const stream = createEventSourceStream({
      EventSource: FakeEventSource as unknown as typeof EventSource,
    });
    const seen: ServerEvent[] = [];
    const stopA = stream.subscribe((e) => seen.push(e));
    const stopB = stream.subscribe(() => {});
    expect(FakeEventSource.last?.url).toBe("/api/v1/events");

    FakeEventSource.last?.emit("crawl-status-changed", JSON.stringify(crawlStatus()));
    FakeEventSource.last?.emit("some-future-event", "{}");
    FakeEventSource.last?.emit("crawl-status-changed", "not json");
    expect(seen.map((e) => e.type)).toEqual(["crawl-status-changed"]);

    const source = FakeEventSource.last;
    stopA();
    expect(source?.closed).toBe(false);
    stopB();
    expect(source?.closed).toBe(true);
  });

  it("does nothing where the browser has no EventSource", () => {
    const stream = createEventSourceStream({ EventSource: undefined });
    expect(() => stream.subscribe(() => {})()).not.toThrow();
  });
});
