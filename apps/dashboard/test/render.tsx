import { act, cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  type Location,
  MemoryRouter,
  type NavigateFunction,
  useLocation,
  useNavigate,
} from "react-router";
import { afterEach } from "vitest";
import { App } from "../src/App.js";
import { createApiClient } from "../src/api/client.js";
import type { EventStream, ServerEvent, SessionEndReason, StreamState } from "../src/events.js";
import type { SessionTiming } from "../src/session.js";
import type { realServer } from "./real-server.js";

afterEach(cleanup);

export function fakeEventStream() {
  const listeners = new Set<(event: ServerEvent) => void>();
  const reconnectListeners = new Set<() => void>();
  const stateListeners = new Set<(state: StreamState) => void>();
  const endedListeners = new Set<(reason: SessionEndReason) => void>();
  let current: StreamState = { status: "live" };
  let reopened = 0;
  const become = (next: StreamState) => {
    current = next;
    for (const listener of [...stateListeners]) listener(next);
  };
  const stream: EventStream = {
    onReconnect(listener) {
      reconnectListeners.add(listener);
      return () => reconnectListeners.delete(listener);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    state: () => current,
    onState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    onSessionEnded(listener) {
      endedListeners.add(listener);
      return () => endedListeners.delete(listener);
    },
    reopen() {
      reopened += 1;
      become({ status: "live" });
      for (const listener of [...reconnectListeners]) listener();
    },
    end(reason) {
      if (current.status !== "ended") become({ status: "ended", reason });
    },
  };
  return {
    stream,
    listening: () => listeners.size,
    reopened: () => reopened,
    state: () => current,
    reconnect: () =>
      act(() => {
        for (const listener of reconnectListeners) listener();
      }),
    emit: (event: ServerEvent) =>
      act(() => {
        for (const listener of listeners) listener(event);
      }),
    become: (state: StreamState) => act(() => become(state)),
    endSession: (reason: SessionEndReason) =>
      act(() => {
        become({ status: "ended", reason });
        for (const listener of [...endedListeners]) listener(reason);
      }),
  };
}

export function liveFrom(server: ReturnType<typeof realServer>) {
  const live = fakeEventStream();
  server.runtime.events.subscribe((event) => {
    void live.emit(JSON.parse(JSON.stringify(event)));
  });
  return live;
}

type Router = { location?: Location; navigate?: NavigateFunction };

function RouterProbe({ into }: { into: Router }) {
  into.location = useLocation();
  into.navigate = useNavigate();
  return null;
}

export function renderDashboard(
  fetch: (request: Request) => Promise<Response>,
  route = "/",
  events: EventStream = fakeEventStream().stream,
  timing?: SessionTiming,
) {
  const api = createApiClient({ fetch, baseUrl: "http://localhost/api/v1" });
  const user = userEvent.setup();
  const router: Router = {};
  const { unmount } = render(
    <MemoryRouter initialEntries={[route]}>
      <App api={api} events={events} timing={timing} />
      <RouterProbe into={router} />
    </MemoryRouter>,
  );
  const location = () => router.location as Location;
  const back = () => act(async () => void (await router.navigate?.(-1)));
  return { user, unmount, location, back };
}
