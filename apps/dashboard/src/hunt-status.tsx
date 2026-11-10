import { createContext, type ReactNode, useContext } from "react";
import type { ApiClient } from "./api/client.js";
import type { Result } from "./api/result.js";
import { type CrawlStatusView, formatBerlin, useCrawlStatus } from "./crawl-status.js";
import type { CrawlStatus, EventStream } from "./events.js";
import type { HuntState } from "./ui/status.js";

/**
 * The crawl's own vocabulary (Cooldown, Bot check, request counts) stays in Settings › Advanced.
 */
export type Hunt = {
  state: HuntState;
  detail?: string;
  sentence: string;
  stopped?: { why: string; next: string };
  /** Nothing waits for the seeker, now or after a break. */
  on: boolean;
  /** A break can't be cut short. */
  canResume: boolean;
  canPause: boolean;
};

/** So an empty list never promises a check that isn't coming. */
export function emptyNext(empty: string, hunt: Hunt | null | undefined): string {
  return hunt ? `${empty} ${hunt.sentence}` : empty;
}

const ASKED = "wg-gesucht asked whether you're a person";
const ASKED_TWICE = "wg-gesucht asked twice today whether you're a person";

/** Every word comes from the server's status, so the card, the pill, the alarm and Settings agree. */
function describeHunt(crawl: CrawlStatus, now: Date = new Date()): Hunt {
  const nextAt = crawl.nextRequest.at ? formatBerlin(crawl.nextRequest.at, now) : undefined;
  const holds = crawl.holds;
  const common = {
    on: holds.length === 0,
    canResume: crawl.actions.resume,
    canPause: crawl.actions.pause,
  };
  switch (crawl.state) {
    case "running":
      return {
        ...common,
        state: "running",
        detail: nextAt ? `Next check at ${nextAt}` : undefined,
        sentence: nextAt ? `Next check at ${nextAt}.` : "wg-hunt is looking for new rooms.",
      };
    case "outside-hours":
      return {
        ...common,
        state: "resting",
        detail: nextAt ? `Resting until ${nextAt}` : undefined,
        sentence: nextAt
          ? `Resting until ${nextAt}, outside the hours you set.`
          : "Resting outside the hours you set.",
      };
    case "paused":
      return {
        ...common,
        state: "paused",
        sentence: holds.includes("needs-resume")
          ? `Hunting is paused until you resume it. ${ASKED_TWICE}, so resume when you're ready.`
          : "Hunting is paused until you resume it.",
      };
    case "cooling-down":
      return { ...common, state: "cooldown", ...breakWords(crawl, now) };
    case "needs-resume":
      return stoppedHunt(
        common,
        `${ASKED_TWICE}, so wg-hunt stopped to be safe.`,
        "Resume when you're ready.",
      );
    case "layout-changed":
      // One stop for two things: a page wg-hunt could not read, or a failure while handling one,
      // which the disk, the database or the page itself can cause.
      return crawl.paused?.cause === "handler-error"
        ? stoppedHunt(
            common,
            "wg-hunt failed while handling a page, so it stopped to be safe.",
            "Resume to try again. If it stops again, the cause can be the disk, the database, or a page wg-hunt can't handle: the server's log has the error, and the request log under Settings › Advanced names the page.",
          )
        : stoppedHunt(
            common,
            "wg-gesucht showed a page wg-hunt didn't expect, so wg-hunt stopped to be safe.",
            "Resume once wg-hunt is up to date.",
          );
    case "disk-full":
      return stoppedHunt(
        common,
        "The computer running wg-hunt is almost out of space, so wg-hunt stopped.",
        "Free some space, then resume.",
      );
    case "wiped":
      // The seeker's own doing, not an alarm. While the deletion runs the server refuses Resume.
      return {
        ...common,
        state: "paused",
        detail: crawl.actions.resume ? undefined : "Deleting all offer data",
        sentence: crawl.actions.resume
          ? "Hunting is paused because you deleted all offer data. Resume, and wg-hunt reads every Search from the start."
          : "wg-hunt is deleting all offer data. Hunting stays paused until you resume it afterwards.",
      };
  }
}

function breakWords(crawl: CrawlStatus, now: Date): Pick<Hunt, "detail" | "sentence"> {
  const until = crawl.cooldown ? formatBerlin(crawl.cooldown.until, now) : undefined;
  const twice = crawl.holds.includes("needs-resume");
  const asked = twice ? ASKED_TWICE : ASKED;
  const taking = twice ? "taking a break" : "taking a short break";
  const sentence = until
    ? `${asked}, so wg-hunt is ${taking} until ${until}.`
    : `${asked}, so wg-hunt is ${taking}.`;
  if (crawl.holds.length === 0) {
    return {
      detail: until ? `Back at ${until}` : undefined,
      sentence: until ? `${asked}, so wg-hunt is ${taking}. Back at ${until}.` : sentence,
    };
  }
  const after = crawl.holds.some((hold) => hold === "paused" || hold === "wiped")
    ? "It stays paused after that until you resume it."
    : "After that it waits for you to resume.";
  return {
    detail: until ? `On a break until ${until}` : undefined,
    sentence: `${sentence} ${after}`,
  };
}

function stoppedHunt(
  common: Pick<Hunt, "on" | "canResume" | "canPause">,
  why: string,
  next: string,
): Hunt {
  return { ...common, state: "needs-you", sentence: `${why} ${next}`, stopped: { why, next } };
}

type HuntView = {
  view: CrawlStatusView;
  hunt: Hunt | null;
  pause: () => Promise<Result<undefined>>;
  resume: () => Promise<Result<undefined>>;
};

const HuntContext = createContext<HuntView>({
  view: { status: "loading" },
  hunt: null,
  pause: async () => ({ ok: true, data: undefined }),
  resume: async () => ({ ok: true, data: undefined }),
});

export function HuntStatusProvider({
  api,
  events,
  children,
}: {
  api: ApiClient;
  events: EventStream;
  children: ReactNode;
}) {
  const { view, pause, resume } = useCrawlStatus(api, events);
  const hunt = view.status === "ready" ? describeHunt(view.crawl) : null;
  return (
    <HuntContext.Provider value={{ view, hunt, pause, resume }}>{children}</HuntContext.Provider>
  );
}

export const useHunt = () => useContext(HuntContext);
