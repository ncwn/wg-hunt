import { useCallback, useSyncExternalStore } from "react";
import { formatBerlin } from "../crawl-status.js";
import type { EventStream, StreamState } from "../events.js";
import { Button } from "../ui/Button.js";
import { Notice } from "../ui/status.js";

const berlinSeconds = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function pausedLine(state: StreamState, now: Date = new Date()): string | undefined {
  switch (state.status) {
    case "reconnecting":
      return "Live updates paused: the connection to wg-hunt dropped. Reconnecting…";
    case "failed": {
      const at = new Date(state.retryAt);
      const when =
        at.getTime() - now.getTime() < 60_000
          ? berlinSeconds.format(at)
          : formatBerlin(at.toISOString(), now);
      return `Live updates paused: wg-hunt didn't answer. Trying again at ${when}.`;
    }
    default:
      // Closed, connecting and live need no word; an ended stream has the sign-in over it.
      return undefined;
  }
}

export function ConnectionNotice({ events }: { events: EventStream }) {
  const subscribe = useCallback((changed: () => void) => events.onState(changed), [events]);
  const state = useSyncExternalStore(subscribe, () => events.state());
  const line = pausedLine(state);
  if (line === undefined) return null;
  return (
    <div className="connection-notice" role="status">
      {/* biome-ignore lint/a11y/useValidAriaRole: null is Notice's prop for "no role", since the wrapper is the status */}
      <Notice tone="warn" role={null} title={line} />
      <Button
        variant="secondary"
        className="connection-notice-retry"
        onClick={() => events.reopen()}
      >
        Retry now
      </Button>
    </div>
  );
}
