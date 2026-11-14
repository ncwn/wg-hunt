import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ApiClient } from "./api/client.js";
import type { components } from "./api/schema.js";
import { type EventStream, settle } from "./events.js";
import { useLastSeen } from "./seen.js";

type OfferCounts = components["schemas"]["OfferCounts"];

type CountsState =
  | { status: "loading" | "failed"; counts: null }
  | { status: "ready"; counts: OfferCounts };

type CountsView = CountsState & { refresh: () => void };

const Counts = createContext<CountsView>({ status: "loading", counts: null, refresh: () => {} });

export function OfferCountsProvider({
  api,
  events,
  children,
}: {
  api: ApiClient;
  events: EventStream;
  children: ReactNode;
}) {
  const lastSeen = useLastSeen();
  const [state, setState] = useState<CountsState>({ status: "loading", counts: null });
  const running = useRef(false);
  const again = useRef(false);
  const stopped = useRef(false);
  // The loop below reads the latest time each round, so a read that began before "Mark all seen"
  // is followed by one that counts from the new time.
  const since = useRef(lastSeen);
  since.current = lastSeen;

  const read = useCallback(async () => {
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    try {
      do {
        again.current = false;
        try {
          const { data } = await api.GET("/offers/counts", {
            params: {
              query: since.current === null ? {} : { since: new Date(since.current).toISOString() },
            },
          });
          if (stopped.current) continue;
          if (data) setState({ status: "ready", counts: data });
          else setState(failed);
        } catch {
          if (!stopped.current) setState(failed);
        }
      } while (again.current && !stopped.current);
    } finally {
      running.current = false;
    }
  }, [api]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: "Mark all seen" is a reason to read
  useEffect(() => {
    void read();
  }, [read, lastSeen]);

  useEffect(() => {
    stopped.current = false;
    const later = settle(() => void read());
    const stop = events.subscribe((event) => {
      if (
        event.type === "offer-added" ||
        event.type === "offer-band-changed" ||
        event.type === "offer-merged"
      ) {
        later.schedule();
      }
    });
    const stopReconnect = events.onReconnect(() => void read());
    return () => {
      stopped.current = true;
      later.cancel();
      stop();
      stopReconnect();
    };
  }, [events, read]);

  const refresh = useCallback(() => {
    setState((now) => (now.status === "failed" ? { status: "loading", counts: null } : now));
    void read();
  }, [read]);
  return <Counts.Provider value={{ ...state, refresh }}>{children}</Counts.Provider>;
}

const failed = (now: CountsState): CountsState =>
  now.status === "ready" ? now : { status: "failed", counts: null };

export const useOfferCounts = () => useContext(Counts);
