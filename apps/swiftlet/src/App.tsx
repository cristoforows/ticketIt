import { useEffect, useState } from "react";
import { fetchSession, UnauthenticatedError, type Owner } from "./api/session";
import { AppShell } from "./components/AppShell";
import { SignInPage } from "./components/SignInPage";

type SessionState =
  | { kind: "loading" }
  | { kind: "signedOut" }
  | { kind: "signedIn"; owner: Owner }
  | { kind: "error"; message: string };

/**
 * Session-aware root: checks GET /api/session once on load and renders
 * either the signed-in shell or the sign-in page. A 401 (no session)
 * always means the sign-in page — never a generic error — matching
 * every other authenticated call this app makes (AppShell's sign-out).
 */
function App() {
  const [state, setState] = useState<SessionState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;

    fetchSession()
      .then((session) => {
        if (!cancelled) {
          setState({ kind: "signedIn", owner: session.owner });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        if (error instanceof UnauthenticatedError) {
          setState({ kind: "signedOut" });
          return;
        }
        const message = error instanceof Error ? error.message : "Unknown error checking session.";
        setState({ kind: "error", message });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const returnToSignIn = () => setState({ kind: "signedOut" });

  return (
    <main>
      <h1>Swiftlet</h1>
      {state.kind === "loading" && (
        <p role="status" data-testid="session-loading">
          Checking session…
        </p>
      )}
      {state.kind === "error" && (
        <div role="alert" data-testid="session-error">
          <p>Unable to check the current session.</p>
          <p data-testid="session-error-message">{state.message}</p>
        </div>
      )}
      {state.kind === "signedOut" && <SignInPage />}
      {state.kind === "signedIn" && (
        <AppShell owner={state.owner} onSignedOut={returnToSignIn} onUnauthenticated={returnToSignIn} />
      )}
    </main>
  );
}

export default App;
