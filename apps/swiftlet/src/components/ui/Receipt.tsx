import * as Dialog from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentPropsWithRef, ElementType } from "react";
import { cn } from "./cn";
import { FieldLabel } from "./Fields";

const receiptDialog = cva(
  "fixed top-1/2 left-1/2 z-50 box-border w-[min(var(--size-receipt),calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 bg-paper text-ink shadow-paper",
  {
    variants: {
      layout: {
        scroll: "max-h-[calc(100vh-2rem)] overflow-y-auto p-5",
        stack: "flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden",
      },
    },
    defaultVariants: { layout: "scroll" },
  },
);

export function ReceiptDialog({ layout, className, ...rest }: ComponentPropsWithRef<typeof Dialog.Content> & VariantProps<typeof receiptDialog>) {
  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
      <Dialog.Content className={cn(receiptDialog({ layout }), className)} {...rest} />
    </Dialog.Portal>
  );
}

export function ReceiptBody({ className, ...rest }: ComponentPropsWithRef<"div">) {
  return <div className={cn("flex min-h-0 flex-col gap-3 overflow-y-auto p-5 pb-3", className)} {...rest} />;
}

export function ReceiptFooter({ className, ...rest }: ComponentPropsWithRef<"div">) {
  return <div className={cn("flex shrink-0 flex-col gap-3 border-t border-dashed border-rule px-5 py-3", className)} {...rest} />;
}

export function ReceiptTitle({ as: Component = "h2", className, ...rest }: ComponentPropsWithRef<"h2"> & { as?: ElementType }) {
  return <Component className={cn("m-0 text-center text-title font-bold tracking-wordmark uppercase", className)} {...rest} />;
}

export function ReceiptLine({ label, children, ...rest }: { label: string } & ComponentPropsWithRef<"dd">) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <FieldLabel as="dt">{label}</FieldLabel>
      <dd className="m-0 text-right break-words" {...rest}>{children}</dd>
    </div>
  );
}
