import { useEffect, useState } from "react";
import { fetchBadges, type Badge } from "../api/tickets";
import { UnauthenticatedError } from "../api/session";
import { setBadgeFilter } from "../router";
import { cx, SecondaryButton, type ButtonTone } from "./ui";

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

  const ground = tone === "ground";
  const toggle = cx(
    "relative inline-flex cursor-pointer items-center px-2 py-1 text-label tracking-label uppercase ring-1 has-checked:font-bold has-checked:before:mr-1 has-checked:before:content-['✓'] has-focus-visible:outline-2 has-focus-visible:outline-offset-2",
    ground
      ? "text-dim ring-dim hover:text-paper has-checked:bg-paper has-checked:text-ink has-checked:ring-paper has-focus-visible:outline-amber"
      : "text-muted ring-ink hover:text-ink has-checked:bg-ink has-checked:text-paper has-focus-visible:outline-ink",
  );
  return <section aria-label="Filter by Badge" data-testid="badge-filter" className="mb-4 flex flex-wrap items-center gap-2">
    <p className={cx("mr-2 text-label tracking-label uppercase", ground ? "text-dim" : "text-muted")}>Filter by Badge (match any)</p>
    {error && <p role="alert" className={ground ? "text-status-blocked-text" : "text-status-blocked-deep"}>{error} <SecondaryButton tone={tone} className="px-2 py-1" onClick={() => setRetry((value) => value + 1)}>Retry</SecondaryButton></p>}
    {badges.map((badge) => <label key={badge.id} className={cx(toggle, "m-0")}>
      <input type="checkbox" className="absolute inset-0 m-0 size-full cursor-pointer opacity-0" checked={selected.includes(badge.id)} onChange={(event) => setBadgeFilter(event.target.checked ? [...selected, badge.id] : selected.filter((id) => id !== badge.id))} />
      {badge.name}
    </label>)}
    {selected.length > 0 && <SecondaryButton tone={tone} className="px-2 py-1 text-label tracking-label uppercase" onClick={() => setBadgeFilter([])}>Clear filter</SecondaryButton>}
  </section>;
}
