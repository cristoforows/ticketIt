import type { ComponentPropsWithRef, ElementType } from "react";
import { cn } from "./cn";

const field =
  "block w-full rounded-none border-2 border-ink bg-paper px-3 py-2 text-body text-ink placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-55";

export function TextInput({ className, ...rest }: ComponentPropsWithRef<"input">) {
  return <input className={cn(field, className)} {...rest} />;
}

export function Textarea({ className, ...rest }: ComponentPropsWithRef<"textarea">) {
  return <textarea className={cn(field, "min-h-24 resize-y", className)} {...rest} />;
}

export function Select({ className, ...rest }: ComponentPropsWithRef<"select">) {
  return <select className={cn(field, className)} {...rest} />;
}

type FieldLabelProps = ComponentPropsWithRef<"label"> & { as?: ElementType };

export function FieldLabel({ as: Component = "label", className, ...rest }: FieldLabelProps) {
  return <Component className={cn("m-0 block text-label font-bold tracking-label text-muted uppercase", className)} {...rest} />;
}

export function FieldHint({ className, ...rest }: ComponentPropsWithRef<"p">) {
  return <p className={cn("mt-0.5 mb-1 text-muted", className)} {...rest} />;
}

export function FieldNote({ className, ...rest }: ComponentPropsWithRef<"p">) {
  return <p className={cn("my-1 text-muted italic", className)} {...rest} />;
}

export function FieldValue({ empty = false, className, ...rest }: ComponentPropsWithRef<"p"> & { empty?: boolean }) {
  return <p data-empty={empty || undefined} className={cn("mt-1 mb-0 break-words whitespace-pre-wrap data-empty:text-muted data-empty:italic", className)} {...rest} />;
}
