import { useState } from "react";
import { signOut, type Owner } from "../api/session";
import { useRoute } from "../router";
import { StatusView } from "./StatusView";
import { TicketDetailPage } from "./TicketDetailPage";
import { TicketList } from "./TicketList";

interface AppShellProps {
  owner: Owner;
  /** Called once Galley confirms sign-out; App.tsx uses this to return
   * to the sign-in page without re-querying /api/session. */
  onSignedOut: () => void;
}

/**
 * The authenticated shell: shows which Owner is signed in and offers
 * sign-out. App.tsx only ever renders this after GET /api/session has
 * already succeeded — this component never decides who is signed in
 * itself.
 */
export function AppShell({ owner, onSignedOut }: AppShellProps) {
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
      {route.name === "backlog" && (
        <>
          <TicketList />
          <StatusView />
        </>
      )}
      {route.name === "ticket-detail" && <TicketDetailPage ticketId={route.ticketId} />}
    </div>
  );
}
