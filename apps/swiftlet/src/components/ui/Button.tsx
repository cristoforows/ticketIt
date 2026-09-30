import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentPropsWithRef } from "react";
import { cn } from "./cn";

const buttonVariants = cva(
  "inline-flex cursor-pointer items-center justify-center gap-2 text-body font-bold tracking-button whitespace-nowrap no-underline transition-colors disabled:cursor-not-allowed disabled:opacity-55",
  {
    variants: {
      variant: {
        primary: "border-2 border-ink bg-ink text-amber hover:bg-header",
        secondary: "border-2 bg-transparent",
      },
      tone: { paper: "", ground: "" },
      size: { md: "px-4 py-2", sm: "px-2 py-0.5" },
      filled: { true: "", false: "" },
    },
    compoundVariants: [
      { variant: "secondary", tone: "paper", className: "border-ink text-ink hover:bg-ink/10" },
      { variant: "secondary", tone: "ground", className: "border-dim text-paper hover:bg-paper/10" },
      { variant: "secondary", filled: true, className: "bg-paper hover:bg-paper" },
    ],
    defaultVariants: { variant: "primary", tone: "paper", size: "md", filled: false },
  },
);

type ButtonVariants = VariantProps<typeof buttonVariants>;
export type ButtonVariant = NonNullable<ButtonVariants["variant"]>;
export type ButtonTone = NonNullable<ButtonVariants["tone"]>;
export type ButtonSize = NonNullable<ButtonVariants["size"]>;

export function buttonClasses({ className, ...variants }: ButtonVariants & { className?: string } = {}): string {
  return cn(buttonVariants(variants), className);
}

type ButtonProps = ComponentPropsWithRef<"button"> & Pick<ButtonVariants, "size">;

export function PrimaryButton({ size, className, type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={buttonClasses({ variant: "primary", size, className })} {...rest} />;
}

export function SecondaryButton({ tone, size, filled, className, type = "button", ...rest }: ButtonProps & Pick<ButtonVariants, "tone" | "filled">) {
  return <button type={type} className={buttonClasses({ variant: "secondary", tone, size, filled, className })} {...rest} />;
}
