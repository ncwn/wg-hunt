import { type ReactNode, useId } from "react";
import { Button } from "../ui/Button.js";
import { Notice } from "../ui/status.js";

export function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="adv-section" aria-labelledby={id}>
      <h3 id={id} className="adv-title">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function Actions({ children }: { children: ReactNode }) {
  return <div className="adv-actions">{children}</div>;
}

export function Note({ children, role }: { children: ReactNode; role?: "status" }) {
  return (
    <p className="adv-note" role={role}>
      {children}
    </p>
  );
}

export function Problem({ message, onRetry }: { message: ReactNode; onRetry: () => void }) {
  return (
    <div className="adv-problem">
      <Notice tone="alarm">{message}</Notice>
      <Actions>
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      </Actions>
    </div>
  );
}
