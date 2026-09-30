import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentPropsWithRef, ElementType } from "react";
import { cn } from "./cn";

const caption = cva("text-label tracking-label uppercase", {
  variants: { tone: { paper: "text-muted", ground: "text-dim" } },
  defaultVariants: { tone: "paper" },
});

export function Caption({ as: Component = "p", tone, className, ...rest }: ComponentPropsWithRef<"p"> & VariantProps<typeof caption> & { as?: ElementType }) {
  return <Component className={cn(caption({ tone }), className)} {...rest} />;
}

const capsLink = cva("text-label font-bold tracking-label uppercase", {
  variants: { tone: { paper: "", ground: "text-amber" } },
  defaultVariants: { tone: "paper" },
});

export function capsLinkClasses(options?: VariantProps<typeof capsLink>): string {
  return capsLink(options);
}
