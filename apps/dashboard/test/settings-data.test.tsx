// @vitest-environment jsdom
import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatBytes } from "../src/settings/bytes.js";
import { WIPE_POLL_MS } from "../src/settings/DataSection.js";
import { openAdvanced } from "./advanced.js";
import { realServer } from "./real-server.js";
import { renderDashboard } from "./render.js";

const PHRASE = "delete all Offer data";

const phase = (counts: { done?: number; skipped?: number; failed?: number } = {}) => ({
  state: "finished",
  startedAt: "2026-11-10T08:00:00.000Z",
  finishedAt: "2026-11-10T08:00:01.000Z",
  done: 0,
  skipped: 0,
  failed: 0,
  ...counts,
});
const CAUGHT_UP = {
  state: "finished",
  startedAt: "2026-11-10T08:00:00.000Z",
  finishedAt: "2026-11-10T08:00:01.000Z",
  phases: {
    adoptPages: phase(),
    backfillProfiles: phase(),
    followCurrent: phase(),
    reparse: phase({ done: 4 }),
  },
};

const STORAGE = {
  database: { bytes: 5_242_880 },
  snapshots: { files: 12, bytes: 1_572_864 },
  unexpectedPages: { files: 1, bytes: 2048 },
  freeBytes: 40 * 1024 ** 3,
  offers: { total: 30, shown: 20, stale: 6, untracked: 4, keptForMarks: 3 },
  requestLog: { rows: 321 },
  retention: {
    recordDays: 90,
    snapshotDays: 30,
    unexpectedPageDays: 30,
    requestLogDays: 30,
    lowDiskBytes: 1024 ** 3,
    pruneAt: "03:00 Europe/Berlin",
  },
  lastPrune: null,
  prune: {
    state: "never",
    lastAttempt: null,
    lastSuccess: null,
    failingSince: null,
    failures: 0,
    nextAttemptAt: null,
  },
  wipe: { running: null, last: null },
  catchUp: CAUGHT_UP,
};

/** 03:00 in Berlin is 02:00 UTC in winter. */
const attempt = (startedAt: string, outcome: { deleted?: object; error?: string }) => ({
  startedAt,
  finishedAt: startedAt,
  deleted: outcome.deleted ?? null,
  error: outcome.error ?? null,
});
const NOTHING = { offers: 0, snapshots: 0, unexpectedPages: 0, requests: 0 };

async function openData(
  options: {
    fetchOverride?: (r: Request) => Response | Promise<Response | undefined> | undefined;
  } = {},
) {
  const server = realServer({ signedIn: true });
  await server.ready;
  const requests: string[] = [];
  const fetch = async (request: Request) => {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return (await options.fetchOverride?.(request)) ?? server.fetch(request);
  };
  const { user, unmount } = renderDashboard(fetch, "/settings");
  await openAdvanced(user);
  const heading = await screen.findByRole("heading", { level: 3, name: "Stored data" });
  const section = within(heading.closest("section") as HTMLElement);
  await section.findByText("Free disk space");
  return { server, user, section, requests, unmount };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": status >= 400 ? "application/problem+json" : "application/json" },
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1 KB"],
    [1_572_864, "1.5 MB"],
    [1024 ** 3, "1 GB"],
    [40 * 1024 ** 3, "40 GB"],
  ])("writes %d as %s", (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});

describe("Settings: Data", () => {
  it("says when a wipe is under way", async () => {
    const { section } = await openData({
      fetchOverride: (request) =>
        new URL(request.url).pathname === "/api/v1/storage"
          ? json({
              ...STORAGE,
              wipe: { running: { since: "2026-06-10T10:00:00.000Z" }, last: null },
            })
          : undefined,
    });
    expect(await section.findByText("Deleting all offer data")).toBeTruthy();
  });

  it("reads the storage again while a wipe started elsewhere runs, until it is done", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let running = true;
    const { section, requests, unmount } = await openData({
      fetchOverride: (request) =>
        new URL(request.url).pathname === "/api/v1/storage"
          ? json({
              ...STORAGE,
              offers: running ? STORAGE.offers : { ...STORAGE.offers, shown: 0 },
              wipe: { running: running ? { since: "2026-06-10T10:00:00.000Z" } : null, last: null },
            })
          : undefined,
    });
    const reads = () => requests.filter((r) => r === "GET /api/v1/storage").length;
    const shown = () =>
      section.getByText("Offers shown", { selector: "dt" }).nextElementSibling?.textContent;
    expect(await section.findByText("Deleting all offer data")).toBeTruthy();
    const before = reads();

    await act(() => vi.advanceTimersByTimeAsync(WIPE_POLL_MS));
    await waitFor(() => expect(reads()).toBe(before + 1));
    expect(section.getByText("Deleting all offer data")).toBeTruthy();

    running = false;
    await act(() => vi.advanceTimersByTimeAsync(WIPE_POLL_MS));
    await waitFor(() => expect(section.queryByText("Deleting all offer data")).toBeNull());
    expect(shown()).toBe("0");
    const after = reads();
    await act(() => vi.advanceTimersByTimeAsync(WIPE_POLL_MS * 3));
    expect(reads()).toBe(after);
    unmount();
  });

  it("stops reading the storage again once Settings is gone", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { section, requests, unmount } = await openData({
      fetchOverride: (request) =>
        new URL(request.url).pathname === "/api/v1/storage"
          ? json({
              ...STORAGE,
              wipe: { running: { since: "2026-06-10T10:00:00.000Z" }, last: null },
            })
          : undefined,
    });
    const reads = () => requests.filter((r) => r === "GET /api/v1/storage").length;
    expect(await section.findByText("Deleting all offer data")).toBeTruthy();

    unmount();
    const after = reads();
    await act(() => vi.advanceTimersByTimeAsync(WIPE_POLL_MS * 3));
    expect(reads()).toBe(after);
  });

  it("shows the storage readout", async () => {
    const { section } = await openData({
      fetchOverride: (request) =>
        new URL(request.url).pathname === "/api/v1/storage" ? json(STORAGE) : undefined,
    });
    const value = (label: string) =>
      section.getAllByText(label, { selector: "dt" })[0]?.nextElementSibling?.textContent;
    expect(value("Database")).toBe("5 MB");
    expect(value("Saved Offer pages")).toBe("1.5 MB in 12 files");
    expect(value("Pages that looked different")).toMatch(/2 KB in 1 file$/);
    expect(value("Request log")).toBe("321 requests");
    expect(value("Free disk space")).toBe("40 GB");
    expect(value("Offers shown")).toBe("20");
    expect(value("Stale Offers")).toBe("6");
    expect(value("Untracked Offers")).toBe("4");
    expect(value("Kept for your marks")).toBe("3");
  });

  it("reads the real server's numbers on a fresh instance", async () => {
    const { section } = await openData();
    const value = (label: string) =>
      section.getByText(label, { selector: "dt" }).nextElementSibling?.textContent;
    expect(value("Offers shown")).toBe("0");
    expect(value("Last clean-up")).toBe("Not yet. It runs within a minute of wg-hunt starting.");
  });

  describe("the nightly clean-up", () => {
    const withPrune = (prune: object, lastPrune: string | null = null) =>
      openData({
        fetchOverride: (request) =>
          new URL(request.url).pathname === "/api/v1/storage"
            ? json({ ...STORAGE, lastPrune, prune })
            : undefined,
      });
    const lastCleanUp = (section: Awaited<ReturnType<typeof openData>>["section"]) =>
      section.getByText("Last clean-up", { selector: "dt" }).nextElementSibling?.textContent;

    it("says when it last cleaned up and how much it removed", async () => {
      const done = attempt("2026-11-10T02:00:00.000Z", {
        deleted: { offers: 3, snapshots: 12, unexpectedPages: 1, requests: 40 },
      });
      const { section } = await withPrune(
        {
          state: "ok",
          lastAttempt: done,
          lastSuccess: done,
          failingSince: null,
          failures: 0,
          nextAttemptAt: "2026-11-11T02:00:00.000Z",
        },
        done.startedAt,
      );
      expect(lastCleanUp(section)).toBe(
        "10 Nov 2026, 03:00. It removed 3 offers, 12 saved pages, 1 page that looked different and 40 logged requests.",
      );
      expect(section.queryByText(/clean-up is failing/)).toBeNull();
    });

    it("says so when nothing was old enough to remove", async () => {
      const done = attempt("2026-11-10T02:00:00.000Z", { deleted: NOTHING });
      const { section } = await withPrune({
        state: "ok",
        lastAttempt: done,
        lastSuccess: done,
        failingSince: null,
        failures: 0,
        nextAttemptAt: "2026-11-11T02:00:00.000Z",
      });
      expect(lastCleanUp(section)).toBe("10 Nov 2026, 03:00. Nothing was old enough to remove.");
    });

    it("gives only the time for a clean-up whose counts were not kept", async () => {
      const done = attempt("2026-11-10T02:00:00.000Z", {});
      const { section } = await withPrune({
        state: "ok",
        lastAttempt: done,
        lastSuccess: done,
        failingSince: null,
        failures: 0,
        nextAttemptAt: "2026-11-11T02:00:00.000Z",
      });
      expect(lastCleanUp(section)).toBe("10 Nov 2026, 03:00");
    });

    it("says it has been failing since a time, why, and when it tries again", async () => {
      const worked = attempt("2026-11-09T02:00:00.000Z", { deleted: NOTHING });
      const { section } = await withPrune({
        state: "failing",
        lastAttempt: attempt("2026-11-10T02:15:00.000Z", { error: "disk-full" }),
        lastSuccess: worked,
        failingSince: "2026-11-10T02:00:00.000Z",
        failures: 2,
        nextAttemptAt: "2026-11-10T02:45:00.000Z",
      });
      const title = await section.findByText("The nightly clean-up is failing: the disk is full");
      const notice = title.closest(".wh-notice");
      expect(notice?.textContent).toMatch(
        /It has failed since 10 Nov 2026, 03:00\. Until it works, old data may stay longer than it should\. Free some space/,
      );
      expect(notice?.textContent).toMatch(/tries again around 10 Nov 2026, 03:45\./);
      expect(title.closest("button")?.getAttribute("aria-expanded")).toBe("true");
      expect(lastCleanUp(section)).toBe("9 Nov 2026, 03:00. Nothing was old enough to remove.");
    });

    it.each([
      ["database-busy", /something else was using the database/],
      ["database-error", /the database reported an error/],
      ["unknown", /something unexpected went wrong/],
    ])("gives the reason for %s in plain words", async (error, words) => {
      const { section } = await withPrune({
        state: "failing",
        lastAttempt: attempt("2026-11-10T02:00:00.000Z", { error }),
        lastSuccess: null,
        failingSince: "2026-11-10T02:00:00.000Z",
        failures: 1,
        nextAttemptAt: "2026-11-10T02:15:00.000Z",
      });
      const notice = (await section.findByText(/The nightly clean-up is failing/)).closest(
        ".wh-notice",
      );
      expect(notice?.textContent).toMatch(words);
      expect(notice?.textContent).not.toMatch(/Free some space/);
      expect(lastCleanUp(section)).toBe("It has not worked yet");
    });
  });

  describe("the catch-up after a start", () => {
    type Section = Awaited<ReturnType<typeof openData>>["section"];
    const withCatchUp = (catchUp: () => object) =>
      openData({
        fetchOverride: (request) =>
          new URL(request.url).pathname === "/api/v1/storage"
            ? json({ ...STORAGE, catchUp: catchUp() })
            : undefined,
      });
    const rows = (section: Section) => {
      const list = section.queryByLabelText("After the last start");
      return list === null
        ? []
        : within(list)
            .getAllByRole("term")
            .map((term) => [term.textContent, term.nextElementSibling?.textContent]);
    };

    it("is not mentioned once it has ended with nothing skipped or failed", async () => {
      const { section } = await withCatchUp(() => CAUGHT_UP);
      expect(rows(section)).toEqual([]);
    });

    it("says it is under way, and reads the storage again until it has ended", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      let running = true;
      const { section, requests, unmount } = await withCatchUp(() =>
        running
          ? {
              ...CAUGHT_UP,
              state: "running",
              finishedAt: null,
              phases: {
                ...CAUGHT_UP.phases,
                reparse: { ...phase({ skipped: 2 }), state: "running", finishedAt: null },
              },
            }
          : CAUGHT_UP,
      );
      const reads = () => requests.filter((r) => r === "GET /api/v1/storage").length;
      expect(rows(section)).toEqual([
        [
          "After starting",
          "Bringing saved offers up to date. wg-hunt does this by itself each time it starts.",
        ],
      ]);
      const before = reads();

      running = false;
      await act(() => vi.advanceTimersByTimeAsync(WIPE_POLL_MS));
      await waitFor(() => expect(rows(section)).toEqual([]));
      expect(reads()).toBe(before + 1);
      await act(() => vi.advanceTimersByTimeAsync(WIPE_POLL_MS * 3));
      expect(reads()).toBe(before + 1);
      unmount();
    });

    it("says how many offers keep facts read by older rules because their page is gone", async () => {
      const { section } = await withCatchUp(() => ({
        ...CAUGHT_UP,
        phases: { ...CAUGHT_UP.phases, reparse: phase({ done: 4, skipped: 12 }) },
      }));
      expect(rows(section)).toEqual([
        [
          "Older facts",
          "12 offers keep facts an older version of wg-hunt read. Their page is gone or can't be read, so wg-hunt can't read it again.",
        ],
      ]);
    });

    it("says what else it had to leave as it was", async () => {
      const { section } = await withCatchUp(() => ({
        ...CAUGHT_UP,
        phases: {
          adoptPages: phase({ skipped: 3 }),
          backfillProfiles: phase({ skipped: 2 }),
          followCurrent: phase({ skipped: 1 }),
          reparse: phase(),
        },
      }));
      expect(rows(section)).toEqual([
        [
          "Earlier ad",
          "1 offer still shows an earlier ad of the room. The page of its latest ad is gone or can't be read.",
        ],
        [
          "Duplicates",
          "2 ads are checked for duplicates with less to go on. Their page is gone or can't be read.",
        ],
        [
          "Saved pages",
          "3 saved pages did not become offers. They were gone or unreadable, or kept failing for a week.",
        ],
      ]);
    });

    it("says how many it failed on, and that the next start tries again", async () => {
      const { section } = await withCatchUp(() => ({
        ...CAUGHT_UP,
        phases: { ...CAUGHT_UP.phases, adoptPages: phase({ failed: 1 }) },
      }));
      expect(rows(section)).toEqual([
        [
          "Errors",
          "1 offer or page could not be brought up to date. wg-hunt left it as it was and tries again the next time it starts.",
        ],
      ]);
    });

    it("says so when a part of it stopped on an error", async () => {
      const { section } = await withCatchUp(() => ({
        ...CAUGHT_UP,
        state: "failed",
        phases: { ...CAUGHT_UP.phases, reparse: { ...phase(), state: "failed" } },
      }));
      expect(rows(section)).toEqual([
        [
          "Stopped early",
          "Part of bringing saved offers up to date stopped on an error. wg-hunt tries again the next time it starts.",
        ],
      ]);
    });
  });

  it("shows the retention constants read-only", async () => {
    const { section } = await openData();
    const retention = within(section.getByLabelText("Retention"));
    expect(retention.getByText(/90 days after the Offer goes Stale or Untracked/)).toBeTruthy();
    expect(retention.getByText(/30 days after the Offer goes Stale or Untracked/)).toBeTruthy();
    expect(retention.getByText(/03:00 Europe\/Berlin/)).toBeTruthy();
    expect(retention.getByText(/less than 1 GB is\s+free/)).toBeTruthy();
    expect(retention.queryAllByRole("textbox")).toEqual([]);
    expect(retention.queryAllByRole("spinbutton")).toEqual([]);
  });

  it("says why the data can be deleted and what stays", async () => {
    const { section } = await openData();
    expect(section.getByText(/Profile, Filters, Searches and keys stay/)).toBeTruthy();
  });
});

describe("Settings: Delete all Offer data", () => {
  it("asks for the typed confirmation, and sends nothing until it is typed", async () => {
    const { section, user, requests } = await openData();
    await user.click(section.getByRole("button", { name: "Delete all Offer data" }));
    const confirm = section.getByRole("button", { name: "Delete everything" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    const field = section.getByLabelText(new RegExp(PHRASE));
    await user.type(field, "delete all offer data");
    expect(confirm.disabled).toBe(true);
    await user.clear(field);
    await user.type(field, PHRASE);
    expect(confirm.disabled).toBe(false);
    expect(requests.filter((r) => r === "POST /api/v1/storage/wipe")).toEqual([]);
  });

  it("does nothing on Cancel", async () => {
    const { section, user, requests } = await openData();
    await user.click(section.getByRole("button", { name: "Delete all Offer data" }));
    await user.type(section.getByLabelText(new RegExp(PHRASE)), PHRASE);
    await user.click(section.getByRole("button", { name: "Cancel" }));
    expect(section.queryByRole("button", { name: "Delete everything" })).toBeNull();
    expect(requests.filter((r) => r.startsWith("POST /api/v1/storage"))).toEqual([]);
  });

  it("deletes with the typed phrase, pauses crawling, and says what happens next", async () => {
    const { server, section, user } = await openData();
    await user.click(section.getByRole("button", { name: "Delete all Offer data" }));
    await user.type(section.getByLabelText(new RegExp(PHRASE)), PHRASE);
    await user.click(section.getByRole("button", { name: "Delete everything" }));

    const status = await section.findByRole("status");
    expect(status.textContent).toMatch(/Deleted 0 offers and 0 saved pages/);
    expect(status.textContent).toMatch(/Checking is paused/);
    expect(section.queryByLabelText(new RegExp(PHRASE))).toBeNull();
    expect((await (await server.asCli("/crawl")).json()).state).toBe("wiped");
  });

  it("sends the confirmation in the body", async () => {
    let body: unknown;
    const { section, user } = await openData({
      fetchOverride: async (request) => {
        if (new URL(request.url).pathname !== "/api/v1/storage/wipe") return undefined;
        body = await request.clone().json();
        return json({
          deleted: { offers: 3, snapshots: 2, unexpectedPages: 0, requests: 9 },
          storage: {
            ...STORAGE,
            offers: { total: 0, shown: 0, stale: 0, untracked: 0, keptForMarks: 0 },
          },
        });
      },
    });
    await user.click(section.getByRole("button", { name: "Delete all Offer data" }));
    await user.type(section.getByLabelText(new RegExp(PHRASE)), PHRASE);
    await user.click(section.getByRole("button", { name: "Delete everything" }));

    expect((await section.findByRole("status")).textContent).toMatch(
      /Deleted 3 offers and 2 saved pages/,
    );
    expect(body).toEqual({ confirm: PHRASE });
    expect(
      section.getByText("Offers shown", { selector: "dt" }).nextElementSibling?.textContent,
    ).toBe("0");
  });

  it("shows why it failed and keeps the confirmation open", async () => {
    const { section, user } = await openData({
      fetchOverride: (request) =>
        new URL(request.url).pathname === "/api/v1/storage/wipe"
          ? json({ type: "internal-error", title: "Internal server error", status: 500 }, 500)
          : undefined,
    });
    await user.click(section.getByRole("button", { name: "Delete all Offer data" }));
    await user.type(section.getByLabelText(new RegExp(PHRASE)), PHRASE);
    await user.click(section.getByRole("button", { name: "Delete everything" }));

    await waitFor(() =>
      expect(section.getByRole("alert").textContent).toMatch(/Internal server error/),
    );
    expect(section.getByLabelText(new RegExp(PHRASE))).toBeTruthy();
  });

  it("reads the storage again when the wipe's answer is lost, and shows the wipe running", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let wipe: object = STORAGE.wipe;
    const { section, user, requests, unmount } = await openData({
      fetchOverride: (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/api/v1/storage/wipe") {
          wipe = { running: { since: "2026-06-10T10:00:00.000Z" }, last: null };
          throw new TypeError("Failed to fetch");
        }
        return path === "/api/v1/storage" ? json({ ...STORAGE, wipe }) : undefined;
      },
    });
    await user.click(section.getByRole("button", { name: "Delete all Offer data" }));
    await user.type(section.getByLabelText(new RegExp(PHRASE)), PHRASE);
    await user.click(section.getByRole("button", { name: "Delete everything" }));

    expect(await section.findByText("Deleting all offer data")).toBeTruthy();
    expect(section.queryByRole("alert")).toBeNull();
    expect(section.queryByRole("button", { name: "Delete everything" })).toBeNull();

    const counted = () => requests.filter((r) => r === "GET /api/v1/offers/counts").length;
    const before = counted();
    wipe = {
      running: null,
      last: { at: "2026-06-10T10:00:05.000Z", deleted: NOTHING, filesRemoved: true },
    };
    await act(() => vi.advanceTimersByTimeAsync(WIPE_POLL_MS));
    await waitFor(() => expect(section.queryByText("Deleting all offer data")).toBeNull());
    await waitFor(() => expect(counted()).toBeGreaterThan(before));
    unmount();
  });
});
