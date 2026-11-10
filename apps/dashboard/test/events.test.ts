import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pausedLine } from "../src/components/ConnectionNotice.js";
import { createEventSourceStream, type StreamState } from "../src/events.js";

class FakeEventSource {
  static all: FakeEventSource[] = [];
  static get last() {
    return FakeEventSource.all.at(-1);
  }
  readyState = 0;
  closed = false;
  private listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
  addEventListener(type: string, listener: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  fire(type: string, data = "") {
    for (const l of this.listeners.get(type) ?? []) l(new MessageEvent(type, { data }));
  }
  open() {
    this.readyState = 1;
    this.fire("open");
  }
  /** The connection dropped; the browser reopens it by itself. */
  drop() {
    this.readyState = 0;
    this.fire("error");
  }
  /** An HTTP error (a 401, a proxy's 502): the browser gives up for good. */
  refuse() {
    this.readyState = 2;
    this.fire("error");
  }
}

const NOW = 1_000_000;

function stream() {
  const events = createEventSourceStream({
    EventSource: FakeEventSource as unknown as typeof EventSource,
    retry: { firstMs: 1_000, maxMs: 4_000 },
    now: () => NOW,
  });
  const states: StreamState["status"][] = [];
  events.onState((state) => states.push(state.status));
  let reconnects = 0;
  events.onReconnect(() => reconnects++);
  const ended: string[] = [];
  events.onSessionEnded((reason) => ended.push(reason));
  return { events, states, reconnects: () => reconnects, ended };
}

beforeEach(() => {
  FakeEventSource.all = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the event stream's states", () => {
  it("is closed until someone listens, connecting, then live", () => {
    const { events, states } = stream();
    expect(events.state()).toEqual({ status: "closed" });
    events.subscribe(() => {});
    expect(events.state()).toEqual({ status: "connecting" });
    FakeEventSource.last?.open();
    expect(events.state()).toEqual({ status: "live" });
    expect(states).toEqual(["connecting", "live"]);
  });

  it("is reconnecting while the browser reopens a dropped connection, and catches up once open", () => {
    const { events, reconnects } = stream();
    events.subscribe(() => {});
    FakeEventSource.last?.open();
    FakeEventSource.last?.drop();
    expect(events.state()).toEqual({ status: "reconnecting" });
    expect(FakeEventSource.all).toHaveLength(1);
    FakeEventSource.last?.open();
    expect(events.state()).toEqual({ status: "live" });
    expect(reconnects()).toBe(1);
  });

  it("fails after an HTTP error, retries with a growing wait, and catches up once open", () => {
    const { events, reconnects } = stream();
    events.subscribe(() => {});
    FakeEventSource.last?.open();
    const first = FakeEventSource.last;

    first?.refuse();
    expect(first?.closed).toBe(true);
    expect(events.state()).toEqual({ status: "failed", retryAt: NOW + 1_000 });
    vi.advanceTimersByTime(1_000);
    expect(FakeEventSource.all).toHaveLength(2);
    expect(events.state()).toEqual({ status: "reconnecting" });

    FakeEventSource.last?.refuse();
    expect(events.state()).toEqual({ status: "failed", retryAt: NOW + 2_000 });
    vi.advanceTimersByTime(2_000);
    FakeEventSource.last?.open();
    expect(events.state()).toEqual({ status: "live" });
    expect(reconnects()).toBe(1);

    FakeEventSource.last?.refuse();
    expect(events.state()).toEqual({ status: "failed", retryAt: NOW + 1_000 });
  });

  it("catches up once open when the first connection failed before it ever opened", () => {
    const { events, reconnects } = stream();
    events.subscribe(() => {});
    FakeEventSource.last?.refuse();
    vi.advanceTimersByTime(1_000);
    FakeEventSource.last?.open();
    expect(events.state()).toEqual({ status: "live" });
    expect(reconnects()).toBe(1);
  });

  it("catches up once open when the first connection dropped before it ever opened", () => {
    const { events, reconnects } = stream();
    events.subscribe(() => {});
    FakeEventSource.last?.drop();
    FakeEventSource.last?.open();
    expect(reconnects()).toBe(1);
  });

  it("stays paused while a retry after a failure connects, even if it hangs", () => {
    const { events } = stream();
    events.subscribe(() => {});
    FakeEventSource.last?.open();
    FakeEventSource.last?.refuse();
    vi.advanceTimersByTime(1_000);
    expect(FakeEventSource.all).toHaveLength(2);
    expect(events.state()).toEqual({ status: "reconnecting" });
    expect(pausedLine(events.state())).toBeDefined();

    FakeEventSource.last?.refuse();
    events.reopen();
    expect(events.state()).toEqual({ status: "reconnecting" });
    FakeEventSource.last?.open();
    expect(pausedLine(events.state())).toBeUndefined();
  });

  it("never waits longer than the longest wait", () => {
    const { events } = stream();
    events.subscribe(() => {});
    for (let i = 0; i < 5; i++) {
      FakeEventSource.last?.refuse();
      vi.runOnlyPendingTimers();
    }
    FakeEventSource.last?.refuse();
    expect(events.state()).toEqual({ status: "failed", retryAt: NOW + 4_000 });
  });

  it("reopens at once on reopen(), without waiting for the retry", () => {
    const { events } = stream();
    events.subscribe(() => {});
    FakeEventSource.last?.refuse();
    events.reopen();
    expect(FakeEventSource.all).toHaveLength(2);
    expect(events.state()).toEqual({ status: "reconnecting" });
    vi.advanceTimersByTime(10_000);
    expect(FakeEventSource.all).toHaveLength(2);
  });

  it("ends with the session on session-ended, and does not reconnect by itself", () => {
    const { events, ended } = stream();
    events.subscribe(() => {});
    FakeEventSource.last?.open();
    const source = FakeEventSource.last;

    source?.fire("session-ended", JSON.stringify({ reason: "token-rotated" }));

    expect(source?.closed).toBe(true);
    expect(events.state()).toEqual({ status: "ended", reason: "token-rotated" });
    expect(ended).toEqual(["token-rotated"]);
    vi.advanceTimersByTime(120_000);
    expect(FakeEventSource.all).toHaveLength(1);
  });

  it("opens a fresh connection after signing in again, and the stores catch up", () => {
    const { events, reconnects } = stream();
    events.subscribe(() => {});
    FakeEventSource.last?.open();
    FakeEventSource.last?.fire("session-ended", JSON.stringify({ reason: "expired" }));

    events.reopen();
    FakeEventSource.last?.open();

    expect(FakeEventSource.all).toHaveLength(2);
    expect(events.state()).toEqual({ status: "live" });
    expect(reconnects()).toBe(1);
  });

  it("is shut by end() for a session lost elsewhere, and stays shut", () => {
    const { events } = stream();
    events.subscribe(() => {});
    FakeEventSource.last?.refuse();
    events.end("unauthorized");
    expect(events.state()).toEqual({ status: "ended", reason: "unauthorized" });
    vi.advanceTimersByTime(120_000);
    expect(FakeEventSource.all).toHaveLength(1);
  });

  it("ignores what an old connection says after a new one opened", () => {
    const { events } = stream();
    const seen: string[] = [];
    events.subscribe((event) => seen.push(event.type));
    const old = FakeEventSource.last;
    events.reopen();
    FakeEventSource.last?.open();

    old?.refuse();
    old?.fire("crawl-status-changed", "{}");

    expect(events.state()).toEqual({ status: "live" });
    expect(seen).toEqual([]);
  });

  it("starts afresh once everyone stopped listening: the next first connection is no reconnect", () => {
    const { events, reconnects } = stream();
    const stop = events.subscribe(() => {});
    FakeEventSource.last?.open();
    FakeEventSource.last?.refuse();
    stop();
    expect(events.state()).toEqual({ status: "closed" });
    vi.advanceTimersByTime(120_000);
    expect(FakeEventSource.all).toHaveLength(1);

    events.subscribe(() => {});
    FakeEventSource.last?.open();
    expect(reconnects()).toBe(0);
  });

  it("does nothing on reopen() or end() while nobody listens", () => {
    const { events } = stream();
    events.reopen();
    events.end("expired");
    expect(FakeEventSource.all).toHaveLength(0);
    expect(events.state()).toEqual({ status: "closed" });
  });
});

describe("a connection that fell behind", () => {
  it("hands an analysis status snapshot to every subscriber", () => {
    const { events } = stream();
    const seen: unknown[] = [];
    events.subscribe((event) => seen.push(event));
    FakeEventSource.last?.open();

    FakeEventSource.last?.fire("analysis-status-changed", '{"key":"present"}');

    expect(seen).toEqual([{ type: "analysis-status-changed", data: { key: "present" } }]);
  });

  it("catches up on events-missed like a reconnect, and stays live on the same connection", () => {
    const { events, reconnects, states } = stream();
    const seen: string[] = [];
    events.subscribe((event) => seen.push(event.type));
    FakeEventSource.last?.open();

    FakeEventSource.last?.fire("events-missed", '{"missed":3}');

    expect(reconnects()).toBe(1);
    expect(events.state()).toEqual({ status: "live" });
    expect(states).toEqual(["connecting", "live"]);
    expect(FakeEventSource.all).toHaveLength(1);
    expect(seen).toEqual([]);
  });

  it("ignores events-missed from an old connection", () => {
    const { events, reconnects } = stream();
    events.subscribe(() => {});
    const old = FakeEventSource.last;
    old?.open();
    events.reopen();
    FakeEventSource.last?.open();
    const before = reconnects();

    old?.fire("events-missed", '{"missed":3}');

    expect(reconnects()).toBe(before);
  });
});
