import type { ComponentPropsWithRef, ReactNode } from "react";
import { cn } from "./cn";

type DisclosureProps = Omit<ComponentPropsWithRef<"details">, "open" | "children"> & {
  summary: ReactNode;
  defaultOpen: boolean;
  children: ReactNode;
};

/** React rewrites `open` only when `defaultOpen` changes, so the reader's own toggling survives re-renders. */
export function Disclosure({ summary, defaultOpen, children, className, ...rest }: DisclosureProps) {
  return (
    <details open={defaultOpen} className={cn("group", className)} {...rest}>
      <summary className="flex cursor-pointer list-none items-baseline gap-2 font-bold text-ink [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="group-open:hidden">+</span>
        <span aria-hidden="true" className="hidden group-open:inline">−</span>
        {summary}
      </summary>
      {children}
    </details>
  );
}
