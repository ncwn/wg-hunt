import type { ReactNode } from "react";
import { Button } from "./Button.js";
import type { IconName } from "./Icon.js";
import { type HuntState, StatusPill } from "./status.js";

const TITLE: Record<HuntState, string> = {
  running: "Hunting is on",
  paused: "Hunting is paused",
  resting: "Resting for the night",
  cooldown: "Taking a short break",
  "needs-you": "wg-hunt needs you",
};

export function StatusCard({
  state,
  action,
  onAction,
  busy = false,
  children,
}: {
  state: HuntState;
  action: string | false;
  onAction?: () => void;
  busy?: boolean;
  children?: ReactNode;
}) {
  const icon: IconName = action === "Pause" ? "pause" : "play";
  return (
    <section className={`wh-statuscard wh-statuscard-${state}`} aria-label="Hunting status">
      <svg className="wh-statuscard-art" viewBox="0 0 160 120" aria-hidden="true">
        <rect x={40} y={20} width={120} height={84} rx={20} />
        <rect x={56} y={36} width={120} height={84} rx={20} />
        <rect x={72} y={52} width={120} height={84} rx={20} />
      </svg>
      <StatusPill state={state} onDark />
      <h2 className="wh-statuscard-title">{TITLE[state]}</h2>
      {children && <div className="wh-statuscard-text">{children}</div>}
      {action && (
        <Button variant="bright" icon={icon} onClick={onAction} disabled={busy}>
          {action}
        </Button>
      )}
    </section>
  );
}
