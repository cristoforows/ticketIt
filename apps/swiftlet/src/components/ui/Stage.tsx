import type { ComponentPropsWithRef } from "react";
import { cn } from "./cn";
import { statusTone, type TicketStatus } from "./status";

export function StageLabel({ className, ...rest }: ComponentPropsWithRef<"p">) {
  return <p className={cn("m-0 flex items-center gap-2 text-body font-bold tracking-label text-(--status-text) uppercase", className)} {...rest} />;
}

type StageStepProps = Omit<ComponentPropsWithRef<"button">, "children" | "type"> & { status: TicketStatus };

export function StageStep({ status, className, ...rest }: StageStepProps) {
  return (
    <button
      type="button"
      {...statusTone(status)}
      className={cn("group/step flex h-6 w-full items-center border-0 bg-transparent p-0", className)}
      {...rest}
    >
      <span className="block h-1.5 w-full rounded-pill bg-dim opacity-60 group-aria-[current=true]/step:h-2.5 group-aria-[current=true]/step:bg-(--status-text) group-aria-[current=true]/step:opacity-100" />
    </button>
  );
}
