import { cva, type VariantProps } from "class-variance-authority";
import { Fragment, type ComponentPropsWithRef } from "react";
import { cn } from "./cn";
import { statusLabel, statusTone, type TicketStatus } from "./status";

const tag = cva("inline-block rounded-tag text-label uppercase", {
  variants: {
    kind: {
      status: "bg-(--status-deep) px-2 py-0.5 font-bold tracking-label text-paper",
      badge: "bg-ink px-1.5 py-px text-paper",
      pending: "bg-ink px-2 py-0.5 font-bold tracking-label text-amber",
      queued: "border border-status-ready-deep bg-paper px-2 py-px font-bold tracking-label text-status-ready-deep",
      claimed: "border border-ink bg-paper px-2 py-px font-bold tracking-label text-ink",
      stopping: "border border-status-blocked-deep bg-paper px-2 py-px font-bold tracking-label text-status-blocked-deep",
      stopped: "border border-status-blocked-deep bg-status-blocked-deep px-2 py-px font-bold tracking-label text-paper",
      failed: "border border-status-blocked-deep bg-status-blocked-deep px-2 py-px font-bold tracking-label text-paper",
      interrupted: "border border-dashed border-status-blocked-deep bg-paper px-2 py-px font-bold tracking-label text-status-blocked-deep",
      delivered: "border border-status-in-review-deep bg-paper px-2 py-px font-bold tracking-label text-status-in-review-deep",
      estimate: "border border-muted bg-paper px-1.5 py-px font-bold tracking-label text-muted normal-case",
      expired: "border border-muted bg-paper px-2 py-px font-bold tracking-label text-muted",
    },
  },
});

type StatusTagProps = Omit<ComponentPropsWithRef<"span">, "children"> & {
  status: TicketStatus;
  children?: ComponentPropsWithRef<"span">["children"];
};

export function StatusTag({ status, children, className, ...rest }: StatusTagProps) {
  return (
    <span {...statusTone(status)} className={cn(tag({ kind: "status" }), className)} {...rest}>
      {children ?? statusLabel(status)}
    </span>
  );
}

export function BadgeTag({ className, ...rest }: ComponentPropsWithRef<"span">) {
  return <span className={cn(tag({ kind: "badge" }), className)} {...rest} />;
}

export function QueuedTag({ className, ...rest }: ComponentPropsWithRef<"span">) {
  return <span className={cn(tag({ kind: "queued" }), className)} {...rest} />;
}

export function ClaimedTag({ className, ...rest }: ComponentPropsWithRef<"span">) {
  return <span className={cn(tag({ kind: "claimed" }), className)} {...rest} />;
}

export function StoppingTag({ className, ...rest }: ComponentPropsWithRef<"span">) {
  return <span className={cn(tag({ kind: "stopping" }), className)} {...rest} />;
}

export function StoppedTag({ className, ...rest }: ComponentPropsWithRef<"span">) {
  return <span className={cn(tag({ kind: "stopped" }), className)} {...rest} />;
}

export function FailedTag({ className, ...rest }: ComponentPropsWithRef<"span">) {
  return <span className={cn(tag({ kind: "failed" }), className)} {...rest} />;
}

export function InterruptedTag({ className, ...rest }: ComponentPropsWithRef<"span">) {
  return <span className={cn(tag({ kind: "interrupted" }), className)} {...rest} />;
}

export function DeliveredTag({ className, ...rest }: ComponentPropsWithRef<"span">) {
  return <span className={cn(tag({ kind: "delivered" }), className)} {...rest} />;
}

export function EstimateTag({ className, ...rest }: Omit<ComponentPropsWithRef<"span">, "children">) {
  return <span className={cn(tag({ kind: "estimate" }), className)} {...rest}>est.</span>;
}

export function ExpiredTag({ className, ...rest }: ComponentPropsWithRef<"span">) {
  return <span className={cn(tag({ kind: "expired" }), className)} {...rest} />;
}

export function PendingTag({ className, ...rest }: ComponentPropsWithRef<"span">) {
  return <span role="status" className={cn(tag({ kind: "pending" }), className)} {...rest} />;
}

const healthPill = cva("inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-0.5 text-label font-bold tracking-label uppercase", {
  variants: {
    health: { connected: "", disconnected: "", not_paired: "", unknown: "" },
    tone: { ground: "", paper: "" },
  },
  compoundVariants: [
    { tone: "ground", health: "connected", className: "border-status-done-text text-status-done-text" },
    { tone: "ground", health: "disconnected", className: "border-status-blocked-text text-status-blocked-text" },
    { tone: "ground", health: ["not_paired", "unknown"], className: "border-dim text-dim" },
    { tone: "paper", health: "connected", className: "border-status-done-deep text-status-done-deep" },
    { tone: "paper", health: "disconnected", className: "border-status-blocked-deep text-status-blocked-deep" },
    { tone: "paper", health: ["not_paired", "unknown"], className: "border-muted text-muted" },
  ],
  defaultVariants: { tone: "ground" },
});

export type HealthPillState = NonNullable<VariantProps<typeof healthPill>["health"]>;

type HealthPillProps = ComponentPropsWithRef<"span"> & { health: HealthPillState; tone?: "ground" | "paper" };

export function HealthPill({ health, tone, className, children, ...rest }: HealthPillProps) {
  return (
    <span data-health={health} className={cn(healthPill({ health, tone }), className)} {...rest}>
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-pill bg-current" />
      {children}
    </span>
  );
}

export function BadgeList({ badges, as: Component = "p", className, ...rest }: { badges: { id: string; name: string }[]; as?: "p" | "span" } & ComponentPropsWithRef<"p">) {
  // The slip's wrapper span gives each tag a line box; the log row's tags are bare flex items.
  const Item = Component === "p" ? "span" : Fragment;
  return (
    <Component
      aria-label={`Badges: ${badges.map((badge) => badge.name).join(", ") || "none"}`}
      className={cn("flex-wrap gap-1", Component === "p" ? "flex empty:hidden" : "inline-flex", className)}
      {...rest}
    >
      {badges.map((badge, index) => (
        <Item key={badge.id}>
          {index > 0 && <span className="sr-only">, </span>}
          <BadgeTag>{badge.name}</BadgeTag>
        </Item>
      ))}
    </Component>
  );
}
