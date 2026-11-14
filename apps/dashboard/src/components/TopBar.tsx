import { createContext, type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";
import { useHunt } from "../hunt-status.js";
import { StatusPill } from "../ui/status.js";

/**
 * `null` while the Shell is mounting; no provider at all (a test rendering one page) means inline.
 */
export const TopBarSlot = createContext<HTMLElement | null | undefined>(undefined);

export function TopBar({
  title,
  subtitle,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
}) {
  const slot = useContext(TopBarSlot);
  const { hunt } = useHunt();
  const header = (
    <header className="wh-topbar">
      <div className="wh-topbar-text">
        <h1 className="wh-topbar-title">{title}</h1>
        {subtitle && <p className="wh-topbar-sub">{subtitle}</p>}
      </div>
      {hunt && (
        <div className="wh-topbar-status">
          <StatusPill state={hunt.state}>{hunt.detail}</StatusPill>
        </div>
      )}
      {children && <div className="wh-topbar-tools">{children}</div>}
    </header>
  );
  if (slot === undefined) return header;
  return slot ? createPortal(header, slot) : null;
}
