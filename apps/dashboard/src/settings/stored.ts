import { useCallback, useState } from "react";
import type { Result } from "../api/result.js";
import { useLoaded } from "./request.js";

export function useStored<T>(load: () => Promise<Result<T>>) {
  const { state, retry } = useLoaded(load);
  const [saved, setSaved] = useState<{ from: typeof state; value: T } | null>(null);
  const replace = useCallback((value: T) => setSaved({ from: state, value }), [state]);
  const value =
    state.status === "ready"
      ? saved && saved.from === state
        ? saved.value
        : state.data
      : undefined;
  return { state, value, replace, retry };
}
