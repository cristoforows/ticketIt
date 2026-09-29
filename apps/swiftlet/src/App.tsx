import { useEffect, useState } from "react";
import { fetchSession, UnauthenticatedError, type Owner } from "./api/session";
import { AppShell } from "./components/AppShell";
import { AppHeader } from "./components/AppHeader";
import { SignInPage } from "./components/SignInPage";
import { ErrorMessage, LoadingMessage } from "./components/ui";

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

  if (state.kind === "signedIn") {
    return <AppShell owner={state.owner} onSignedOut={returnToSignIn} onUnauthenticated={returnToSignIn} />;
  }

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-(--size-page) px-6 py-8">
        {state.kind === "loading" && <LoadingMessage data-testid="session-loading">Checking session…</LoadingMessage>}
        {state.kind === "error" && (
          <ErrorMessage title="Unable to check the current session." data-testid="session-error">
            <p data-testid="session-error-message">{state.message}</p>
          </ErrorMessage>
        )}
        {state.kind === "signedOut" && <SignInPage />}
      </main>
    </>
  );
}

export default App;
