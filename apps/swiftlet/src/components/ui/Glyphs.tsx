import type { ComponentPropsWithRef } from "react";
import { cn } from "./cn";

type GlyphProps = Omit<ComponentPropsWithRef<"svg">, "children" | "aria-label"> & { label?: string };

export function LockGlyph({ label, className, ...rest }: GlyphProps) {
  const name = label ? { role: "img", "aria-label": label } : { "aria-hidden": true };
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} className={cn("inline-block size-3.5 shrink-0", className)} {...name} {...rest}>
      {label && <title>{label}</title>}
      <rect x="3" y="7" width="10" height="7" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}
