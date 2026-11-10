import { useCallback, useEffect, useRef, useState } from "react";
import { type Result, UNREACHABLE } from "./api/result.js";

export type Mutation =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "done"; message: string }
  | { status: "failed"; message: string };

const IDLE: Mutation = { status: "idle" };

/**
 * A write on its way stays pending across a `context` change, since the change is often the write
 * taking effect and going idle would let the seeker send it twice. After `reset` or unmount `run`
 * resolves `undefined`, but the write still happened: apply what a save answers inside `act`.
 */
export function useMutation(context?: unknown) {
  const [state, setState] = useState<Mutation>(IDLE);
  const generation = useRef(0);
  const [seen, setSeen] = useState(context);
  const contexts = useRef(0);

  if (!Object.is(seen, context)) {
    // Reset during render, so the stale message is never painted for the new context.
    setSeen(context);
    contexts.current += 1;
    if (state.status !== "pending") {
      setState(IDLE);
      generation.current += 1;
    }
  }

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const reset = useCallback(() => {
    generation.current += 1;
    setState(IDLE);
  }, []);

  const run = useCallback(
    async <T>(
      act: () => Promise<Result<T>>,
      done?: (data: T) => string | undefined,
    ): Promise<Result<T> | undefined> => {
      const mine = ++generation.current;
      const about = contexts.current;
      setState({ status: "pending" });
      let result: Result<T>;
      try {
        result = await act();
      } catch {
        result = { ok: false, message: UNREACHABLE };
      }
      if (mine !== generation.current) return undefined;
      if (!result.ok) {
        setState({ status: "failed", message: result.message });
      } else {
        const message = about === contexts.current ? done?.(result.data) : undefined;
        setState(message ? { status: "done", message } : IDLE);
      }
      return result;
    },
    [],
  );

  return { state, busy: state.status === "pending", run, reset };
}
