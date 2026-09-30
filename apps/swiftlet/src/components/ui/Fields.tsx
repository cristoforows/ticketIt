import type { ComponentPropsWithRef } from "react";
import { cx } from "./cx";

const field =
  "block w-full rounded-none border-2 border-ink bg-paper px-3 py-2 text-body text-ink placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-55";

export function TextInput({ className, ...rest }: ComponentPropsWithRef<"input">) {
  return <input className={cx(field, className)} {...rest} />;
}

export function Textarea({ className, ...rest }: ComponentPropsWithRef<"textarea">) {
  return <textarea className={cx(field, "min-h-24 resize-y", className)} {...rest} />;
}

export function Select({ className, ...rest }: ComponentPropsWithRef<"select">) {
  return <select className={cx(field, className)} {...rest} />;
}

export const fieldLabelClasses = "m-0 block text-label font-bold tracking-label text-muted uppercase";
