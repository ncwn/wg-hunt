import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/** The phone breakpoint, where a popover becomes a bottom sheet; matches the CSS. */
const PHONE = "(max-width: 640px)";

export function useDismiss(
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  close: () => void,
) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const onPress = (event: PointerEvent) => {
      if (anchor.current && !anchor.current.contains(event.target as Node)) latest.current();
    };
    document.addEventListener("pointerdown", onPress);
    return () => document.removeEventListener("pointerdown", onPress);
  }, [open, anchor]);
}

/** The sheet's `title` only shows on a phone, where the field is hidden under the scrim. */
export function Popover({
  open,
  anchor,
  onClose,
  title,
  className,
  children,
}: {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  title?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<"below" | "above">("below");
  const [align, setAlign] = useState<"start" | "end">("start");

  useLayoutEffect(() => {
    if (!open || !anchor.current || !box.current) return;
    if (typeof window.matchMedia === "function" && window.matchMedia(PHONE).matches) return;
    const at = anchor.current.getBoundingClientRect();
    const own = box.current.getBoundingClientRect();
    const below = window.innerHeight - at.bottom;
    setSide(below < own.height + 8 && at.top > below ? "above" : "below");
    setAlign(at.left + own.width > window.innerWidth - 8 ? "end" : "start");
  }, [open, anchor]);

  if (!open) return null;
  const classes = ["wh-pop", `wh-pop-${side}`, `wh-pop-${align}`, className]
    .filter(Boolean)
    .join(" ");
  return (
    <>
      <div className="wh-pop-scrim" aria-hidden="true" onClick={onClose} />
      <div ref={box} className={classes}>
        {title && (
          <p className="wh-pop-title" aria-hidden="true">
            {title}
          </p>
        )}
        {children}
      </div>
    </>
  );
}
