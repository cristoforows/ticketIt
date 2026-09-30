import type { ComponentPropsWithRef } from "react";
import { cx } from "./cx";

const block = "border-l-4 bg-paper px-4 py-3 text-ink shadow-paper";

export function LoadingMessage({ className, ...rest }: ComponentPropsWithRef<"p">) {
  return <p role="status" data-surface="paper" className={cx(block, "border-l-muted", className)} {...rest} />;
}

type ErrorMessageProps = Omit<ComponentPropsWithRef<"div">, "title"> & { title: string };

export function ErrorMessage({ title, children, className, ...rest }: ErrorMessageProps) {
  return (
    <div role="alert" data-surface="paper" className={cx(block, "border-l-status-blocked-deep", className)} {...rest}>
      <p className="font-bold text-status-blocked-deep">{title}</p>
      {children}
    </div>
  );
}

export function EmptyMessage({ className, ...rest }: ComponentPropsWithRef<"p">) {
  return <p data-surface="paper" className={cx(block, "border-l-rule text-muted", className)} {...rest} />;
}
