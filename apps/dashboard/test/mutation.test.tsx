// @vitest-environment jsdom
import { act, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "../src/api/result.js";
import type { ServerEvent } from "../src/events.js";
import { useMutation } from "../src/mutation.js";
import { isNewOffer, markAllSeen, useLastSeen } from "../src/seen.js";
import { crawlStatus, fakeServer } from "./fake-server.js";
import { fakeEventStream, renderDashboard } from "./render.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useMutation", () => {
  it("goes pending, then done with the message, or back to idle without one", async () => {
    const { result } = renderHook(() => useMutation());
    expect(result.current.state).toEqual({ status: "idle" });
    const answer = deferred<Result<string>>();
    let run!: Promise<unknown>;
    act(() => {
      run = result.current.run(
        () => answer.promise,
        (text) => text,
      );
    });
    expect(result.current.state).toEqual({ status: "pending" });
    expect(result.current.busy).toBe(true);
    await act(async () => {
      answer.resolve({ ok: true, data: "Queued" });
      await run;
    });
    expect(result.current.state).toEqual({ status: "done", message: "Queued" });

    await act(async () => {
      await result.current.run(async () => ({ ok: true, data: 1 }));
    });
    expect(result.current.state).toEqual({ status: "idle" });
  });

  it("fails with the refusal, and with 'couldn't reach' when the call throws", async () => {
    const { result } = renderHook(() => useMutation());
    await act(async () => {
      await result.current.run(async () => ({ ok: false, message: "No." }));
    });
    expect(result.current.state).toEqual({ status: "failed", message: "No." });
    await act(async () => {
      await result.current.run(() => Promise.reject(new TypeError("fetch failed")));
    });
    expect(result.current.state).toMatchObject({
      status: "failed",
      message: expect.stringMatching(/Couldn't reach wg-hunt/),
    });
  });

  it("forgets its message when the context changes", async () => {
    const { result, rerender } = renderHook(({ context }) => useMutation(context), {
      initialProps: { context: 1 },
    });
    await act(async () => {
      await result.current.run(async () => ({ ok: false, message: "No." }));
    });
    expect(result.current.state.status).toBe("failed");
    rerender({ context: 2 });
    expect(result.current.state).toEqual({ status: "idle" });
  });

  it("stays busy through a context change until its write settles, then shows a refusal", async () => {
    const { result, rerender } = renderHook(({ context }) => useMutation(context), {
      initialProps: { context: "a" },
    });
    const late = deferred<Result<string>>();
    let run!: Promise<unknown>;
    act(() => {
      run = result.current.run(() => late.promise);
    });
    rerender({ context: "b" });
    expect(result.current.busy).toBe(true);
    await act(async () => {
      late.resolve({ ok: false, message: "Refused" });
      await run;
    });
    expect(result.current.state).toEqual({ status: "failed", message: "Refused" });
    rerender({ context: "c" });
    expect(result.current.state).toEqual({ status: "idle" });
  });

  it("drops a success message that lands after the context changed, and any answer after a reset", async () => {
    const { result, rerender } = renderHook(({ context }) => useMutation(context), {
      initialProps: { context: "a" },
    });
    const late = deferred<Result<string>>();
    let run!: Promise<unknown>;
    act(() => {
      run = result.current.run(
        () => late.promise,
        (text) => text,
      );
    });
    rerender({ context: "b" });
    await act(async () => {
      late.resolve({ ok: true, data: "Queued" });
      await run;
    });
    expect(result.current.state).toEqual({ status: "idle" });

    const later = deferred<Result<string>>();
    let settled: unknown = "unset";
    act(() => {
      run = result.current.run(() => later.promise);
    });
    act(() => result.current.reset());
    expect(result.current.busy).toBe(false);
    await act(async () => {
      later.resolve({ ok: false, message: "Too late" });
      settled = await run;
    });
    expect(settled).toBeUndefined();
    expect(result.current.state).toEqual({ status: "idle" });
  });
});

describe("a refused Resume", () => {
  const UNTIL = "2026-06-10T12:35:00.000Z";
  const asked: ServerEvent = {
    type: "crawl-status-changed",
    data: crawlStatus({
      state: "needs-resume",
      cooldown: { until: UNTIL, level: 2, needsResume: true },
    }),
  };
  const running: ServerEvent = { type: "crawl-status-changed", data: crawlStatus() };
  const alarm = () => document.querySelector<HTMLElement>(".hunt-alert");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-10T10:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("is gone, and the fold closed, when a later alarm comes back", async () => {
    const server = fakeServer({ signedIn: true, crawl: asked.data as never });
    server.state.refuseResume = "Cooling down after a Bot check.";
    const events = fakeEventStream();
    const { user } = renderDashboard(server.fetch, "/searches", events.stream);
    await waitFor(() => expect(alarm()).not.toBeNull());
    await user.click(within(alarm() as HTMLElement).getByRole("button", { name: "Resume" }));
    expect(await within(alarm() as HTMLElement).findByText(/Cooling down/)).toBeTruthy();

    await events.emit(running);
    await waitFor(() => expect(alarm()).toBeNull());
    await events.emit(asked);
    await waitFor(() => expect(alarm()).not.toBeNull());

    const again = within(alarm() as HTMLElement);
    expect(again.queryByText(/Cooling down/)).toBeNull();
    expect(again.getByRole("button", { expanded: false })).toBeTruthy();
  });

  it("leaves the Overview's status card once the hunt moves on", async () => {
    const server = fakeServer({ signedIn: true });
    server.state.refuseResume = "Cooling down after a Bot check.";
    const events = fakeEventStream();
    const { user } = renderDashboard(server.fetch, "/", events.stream);
    const card = within(await screen.findByRole("region", { name: "Hunting status" }));
    await user.click(await card.findByRole("button", { name: "Pause" }));
    await user.click(await card.findByRole("button", { name: "Resume" }));
    expect((await card.findByRole("alert")).textContent).toMatch(/Cooling down/);

    await events.emit(running);
    await waitFor(() => expect(card.queryByRole("alert")).toBeNull());
  });
});

describe("Mark all seen", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("still takes effect when the browser refuses to store it but reads the old time", () => {
    localStorage.setItem("wg-hunt.offers.last-seen", String(Date.parse("2026-06-01T00:00:00Z")));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const { result } = renderHook(() => useLastSeen());
    const at = Date.parse("2026-06-10T10:00:00Z");
    act(() => markAllSeen(at));
    expect(result.current).toBe(at);
    const offer = {
      band: "match",
      createdAt: "2026-06-05T00:00:00Z",
      bandChangedAt: "2026-06-05T00:00:00Z",
    };
    expect(isNewOffer(offer, result.current)).toBe(false);
  });
});

describe("two writes to one Offer", () => {
  it("go out one after another, so the newer answer is the one that lands last", async () => {
    const { createApiClient } = await import("../src/api/client.js");
    const { setMarks } = await import("../src/offers.js");
    const sent: string[] = [];
    const first = deferred<void>();
    const api = createApiClient({
      baseUrl: "http://localhost/api/v1",
      fetch: async (request: Request) => {
        const body = await request.text();
        sent.push(body);
        if (sent.length === 1) await first.promise;
        return new Response(JSON.stringify({ id: 7, marks: JSON.parse(body) }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    const landed: string[] = [];
    const a = setMarks(api, 7, { shortlisted: true }).then(() => landed.push("a"));
    const b = setMarks(api, 7, { contacted: true }).then(() => landed.push("b"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(1);
    first.resolve();
    await Promise.all([a, b]);
    expect(sent).toHaveLength(2);
    expect(landed).toEqual(["a", "b"]);
  });
});
