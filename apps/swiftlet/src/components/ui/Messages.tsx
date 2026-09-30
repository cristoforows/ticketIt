import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentPropsWithRef } from "react";
import { cn } from "./cn";

const message = cva("border-l-4 bg-paper px-4 py-3 text-ink shadow-paper", {
  variants: {
    kind: {
      loading: "border-l-muted",
      error: "border-l-status-blocked-deep",
      empty: "border-l-rule text-muted",
    },
    flat: { true: "shadow-none", false: "" },
  },
  defaultVariants: { flat: false },
});

type Flat = Pick<VariantProps<typeof message>, "flat">;

export function LoadingMessage({ flat, className, ...rest }: ComponentPropsWithRef<"p"> & Flat) {
  return <p role="status" data-surface="paper" className={cn(message({ kind: "loading", flat }), className)} {...rest} />;
}

type ErrorMessageProps = Omit<ComponentPropsWithRef<"div">, "title"> & Flat & { title: string };

export function ErrorMessage({ title, flat, children, className, ...rest }: ErrorMessageProps) {
  return (
    <div role="alert" data-surface="paper" className={cn(message({ kind: "error", flat }), className)} {...rest}>
      <p className="font-bold text-status-blocked-deep">{title}</p>
      {children}
    </div>
  );
}

export function EmptyMessage({ flat, className, ...rest }: ComponentPropsWithRef<"p"> & Flat) {
  return <p data-surface="paper" className={cn(message({ kind: "empty", flat }), className)} {...rest} />;
}

const inlineError = cva("", {
  variants: { tone: { paper: "text-status-blocked-deep", ground: "text-status-blocked-text" } },
  defaultVariants: { tone: "paper" },
});

type InlineErrorProps = ComponentPropsWithRef<"p"> & VariantProps<typeof inlineError> & { announce?: boolean };

/** `announce={false}` for a standing marker that a field references, rather than a new error to interrupt with. */
export function InlineError({ tone, announce = true, className, ...rest }: InlineErrorProps) {
  return <p role={announce ? "alert" : undefined} className={cn(inlineError({ tone }), className)} {...rest} />;
}
