import { useCallback, useEffect, useState } from "react";
import { type Result, UNREACHABLE } from "../api/result.js";

export type Loaded<T> =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; data: T };

/** `load` must not change between renders. */
export function useLoaded<T>(load: () => Promise<Result<T>>) {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` restarts the load on Retry; `load` is stable by contract
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    load()
      .then((result) => {
        if (cancelled) return;
        setState(
          result.ok
            ? { status: "ready", data: result.data }
            : { status: "failed", message: result.message },
        );
      })
      .catch(() => {
        if (!cancelled) setState({ status: "failed", message: UNREACHABLE });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}
