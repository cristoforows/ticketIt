import { useState } from "react";
import { signOut, type Owner } from "../api/session";
import { useRoute } from "../router";
import { Link } from "./Link";
import { StatusView } from "./StatusView";
import { TicketBoard } from "./TicketBoard";
import { TicketDetailPage } from "./TicketDetailPage";
import { TicketList } from "./TicketList";

interface AppShellProps {
  owner: Owner;
  /** Called once Galley confirms sign-out; App.tsx uses this to return
   * to the sign-in page without re-querying /api/session. */
  onSignedOut: () => void;
  onUnauthenticated: () => void;
}

/**
 * The authenticated shell: shows which Owner is signed in and offers
 * sign-out. App.tsx only ever renders this after GET /api/session has
 * already succeeded — this component never decides who is signed in
 * itself.
 */
export function AppShell({ owner, onSignedOut, onUnauthenticated }: AppShellProps) {
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const route = useRoute();

  async function handleSignOut() {
    setSigningOut(true);
    setSignOutError(null);
    try {
      await signOut();
      onSignedOut();
    } catch (error) {
      setSignOutError(error instanceof Error ? error.message : "Sign-out failed.");
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div data-testid="app-shell">
      <p data-testid="signed-in-owner">Signed in as {owner.login}</p>
      <button type="button" onClick={handleSignOut} disabled={signingOut} data-testid="sign-out-button">
        Sign out
      </button>
      {signOutError && (
        <p role="alert" data-testid="sign-out-error">
          {signOutError}
        </p>
      )}
      <nav aria-label="Ticket views">
        <Link to="/" aria-current={route.name === "backlog" ? "page" : undefined}>List</Link>{" "}
        <Link to="/board" aria-current={route.name === "board" ? "page" : undefined}>Board</Link>
      </nav>
      {route.name === "backlog" && (
        <>
          <TicketList onUnauthenticated={onUnauthenticated} />
          <StatusView />
        </>
      )}
      {route.name === "board" && <TicketBoard onUnauthenticated={onUnauthenticated} />}
      {route.name === "ticket-detail" && (
        <TicketDetailPage key={route.ticketId} ticketId={route.ticketId} onUnauthenticated={onUnauthenticated} />
      )}
    </div>
  );
}
