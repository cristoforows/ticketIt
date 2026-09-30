import type { ComponentPropsWithRef, ElementType } from "react";
import { cn } from "./cn";

type PaperProps = ComponentPropsWithRef<"div"> & { as?: ElementType };

export function Paper({ as: Component = "div", className, ...rest }: PaperProps) {
  return <Component data-surface="paper" className={cn("bg-paper text-ink shadow-paper", className)} {...rest} />;
}
