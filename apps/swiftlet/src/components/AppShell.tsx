import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { signOut, type Owner } from "../api/session";
import { collectionQuery, setArchivedFilter, useArchivedFilter, useBadgeFilter, useRoute, type CollectionRoute } from "../router";
import { BadgeFilter } from "./BadgeFilter";
import { Link } from "./Link";
import { NewOrderBar } from "./NewOrderBar";
import { AppHeader } from "./AppHeader";
import { StatusView } from "./StatusView";
import { TicketBoard } from "./TicketBoard";
import { TicketDetailPage } from "./TicketDetailPage";
import { TicketDetailModal } from "./TicketDetailModal";
import { TicketList } from "./TicketList";
import { ErrorMessage, FilterToggle, Paper, SecondaryButton } from "./ui";

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
  const badgeIds = useBadgeFilter();
  const archived = useArchivedFilter();
  const filterKey = `${badgeIds.join(",")}:${archived}`;
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

  const navLink = "px-3 py-1.5 text-label font-bold tracking-label text-dim uppercase no-underline ring-1 ring-dim hover:text-paper aria-[current=page]:bg-amber aria-[current=page]:text-ink aria-[current=page]:ring-amber";

  return (
    <div data-testid="app-shell">
      <AppHeader>
        <nav aria-label="Ticket views" className="flex gap-1">
          <Link to={`/${collectionQuery()}`} className={navLink} aria-current={background === "backlog" ? "page" : undefined}>List</Link>
          <Link to={`/board${collectionQuery()}`} className={navLink} aria-current={background === "board" ? "page" : undefined}>Board</Link>
        </nav>
        <div className="ml-auto flex min-w-0 items-center gap-4">
          <p data-testid="signed-in-owner" title={owner.login} className="min-w-0 break-words text-label tracking-label text-dim uppercase">Signed in as {owner.login}</p>
          <SecondaryButton tone="ground" className="shrink-0" onClick={handleSignOut} disabled={signingOut} data-testid="sign-out-button">
            Sign out
          </SecondaryButton>
        </div>
        {signOutError && (
          <ErrorMessage title="Unable to sign out." data-testid="sign-out-error" className="basis-full">
            <p>{signOutError}</p>
          </ErrorMessage>
        )}
      </AppHeader>
      <main className="mx-auto max-w-(--size-page) px-6 py-8">
        {route.name === "ticket-detail" && !route.background && (
          <TicketDetailPage key={route.ticketId} ticketId={route.ticketId} onUnauthenticated={onUnauthenticated} />
        )}
        {background && (
          <div className={background === "backlog" ? "mx-auto max-w-(--size-log)" : undefined}>
            {background === "backlog" && !archived && (
              <NewOrderBar onUnauthenticated={onUnauthenticated} onCreated={() => setRefresh((current) => ({ key: current.key + 1 }))} />
            )}
            <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2">
              <BadgeFilter tone="ground" selected={badgeIds} onUnauthenticated={onUnauthenticated} refreshKey={refresh.key} />
              {background === "backlog" && (
                <FilterToggle tone="ground" data-testid="archived-filter" checked={archived} onChange={(event) => setArchivedFilter(event.target.checked)}>Archived</FilterToggle>
              )}
            </div>
            {background === "backlog" && (
              <>
                <TicketList key={filterKey} badgeIds={badgeIds} archived={archived} onUnauthenticated={onUnauthenticated} refreshKey={refresh.key} focusTicketId={refresh.view === "backlog" ? refresh.ticketId : undefined} />
                <Paper as="footer" className="mt-6 p-4">
                  <h2 className="m-0 mb-2 text-label font-bold tracking-label text-muted uppercase">Galley status</h2>
                  <StatusView />
                </Paper>
              </>
            )}
            {background === "board" && <TicketBoard key={filterKey} badgeIds={badgeIds} onUnauthenticated={onUnauthenticated} refreshKey={refresh.key} focusTicketId={refresh.view === "board" ? refresh.ticketId : undefined} />}
          </div>
        )}
      </main>
      {modalTicketId && background && (
        <TicketDetailModal key={modalTicketId} ticketId={modalTicketId} background={background} onUnauthenticated={onUnauthenticated} onClose={() => window.history.back()} onCommandSucceeded={() => refreshAfterModalCommand(modalTicketId)} />
      )}
    </div>
  );
}
