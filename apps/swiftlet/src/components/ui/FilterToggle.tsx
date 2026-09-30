import { cva } from "class-variance-authority";
import type { ComponentPropsWithRef } from "react";
import type { ButtonTone } from "./Button";
import { cn } from "./cn";

const toggle = cva(
  "relative m-0 inline-flex cursor-pointer items-center px-2 py-1 text-label tracking-label uppercase ring-1 has-checked:font-bold has-checked:before:mr-1 has-checked:before:content-['✓'] has-focus-visible:outline-2 has-focus-visible:outline-offset-2",
  {
    variants: {
      tone: {
        paper: "text-muted ring-ink hover:text-ink has-checked:bg-ink has-checked:text-paper has-focus-visible:outline-ink",
        ground: "text-dim ring-dim hover:text-paper has-checked:bg-paper has-checked:text-ink has-checked:ring-paper has-focus-visible:outline-amber",
      },
    },
    defaultVariants: { tone: "paper" },
  },
);

type FilterToggleProps = Omit<ComponentPropsWithRef<"input">, "type"> & { tone?: ButtonTone };

export function FilterToggle({ tone, className, children, ...rest }: FilterToggleProps) {
  return (
    <label className={toggle({ tone })}>
      <input type="checkbox" className={cn("absolute inset-0 m-0 size-full cursor-pointer opacity-0", className)} {...rest} />
      {children}
    </label>
  );
}
