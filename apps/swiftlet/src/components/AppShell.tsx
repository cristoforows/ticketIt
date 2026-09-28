import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { signOut, type Owner } from "../api/session";
import { useRoute, type CollectionRoute } from "../router";
import { Link } from "./Link";
import { StatusView } from "./StatusView";
import { TicketBoard } from "./TicketBoard";
import { TicketDetailPage } from "./TicketDetailPage";
import { TicketDetailModal } from "./TicketDetailModal";
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
  const currentRoute = useRef(route);
  useLayoutEffect(() => { currentRoute.current = route; }, [route]);
  const background: CollectionRoute | undefined = route.name === "ticket-detail" ? route.background : route.name;
  const modalTicketId = route.name === "ticket-detail" && route.background ? route.ticketId : undefined;
  const previousModal = useRef<{ ticketId: string; background: CollectionRoute } | null>(null);
  const [refresh, setRefresh] = useState<{ key: number; view?: CollectionRoute; ticketId?: string }>({ key: 0 });

  useEffect(() => {
    if (modalTicketId && background) {
      previousModal.current = { ticketId: modalTicketId, background };
    } else if (previousModal.current) {
      const previous = previousModal.current;
      previousModal.current = null;
      if (background === previous.background) setRefresh(({ key }) => ({ key: key + 1, view: background, ticketId: previous.ticketId }));
    } else if (refresh.ticketId && refresh.view !== background) {
      setRefresh((current) => ({ ...current, ticketId: undefined }));
    }
  }, [modalTicketId, background, refresh.ticketId, refresh.view]);

  function refreshAfterModalCommand(ticketId: string) {
    const active = currentRoute.current;
    if (active.name !== "backlog" && active.name !== "board") return;
    setRefresh((current) => ({
      key: current.key + 1,
      view: active.name,
      ticketId: current.view === active.name && current.ticketId === ticketId ? ticketId : undefined,
    }));
  }

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
        <Link to="/" aria-current={background === "backlog" ? "page" : undefined}>List</Link>{" "}
        <Link to="/board" aria-current={background === "board" ? "page" : undefined}>Board</Link>
      </nav>
      {background === "backlog" && (
        <>
          <TicketList onUnauthenticated={onUnauthenticated} refreshKey={refresh.key} focusTicketId={refresh.view === "backlog" ? refresh.ticketId : undefined} />
          <StatusView />
        </>
      )}
      {background === "board" && <TicketBoard onUnauthenticated={onUnauthenticated} refreshKey={refresh.key} focusTicketId={refresh.view === "board" ? refresh.ticketId : undefined} />}
      {route.name === "ticket-detail" && !route.background && (
        <TicketDetailPage key={route.ticketId} ticketId={route.ticketId} onUnauthenticated={onUnauthenticated} />
      )}
      {modalTicketId && (
        <TicketDetailModal key={modalTicketId} ticketId={modalTicketId} onUnauthenticated={onUnauthenticated} onClose={() => window.history.back()} onCommandSucceeded={() => refreshAfterModalCommand(modalTicketId)} />
      )}
    </div>
  );
}
