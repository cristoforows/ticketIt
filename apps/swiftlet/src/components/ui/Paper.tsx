import type { ComponentPropsWithRef, ElementType } from "react";
import { cx } from "./cx";

type PaperProps = ComponentPropsWithRef<"div"> & { as?: ElementType };

export function Paper({ as: Component = "div", className, ...rest }: PaperProps) {
  return <Component data-surface="paper" className={cx("bg-paper text-ink shadow-paper", className)} {...rest} />;
}
