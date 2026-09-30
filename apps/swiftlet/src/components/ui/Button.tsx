import type { ComponentPropsWithRef } from "react";
import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary";
export type ButtonTone = "paper" | "ground";

const base =
  "inline-flex cursor-pointer items-center justify-center gap-2 px-4 py-2 text-body font-bold tracking-button whitespace-nowrap no-underline transition-colors disabled:cursor-not-allowed disabled:opacity-55";

export function buttonClasses(variant: ButtonVariant = "primary", tone: ButtonTone = "paper"): string {
  if (variant === "primary") {
    return cx(base, "border-2 border-ink bg-ink text-amber hover:bg-header", tone === "ground" && "border-amber");
  }
  return cx(
    base,
    "border-2 bg-transparent",
    tone === "paper" ? "border-ink text-ink hover:bg-ink/10" : "border-dim text-paper hover:bg-paper/10",
  );
}

type ButtonProps = ComponentPropsWithRef<"button"> & { tone?: ButtonTone };

export function PrimaryButton({ tone, className, type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={cx(buttonClasses("primary", tone), className)} {...rest} />;
}

export function SecondaryButton({ tone, className, type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={cx(buttonClasses("secondary", tone), className)} {...rest} />;
}
