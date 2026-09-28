import { useSyncExternalStore } from "react";

export type CollectionRoute = "backlog" | "board";
export type Route = { name: CollectionRoute } | { name: "ticket-detail"; ticketId: string; background?: CollectionRoute };

const pageLoadId = crypto.randomUUID();

interface ModalHistoryState {
  ticketModal: { pageLoadId: string; background: CollectionRoute };
}

function modalBackground(): CollectionRoute | undefined {
  const state = window.history.state as Partial<ModalHistoryState> | null;
  const modal = state?.ticketModal;
  if (modal?.pageLoadId !== pageLoadId) return undefined;
  return modal.background === "backlog" || modal.background === "board" ? modal.background : undefined;
}

function parseRoute(pathname: string, background?: CollectionRoute): Route {
  if (pathname === "/board") return { name: "board" };
  const detailMatch = pathname.match(/^\/tickets\/([^/]+)\/?$/);
  if (detailMatch) {
    try {
      return { name: "ticket-detail", ticketId: decodeURIComponent(detailMatch[1]), background };
    } catch (error) {
      if (!(error instanceof URIError)) throw error;
    }
  }
  return { name: "backlog" };
}

function subscribe(callback: () => void): () => void {
  window.addEventListener("popstate", callback);
  return () => window.removeEventListener("popstate", callback);
}

function getSnapshot(): string {
  return JSON.stringify([window.location.pathname, modalBackground()]);
}

/** Re-renders on browser back/forward and on navigate()'s own synthetic "popstate". */
export function useRoute(): Route {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const [pathname, background] = JSON.parse(snapshot) as [string, CollectionRoute | undefined];
  return parseRoute(pathname, background);
}

export function openTicketModal(ticketId: string, background: CollectionRoute): void {
  window.history.pushState({ ticketModal: { pageLoadId, background } } satisfies ModalHistoryState, "", `/tickets/${encodeURIComponent(ticketId)}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function openTicketFullPage(ticketId: string): void {
  window.history.replaceState({}, "", `/tickets/${encodeURIComponent(ticketId)}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * Pushes a new URL without a full page load, notifying every
 * useRoute() subscriber. pushState alone fires no event -- dispatching
 * a synthetic "popstate" is what makes useRoute's real popstate
 * listener also pick up an in-app navigate() call, unifying both under
 * one subscription.
 */
export function navigate(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
