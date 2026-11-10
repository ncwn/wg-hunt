import { type FormEvent, useEffect, useId, useState } from "react";
import { UNREACHABLE } from "../api/result.js";
import type { SignInResult } from "../session.js";
import { Button } from "../ui/Button.js";
import { TextField } from "../ui/controls.js";
import { Logo } from "../ui/Logo.js";
import { Notice } from "../ui/status.js";

const MESSAGES = {
  empty: "Enter the access token.",
  "invalid-token": "That access token isn't right.",
  unreachable: UNREACHABLE,
} as const;

function messageFor(result: Exclude<SignInResult, { ok: true }>): string {
  return result.reason === "refused"
    ? `wg-hunt refused the sign-in: ${result.detail}`
    : MESSAGES[result.reason];
}

export function Login({
  onSignIn,
  ended,
}: {
  onSignIn: (token: string) => Promise<SignInResult>;
  ended?: string;
}) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const fieldId = useId();
  const errorId = useId();
  const titleId = useId();
  // The pages behind are inert, so focus would otherwise be nowhere.
  const dialog = ended !== undefined;
  useEffect(() => {
    if (dialog) document.getElementById(fieldId)?.focus();
  }, [dialog, fieldId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (token.trim() === "") return setError(MESSAGES.empty);
    setBusy(true);
    setError(undefined);
    const result = await onSignIn(token.trim());
    if (!result.ok) {
      setError(messageFor(result));
      setBusy(false);
    }
  }

  const form = (
    <form className="login-card" onSubmit={submit} noValidate>
      <Logo />
      <h1 id={titleId}>{ended === undefined ? "Sign in" : "Sign in again"}</h1>
      {ended !== undefined && (
        <Notice tone="warn">
          {ended} Anything you haven't saved is still here: sign in to carry on where you were.
        </Notice>
      )}
      <TextField
        id={fieldId}
        label="Access token"
        hint="wg-hunt keeps it in the access-token file of its data folder."
        type="password"
        name="token"
        value={token}
        onChange={(event) => setToken(event.target.value)}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${fieldId}-hint ${errorId}` : `${fieldId}-hint`}
      />
      {error && (
        <div id={errorId}>
          <Notice tone="warn" role="alert" title={error} />
        </div>
      )}
      <Button type="submit" variant="primary" size="lg" className="login-submit" disabled={busy}>
        Sign in
      </Button>
    </form>
  );

  if (ended === undefined) return <main className="login">{form}</main>;
  return (
    <div className="login login-layer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      {form}
    </div>
  );
}
