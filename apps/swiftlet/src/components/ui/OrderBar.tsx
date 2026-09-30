import type { ComponentPropsWithRef } from "react";
import { cn } from "./cn";

export function OrderBar({ className, ...rest }: ComponentPropsWithRef<"form">) {
  return <form className={cn("mb-4 flex flex-wrap items-stretch bg-header ring-2 ring-amber", className)} {...rest} />;
}

export function OrderBarLabel({ className, ...rest }: ComponentPropsWithRef<"label">) {
  return <label className={cn("m-0 flex items-center bg-amber px-3 py-2 text-label font-bold tracking-label text-ink uppercase", className)} {...rest} />;
}

export function OrderBarInput({ className, ...rest }: ComponentPropsWithRef<"input">) {
  return <input className={cn("min-w-0 flex-[1_1_10rem] border-0 bg-transparent px-3 py-2 text-body text-paper placeholder:text-dim", className)} {...rest} />;
}
