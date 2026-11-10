import { type ReactNode, useId, useState } from "react";
import { Icon } from "./Icon.js";

export type Band = "match" | "near" | "warned" | "hidden";

const BAND_WORD: Record<Band, string> = {
  match: "Match",
  near: "Near match",
  warned: "Warned",
  hidden: "Hidden",
};

/** Bands are told apart by the word, never by colour alone. */
export function BandTag({ band, children }: { band: Band; children?: ReactNode }) {
  return <span className={`wh-tag wh-tag-${band}`}>{children ?? BAND_WORD[band]}</span>;
}

export type HuntState = "running" | "paused" | "resting" | "cooldown" | "needs-you";

const HUNT_WORD: Record<HuntState, string> = {
  running: "Hunting",
  paused: "Paused",
  resting: "Resting",
  cooldown: "Taking a break",
  "needs-you": "Needs you",
};

/**
 * The detail waits in a tooltip on hover and focus, and is the pill's description for screen
 * readers.
 */
export function StatusPill({
  state,
  onDark = false,
  children,
}: {
  state: HuntState;
  onDark?: boolean;
  children?: ReactNode;
}) {
  const id = useId();
  const detail = children !== undefined && children !== null && children !== false;
  const classes = [
    "wh-status",
    `wh-status-${state}`,
    onDark && "wh-status-dark",
    detail && "has-detail",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span
      className={classes}
      tabIndex={detail ? 0 : undefined}
      aria-describedby={detail ? id : undefined}
    >
      <span className="wh-status-dot" aria-hidden="true" />
      <span>{HUNT_WORD[state]}</span>
      {detail && (
        <span id={id} role="tooltip" className="wh-status-tip">
          {children}
        </span>
      )}
    </span>
  );
}

export type NoticeTone = "info" | "warn" | "alarm";

export function Notice({
  tone = "info",
  title,
  children,
  open,
  defaultOpen = false,
  onToggle,
  onDismiss,
  role,
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onToggle?: (open: boolean) => void;
  onDismiss?: () => void;
  role?: "alert" | "status" | null;
}) {
  const [own, setOwn] = useState(defaultOpen);
  const isOpen = open ?? own;
  const textId = useId();
  const foldable = Boolean(title && children);
  const head = <span className="wh-notice-title">{title ?? children}</span>;
  const classes = ["wh-notice", `wh-notice-${tone}`, isOpen && "is-open"].filter(Boolean).join(" ");
  const ariaRole = role === null ? undefined : (role ?? (tone === "alarm" ? "alert" : "status"));
  function flip() {
    setOwn(!isOpen);
    onToggle?.(!isOpen);
  }
  return (
    <div className={classes} role={ariaRole}>
      <div className="wh-notice-row">
        {foldable ? (
          <button
            type="button"
            className="wh-notice-head"
            aria-expanded={isOpen}
            aria-controls={textId}
            onClick={flip}
          >
            {head}
            <Icon name="chevronDown" size={18} className="wh-notice-chev" />
          </button>
        ) : (
          <div className="wh-notice-head">{head}</div>
        )}
        {onDismiss && (
          <button
            type="button"
            className="wh-notice-close"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={onDismiss}
          >
            <Icon name="x" size={16} />
          </button>
        )}
      </div>
      {foldable && (
        <div id={textId} className="wh-notice-text" hidden={!isOpen}>
          {children}
        </div>
      )}
    </div>
  );
}

export function Disclosure({
  title,
  hint,
  open,
  defaultOpen = false,
  quiet = false,
  className,
  children,
}: {
  title: ReactNode;
  hint?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  quiet?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const [own, setOwn] = useState(defaultOpen);
  const isOpen = open ?? own;
  const id = useId();
  const classes = ["wh-disclosure", quiet && "wh-disclosure-quiet", isOpen && "is-open", className]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes}>
      <button
        type="button"
        className="wh-disclosure-head"
        aria-expanded={isOpen}
        aria-controls={id}
        onClick={() => setOwn(!isOpen)}
      >
        <span className="wh-disclosure-title">{title}</span>
        {hint && !isOpen && <span className="wh-disclosure-hint">{hint}</span>}
        <Icon name="chevronDown" size={18} className="wh-disclosure-chev" />
      </button>
      <div id={id} className="wh-disclosure-body" hidden={!isOpen}>
        {children}
      </div>
    </div>
  );
}
