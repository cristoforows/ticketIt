import type { ComponentPropsWithRef } from "react";
import { cx } from "./cx";
import { statusLabel, statusTone, type TicketStatus } from "./status";

type StatusTagProps = Omit<ComponentPropsWithRef<"span">, "children"> & {
  status: TicketStatus;
  children?: ComponentPropsWithRef<"span">["children"];
};

export function StatusTag({ status, children, className, ...rest }: StatusTagProps) {
  return (
    <span
      {...statusTone(status)}
      className={cx("inline-block rounded-tag bg-(--status-deep) px-2 py-0.5 text-label font-bold tracking-label text-paper uppercase", className)}
      {...rest}
    >
      {children ?? statusLabel(status)}
    </span>
  );
}

export function BadgeTag({ className, ...rest }: ComponentPropsWithRef<"span">) {
  return <span className={cx("inline-block rounded-tag bg-ink px-1.5 py-px text-label text-paper uppercase", className)} {...rest} />;
}
