import { type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button.js";
import { Notice } from "./status.js";
import { useSuspended } from "./suspended.js";

export function Confirm({
  question,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  danger = false,
  busy = false,
  problem,
}: {
  question: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
  busy?: boolean;
  problem?: ReactNode;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const latest = useRef({ onCancel, busy });
  latest.current = { onCancel, busy };

  const suspended = useSuspended();

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => {
      // Whoever closed it may already have moved focus on purpose; otherwise it goes back.
      const active = document.activeElement;
      if (opener?.isConnected && (active === null || active === document.body)) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  // On its answer when it opens, and again when it comes back from behind the sign-in.
  useEffect(() => {
    if (!suspended) confirm.current?.focus();
  }, [suspended]);

  useEffect(() => {
    if (suspended) return;
    // Captured on window, so Esc answers this question and not a panel behind it.
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!latest.current.busy) latest.current.onCancel();
        return;
      }
      if (event.key !== "Tab" || !box.current) return;
      const buttons = Array.from(
        box.current.querySelectorAll<HTMLElement>("button:not(:disabled)"),
      );
      const first = buttons[0];
      const last = buttons.at(-1);
      if (!first || !last) return event.preventDefault();
      const active = document.activeElement;
      const inside = box.current.contains(active);
      if (event.shiftKey && (active === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [suspended]);

  return createPortal(
    <div className="wh-confirm-layer" hidden={suspended} inert={suspended}>
      {/* A pointer shortcut for Cancel; Esc does the same from the keyboard. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: see above */}
      <div className="wh-confirm-scrim" onClick={() => !busy && onCancel()} />
      <div
        ref={box}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-q`}
        aria-describedby={children ? `${id}-d` : undefined}
        className="wh-confirm"
      >
        <div className="wh-confirm-text">
          <p id={`${id}-q`} className="wh-confirm-q">
            {question}
          </p>
          {children && (
            <p id={`${id}-d`} className="wh-confirm-d">
              {children}
            </p>
          )}
        </div>
        {problem && <Notice tone="alarm">{problem}</Notice>}
        <div className="wh-confirm-actions">
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            ref={confirm}
            variant={danger ? "danger" : "primary"}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
