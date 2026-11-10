import type { ApiClient } from "./api/client.js";
import { Login } from "./components/Login.js";
import { Shell } from "./components/Shell.js";
import { Unreachable } from "./components/Unreachable.js";
import { createEventSourceStream, type EventStream, type SessionLoss } from "./events.js";
import { Pages } from "./pages.js";
import { type SessionTiming, useSession } from "./session.js";

const browserEvents = createEventSourceStream();

const LOST: Record<SessionLoss, string> = {
  "signed-out": "This browser was signed out, perhaps from another tab.",
  "token-rotated":
    "The access token was replaced, so every session ended. Sign in with the new one.",
  expired: "The session ended after a long time unused.",
  unauthorized: "wg-hunt no longer accepts this browser's session.",
};

export function App({
  api,
  events = browserEvents,
  timing,
}: {
  api: ApiClient;
  events?: EventStream;
  timing?: SessionTiming;
}) {
  const { session, signIn, signOut, retry } = useSession(api, events, timing);

  if (session.status === "checking")
    return (
      <p className="boot" role="status">
        Loading…
      </p>
    );
  if (session.status === "unreachable")
    return <Unreachable checking={session.checking} onRetry={retry} />;
  if (session.status === "signedOut" && session.lost === undefined)
    return <Login onSignIn={signIn} />;
  // A session that ended under the pages keeps them, inert, behind the sign-in: a draft, a form
  // half filled in or a token shown once is still there afterwards.
  const lost = session.status === "signedOut" ? session.lost : undefined;
  return (
    <>
      <Shell api={api} events={events} inert={lost !== undefined}>
        <Pages api={api} events={events} onSignOut={signOut} />
      </Shell>
      {lost !== undefined && <Login onSignIn={signIn} ended={LOST[lost]} />}
    </>
  );
}
