import { useSyncExternalStore } from "react";

export type Route = { name: "backlog" } | { name: "ticket-detail"; ticketId: string };

/**
 * Swiftlet's whole router (issue #57): two fixed routes -- the Backlog
 * list and a Ticket's canonical full-page detail view. A hand-rolled
 * ~30-line reader of window.location.pathname, not a routing library:
 * proportionate to a small app with exactly this shape today (see
 * docs/evidence/m2/57-*.md for the full reasoning, matching
 * apps/galley/README.md's own "Router choice" -- reach for the
 * standard tool before a third-party one for a handful of fixed
 * routes). Any path that isn't exactly "/" or "/tickets/:id" falls
 * back to the Backlog view rather than a separate app-level 404 page,
 * since only a Ticket identifier (not an arbitrary route) needs its
 * own not-found presentation here.
 */
function parseRoute(pathname: string): Route {
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
