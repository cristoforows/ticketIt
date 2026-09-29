import { useEffect, useState } from "react";
import { fetchBadges, type Badge } from "../api/tickets";
import { UnauthenticatedError } from "../api/session";
import { setBadgeFilter } from "../router";

export function BadgeFilter({ selected, onUnauthenticated, refreshKey = 0 }: { selected: string[]; onUnauthenticated: () => void; refreshKey?: number }) {
  const [badges, setBadges] = useState<Badge[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetchBadges().then((items) => {
      if (!cancelled) { setBadges(items); setError(null); }
    }).catch((cause: unknown) => {
      if (cancelled) return;
      if (cause instanceof UnauthenticatedError) onUnauthenticated();
      else setError(cause instanceof Error ? cause.message : "Failed to load badges.");
    });
    return () => { cancelled = true; };
  }, [onUnauthenticated, retry, refreshKey]);

  return <section aria-label="Filter by Badge" data-testid="badge-filter">
    <p>Filter by Badge (match any)</p>
    {error && <p role="alert">{error} <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry</button></p>}
    {badges.map((badge) => <label key={badge.id}>
      <input type="checkbox" checked={selected.includes(badge.id)} onChange={(event) => setBadgeFilter(event.target.checked ? [...selected, badge.id] : selected.filter((id) => id !== badge.id))} />
      {badge.name}
    </label>)}
    {selected.length > 0 && <button type="button" onClick={() => setBadgeFilter([])}>Clear filter</button>}
  </section>;
}
