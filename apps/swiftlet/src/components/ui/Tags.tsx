import { cva } from "class-variance-authority";
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

export function PendingTag({ className, ...rest }: ComponentPropsWithRef<"span">) {
  return <span role="status" className={cn(tag({ kind: "pending" }), className)} {...rest} />;
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
