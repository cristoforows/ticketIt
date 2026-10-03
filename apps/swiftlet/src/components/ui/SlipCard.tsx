import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentPropsWithRef, CSSProperties } from "react";
import { cn } from "./cn";
import { statusTone, type TicketStatus } from "./status";

type SlipProps = ComponentPropsWithRef<"li"> & { tilt: number; stacked?: boolean; dragging?: boolean; selected?: boolean; active?: boolean; dropPosition?: "before" | "after" };

export function Slip({ tilt, stacked, dragging, selected, active, dropPosition, className, style, ...rest }: SlipProps) {
  return (
    <li
      data-active={active || undefined}
      data-stacked={stacked || undefined}
      data-dragging={dragging || undefined}
      data-selected={selected || undefined}
      data-drop-position={dropPosition}
      style={{ "--tilt": `${tilt}deg`, ...style } as CSSProperties}
      className={cn(
        "slip group/slip relative data-stacked:grid data-dragging:opacity-60 [&[draggable=true]]:cursor-grab",
        "data-drop-position:before:absolute data-drop-position:before:inset-x-0 data-drop-position:before:h-1 data-drop-position:before:rounded-pill data-drop-position:before:bg-(--status-text)",
        "data-[drop-position=after]:before:-bottom-2.5 data-[drop-position=before]:before:-top-2.5",
        className,
      )}
      {...rest}
    />
  );
}

const slipPaper = cva("slip-paper col-start-1 row-start-1 flex flex-col gap-2 border-t-4 border-(--status) px-3 pt-3 pb-5 text-ink", {
  variants: {
    kind: {
      ticket:
        "group-data-dragging/slip:outline-2 group-data-dragging/slip:-outline-offset-4 group-data-dragging/slip:outline-ink group-data-dragging/slip:outline-dashed group-aria-busy/slip:opacity-70 group-data-selected/slip:opacity-40 group-data-selected/slip:grayscale",
      actions: "pointer-events-none z-20 justify-center bg-rail",
    },
    active: { true: "", false: "" },
  },
  compoundVariants: [
    { kind: "ticket", active: false, className: "bg-paper" },
    { kind: "ticket", active: true, className: "bg-rule" },
  ],
  defaultVariants: { kind: "ticket", active: false },
});

export function SlipPaper({ status, kind, active, className, ...rest }: ComponentPropsWithRef<"div"> & VariantProps<typeof slipPaper> & { status: TicketStatus }) {
  return <div data-surface="paper" {...statusTone(status)} className={cn(slipPaper({ kind, active }), className)} {...rest} />;
}

export function SlipToggle({ className, ...rest }: ComponentPropsWithRef<"button">) {
  return <button type="button" className={cn("z-10 col-start-1 row-start-1 h-full w-full cursor-pointer border-0 bg-transparent p-0", className)} {...rest} />;
}
