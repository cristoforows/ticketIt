import type { ComponentPropsWithRef } from "react";
import { cn } from "./cn";
import { statusLabel, statusTone, type TicketStatus } from "./status";

export function LogRow({ className, ...rest }: ComponentPropsWithRef<"li">) {
  return (
    <li
      className={cn(
        "mt-0 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t-0 border-b border-dashed border-rule px-1 py-2 hover:shadow-[inset_3px_0_0_var(--color-amber)] has-focus-visible:shadow-[inset_3px_0_0_var(--color-amber)]",
        className,
      )}
      {...rest}
    />
  );
}

export function LogRowMain({ className, ...rest }: ComponentPropsWithRef<"div">) {
  return <div className={cn("flex min-w-0 flex-[1_1_100%] items-baseline gap-3 sm:flex-[1_1_10rem]", className)} {...rest} />;
}

export function LogStatus({ status, className, ...rest }: Omit<ComponentPropsWithRef<"span">, "children"> & { status: TicketStatus }) {
  return (
    <span
      {...statusTone(status)}
      className={cn("ml-auto shrink-0 text-right text-label font-bold tracking-label text-(--status-deep) uppercase sm:w-28", className)}
      {...rest}
    >
      {statusLabel(status)}
    </span>
  );
}
