import { type ReactNode, type Ref, useEffect, useRef, useState } from "react";

/** How long a side panel takes to slide out; its content stays in the page that long, then goes. */
const SIDE_PANEL_OUT_MS = 220;

/** `value` may be a new object on every render; only whether there is one matters. */
export function useLeaving<T>(value: T | undefined): { shown: T | undefined; closing: boolean } {
  const last = useRef(value);
  if (value !== undefined) last.current = value;
  const open = value !== undefined;
  const [, setLingering] = useState(false);
  useEffect(() => {
    if (open || last.current === undefined) return;
    setLingering(true);
    const timer = setTimeout(() => {
      last.current = undefined;
      setLingering(false);
    }, SIDE_PANEL_OUT_MS);
    return () => clearTimeout(timer);
  }, [open]);
  const shown = value ?? last.current;
  return { shown, closing: !open && shown !== undefined };
}

export function SidePanel({
  label,
  closing = false,
  className,
  ref,
  tabIndex,
  children,
}: {
  label: string;
  closing?: boolean;
  className?: string;
  ref?: Ref<HTMLElement>;
  tabIndex?: number;
  children: ReactNode;
}) {
  useEffect(() => {
    if (closing) return;
    const root = document.documentElement;
    root.classList.add("has-side-panel");
    return () => root.classList.remove("has-side-panel");
  }, [closing]);

  const classes = ["wh-side-panel", className, closing && "is-closing"].filter(Boolean).join(" ");
  return (
    <aside
      ref={ref}
      className={classes}
      aria-label={label}
      aria-hidden={closing || undefined}
      inert={closing || undefined}
      tabIndex={tabIndex}
    >
      {children}
    </aside>
  );
}
