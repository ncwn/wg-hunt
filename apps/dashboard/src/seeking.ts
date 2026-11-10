import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "./api/client.js";
import { ask, type Result } from "./api/result.js";
import type { components } from "./api/schema.js";
import type { EventStream } from "./events.js";
import { readDoc } from "./revision.js";
import { type Problem, problemOf } from "./searches.js";

export type SeekerProfile = components["schemas"]["SeekerProfile"];
export type Filters = components["schemas"]["Filters"];
export type Place = SeekerProfile["places"][number];
export type RankingPreview = components["schemas"]["RankingPreview"];
export type ExamplePreset = components["schemas"]["ExamplePreset"];
export type Strength = Filters["anmeldung"]["strength"];
export type Margin = NonNullable<Filters["maxRent"]["margin"]>;

export type Seeking = { profile: SeekerProfile; filters: Filters };

/** Both sides are copies of server JSON that edits rebuild with spreads, so key order is stable. */
export const sameSeeking = (a: Seeking, b: Seeking) => JSON.stringify(a) === JSON.stringify(b);

export type Saved = {
  seeking: Seeking;
  revisions: { profile: string | undefined; filters: string | undefined };
};

export async function loadSeeking(api: ApiClient): Promise<Result<Saved>> {
  const [profile, filters] = await Promise.all([
    readDoc(() => api.GET("/profile")),
    readDoc(() => api.GET("/filters")),
  ]);
  if (!profile.ok) return profile;
  if (!filters.ok) return filters;
  return {
    ok: true,
    data: {
      seeking: { profile: profile.data.data, filters: filters.data.data },
      revisions: { profile: profile.data.revision, filters: filters.data.revision },
    },
  };
}

export const loadExample = (api: ApiClient) => ask(() => api.GET("/presets/example"));

export type SaveResult =
  | { status: "saved"; saved: Saved }
  | { status: "stale" }
  | { status: "failed"; problem: Problem };

export async function saveSeeking(
  api: ApiClient,
  draft: Seeking,
  base: Saved,
): Promise<SaveResult> {
  const result = await ask(() =>
    api.PUT("/seeking", { body: { ...draft, revisions: base.revisions } }),
  );
  if (!result.ok) {
    return result.status === 412
      ? { status: "stale" }
      : { status: "failed", problem: problemOf(result) };
  }
  const { revisions, ...seeking } = result.data;
  return { status: "saved", saved: { seeking, revisions } };
}

export type PreviewState =
  | { status: "idle" }
  | { status: "loading"; last?: RankingPreview }
  | { status: "ready"; preview: RankingPreview }
  | { status: "invalid"; problem: Problem }
  | { status: "failed"; message: string };

const REST_MS = 200;

/**
 * A reconnect (after signing in again, say) previews the draft again, so a refusal from while the
 * session was gone doesn't stay.
 */
export function useBandPreview(
  api: ApiClient,
  draft: Seeking | null,
  events?: EventStream,
): { state: PreviewState; retry: () => void } {
  const [state, setState] = useState<PreviewState>({ status: "idle" });
  const latest = useRef(0);
  const key = JSON.stringify(draft);
  const [round, setRound] = useState(0);
  useEffect(() => events?.onReconnect(() => setRound((n) => n + 1)), [events]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `draft`, `round` asks again
  useEffect(() => {
    const turn = ++latest.current;
    if (draft === null) {
      setState({ status: "idle" });
      return;
    }
    setState((current) => {
      const last =
        current.status === "ready"
          ? current.preview
          : current.status === "loading"
            ? current.last
            : undefined;
      return last ? { status: "loading", last } : { status: "loading" };
    });
    const timer = setTimeout(() => {
      ask(() => api.POST("/ranking/preview", { body: draft })).then((result) => {
        if (latest.current !== turn) return;
        setState(
          result.ok
            ? { status: "ready", preview: result.data }
            : result.status === 400
              ? { status: "invalid", problem: problemOf(result) }
              : { status: "failed", message: result.message },
        );
      });
    }, REST_MS);
    return () => clearTimeout(timer);
  }, [api, key, round]);

  const retry = useCallback(() => setRound((n) => n + 1), []);
  return { state, retry };
}
