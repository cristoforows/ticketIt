import { useSyncExternalStore } from "react";

const phoneQuery = "(width < 48rem)";
const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

function subscribe(callback: () => void): () => void {
  const list = window.matchMedia?.(phoneQuery);
  list?.addEventListener("change", callback);
  return () => list?.removeEventListener("change", callback);
}

export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia?.(phoneQuery).matches ?? false, () => false);
}

export function scrollBehavior(): ScrollBehavior {
  return window.matchMedia?.(reducedMotionQuery).matches ? "auto" : "smooth";
}
