import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiClient, type SessionWatch, watchSession } from "./api/client.js";
import { ask } from "./api/result.js";
import type { EventStream, SessionLoss } from "./events.js";

/** `lost`: the session ended under a signed-in page. */
export type Session =
  | { status: "checking" }
  | { status: "unreachable"; checking: boolean }
  | { status: "signedOut"; lost?: SessionLoss }
  | { status: "signedIn" };

export type SignInResult =
  | { ok: true }
  | { ok: false; reason: "invalid-token" | "unreachable" }
  | { ok: false; reason: "refused"; detail: string };

export type SessionTiming = {
  checkTimeoutMs?: number;
  retryMs?: number;
};

const CHECK_TIMEOUT_MS = 10_000;
const RETRY_MS = 5_000;

type Answer = "signedIn" | "signedOut" | "unreachable";

async function checkSession(api: ApiClient, timeoutMs: number): Promise<Answer> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Answer>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("unreachable");
    }, timeoutMs);
  });
  const answer = api
    .GET("/auth/session", { signal: controller.signal })
    .then(({ response }): Answer => {
      if (response.ok) return "signedIn";
      return response.status === 401 ? "signedOut" : "unreachable";
    })
    .catch((): Answer => "unreachable");
  try {
    return await Promise.race([answer, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The cookie is HttpOnly, so only the server can say. */
export function useSession(api: ApiClient, events?: EventStream, timing: SessionTiming = {}) {
  const checkTimeoutMs = timing.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
  const retryMs = timing.retryMs ?? RETRY_MS;
  const [session, setSession] = useState<Session>({ status: "checking" });
  const [attempt, setAttempt] = useState(0);
  const watch = useRef<SessionWatch>(undefined);
  // Signing out ends this tab's stream too; that is the seeker's doing, not a lost session.
  const leaving = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` asks again on Try again
  useEffect(() => {
    let cancelled = false;
    void checkSession(api, checkTimeoutMs).then((answer) => {
      if (cancelled) return;
      // Only the boot check decides; a sign-in that landed meanwhile stands.
      setSession((now) =>
        now.status !== "checking" && now.status !== "unreachable"
          ? now
          : answer === "unreachable"
            ? { status: "unreachable", checking: false }
            : { status: answer },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [api, checkTimeoutMs, attempt]);

  const retry = useCallback(() => {
    setSession((now) => (now.status === "unreachable" ? { ...now, checking: true } : now));
    setAttempt((n) => n + 1);
  }, []);

  // A server restarting (the daily update) comes back by itself; so does the dashboard.
  const waiting = session.status === "unreachable" && !session.checking;
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(retry, retryMs);
    return () => clearTimeout(timer);
  }, [waiting, retry, retryMs]);

  const lose = useCallback((lost: SessionLoss) => {
    if (leaving.current) return;
    setSession((now) => {
      if (now.status === "signedIn") return { status: "signedOut", lost };
      // The server's own reason says more than the 401 that may have come first.
      if (now.status === "signedOut" && now.lost === "unauthorized" && lost !== "unauthorized") {
        return { status: "signedOut", lost };
      }
      return now;
    });
  }, []);

  useEffect(() => {
    const watching = watchSession(api, () => lose("unauthorized"));
    watch.current = watching;
    return watching.stop;
  }, [api, lose]);

  const lost = session.status === "signedOut" ? session.lost : undefined;
  useEffect(() => {
    if (lost !== undefined) events?.end(lost);
  }, [events, lost]);

  useEffect(() => {
    if (!events) return;
    const stopEnded = events.onSessionEnded((reason) => {
      if (reason !== "token-rotated") return lose(reason);
      // Every session ended, but a rotation sent from this tab renewed its cookie with its answer.
      void (async () => {
        await watch.current?.rotationsSettled();
        const answer = await checkSession(api, checkTimeoutMs);
        if (answer === "signedOut") lose("token-rotated");
        // Kept, or unknown: a fresh stream says which (a failed one is checked again below).
        else events.reopen();
      })();
    });
    const stopState = events.onState((state) => {
      // The browser gave up on the stream. A 401 to this check ends the session through the
      // watch; anything else leaves the stream to its retry.
      if (state.status === "failed") void checkSession(api, checkTimeoutMs);
    });
    return () => {
      stopEnded();
      stopState();
    };
  }, [api, events, lose, checkTimeoutMs]);

  const signIn = useCallback(
    async (token: string): Promise<SignInResult> => {
      const result = await ask(() => api.POST("/auth/session", { body: { token } }), {
        empty: true,
      });
      if (result.ok) {
        leaving.current = false;
        setSession({ status: "signedIn" });
        // Pages kept behind the sign-in get their stream back, and read again when it opens.
        events?.reopen();
        return { ok: true };
      }
      if (result.type === "invalid-token") return { ok: false, reason: "invalid-token" };
      if (result.status === undefined) return { ok: false, reason: "unreachable" };
      return { ok: false, reason: "refused", detail: result.message };
    },
    [api, events],
  );

  const signOut = useCallback(async () => {
    leaving.current = true;
    try {
      await api.DELETE("/auth/session");
    } finally {
      setSession({ status: "signedOut" });
    }
  }, [api]);

  return { session, status: session.status, signIn, signOut, retry };
}
