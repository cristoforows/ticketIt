import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentPropsWithRef } from "react";
import { cn } from "./cn";

const rule = cva("my-3 border-0 border-t border-dashed border-rule", {
  variants: { weight: { thin: "", thick: "border-t-2" } },
  defaultVariants: { weight: "thin" },
});

export function Rule({ weight, className, ...rest }: ComponentPropsWithRef<"hr"> & VariantProps<typeof rule>) {
  return <hr className={cn(rule({ weight }), className)} {...rest} />;
}
