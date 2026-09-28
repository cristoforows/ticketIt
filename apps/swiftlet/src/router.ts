import { useSyncExternalStore } from "react";

export type Route = { name: "backlog" } | { name: "board" } | { name: "ticket-detail"; ticketId: string };

function parseRoute(pathname: string): Route {
  if (pathname === "/board") return { name: "board" };
  const detailMatch = pathname.match(/^\/tickets\/([^/]+)\/?$/);
  if (detailMatch) {
    try {
      return { name: "ticket-detail", ticketId: decodeURIComponent(detailMatch[1]) };
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
  return window.location.pathname;
}

/** Re-renders on browser back/forward and on navigate()'s own synthetic "popstate". */
export function useRoute(): Route {
  const pathname = useSyncExternalStore(subscribe, getSnapshot);
  return parseRoute(pathname);
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
