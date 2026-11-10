import { Button } from "../ui/Button.js";
import { Logo } from "../ui/Logo.js";

export function Unreachable({ checking, onRetry }: { checking: boolean; onRetry: () => void }) {
  return (
    <main className="login">
      <div className="login-card">
        <Logo />
        <h1>Can't reach wg-hunt</h1>
        <p role="status">
          {checking
            ? "Trying again…"
            : "It may be restarting, after an update for example. The dashboard tries again by itself."}
        </p>
        <Button
          variant="primary"
          size="lg"
          className="login-submit"
          disabled={checking}
          onClick={onRetry}
        >
          Try again
        </Button>
      </div>
    </main>
  );
}
