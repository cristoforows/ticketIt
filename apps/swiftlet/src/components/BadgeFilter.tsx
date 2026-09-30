import { useEffect, useState } from "react";
import { fetchBadges, type Badge } from "../api/tickets";
import { UnauthenticatedError } from "../api/session";
import { setBadgeFilter } from "../router";
import { Caption, FilterToggle, InlineError, SecondaryButton, type ButtonTone } from "./ui";

export function BadgeFilter({ selected, onUnauthenticated, refreshKey = 0, tone = "paper" }: { selected: string[]; onUnauthenticated: () => void; refreshKey?: number; tone?: ButtonTone }) {
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

  return <section aria-label="Filter by Badge" data-testid="badge-filter" className="flex flex-wrap items-center gap-2">
    <Caption tone={tone} className="mr-2">Filter by Badge (match any)</Caption>
    {error && <InlineError tone={tone}>{error} <SecondaryButton tone={tone} onClick={() => setRetry((value) => value + 1)}>Retry</SecondaryButton></InlineError>}
    {badges.map((badge) => <FilterToggle key={badge.id} tone={tone} checked={selected.includes(badge.id)} onChange={(event) => setBadgeFilter(event.target.checked ? [...selected, badge.id] : selected.filter((id) => id !== badge.id))}>
      {badge.name}
    </FilterToggle>)}
    {selected.length > 0 && <SecondaryButton tone={tone} className="text-label tracking-label uppercase" onClick={() => setBadgeFilter([])}>Clear filter</SecondaryButton>}
  </section>;
}
