// @vitest-environment jsdom
import { act, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createEventSourceStream } from "../src/events.js";
import { offer, serverWithOffers } from "./overview-harness.js";
import { renderDashboard } from "./render.js";

class FakeEventSource {
  static last: FakeEventSource | undefined;
  readyState = 0;
  private listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, listener: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.readyState = 2;
  }
  fire(type: string, data = "") {
    for (const l of this.listeners.get(type) ?? []) l(new MessageEvent(type, { data }));
  }
}

describe("a dashboard whose event stream fell behind", () => {
  it("reads its Offer list and the analysis status again on events-missed", async () => {
    const server = serverWithOffers([offer({ id: 1, title: "Room" })]);
    const reads: string[] = [];
    const fetch = (request: Request) => {
      if (request.method === "GET") reads.push(new URL(request.url).pathname);
      return server.fetch(request);
    };
    const events = createEventSourceStream({
      EventSource: FakeEventSource as unknown as typeof EventSource,
    });
    renderDashboard(fetch, "/offers/all", events);
    const count = (path: string) => reads.filter((p) => p === path).length;
    await waitFor(() => expect(count("/api/v1/offers")).toBeGreaterThan(0));
    await waitFor(() => expect(count("/api/v1/analysis")).toBeGreaterThan(0));
    act(() => {
      if (FakeEventSource.last) FakeEventSource.last.readyState = 1;
      FakeEventSource.last?.fire("open");
    });
    const offers = count("/api/v1/offers");
    const analysis = count("/api/v1/analysis");

    act(() => FakeEventSource.last?.fire("events-missed", '{"missed":201}'));

    await waitFor(() => expect(count("/api/v1/offers")).toBe(offers + 1));
    await waitFor(() => expect(count("/api/v1/analysis")).toBe(analysis + 1));
  });
});
