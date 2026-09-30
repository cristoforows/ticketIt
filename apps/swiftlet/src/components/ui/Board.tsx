import type { ComponentPropsWithRef } from "react";
import { cn } from "./cn";

export function BoardColumns({ className, ...rest }: ComponentPropsWithRef<"div">) {
  return (
    <div
      className={cn(
        "scroll-hint grid grid-flow-col auto-cols-[minmax(10rem,1fr)] gap-3 overflow-x-auto px-1 pt-3 pb-6 max-md:snap-x max-md:snap-mandatory max-md:auto-cols-[100%]",
        className,
      )}
      {...rest}
    />
  );
}

export function BoardColumn({ className, ...rest }: ComponentPropsWithRef<"section">) {
  return (
    <section
      className={cn(
        "group/stage flex min-w-0 flex-col p-2 max-md:snap-start data-drop-target:bg-paper/10 data-drop-target:outline-2 data-drop-target:-outline-offset-2 data-drop-target:outline-(--status-text) data-drop-target:outline-dashed",
        className,
      )}
      {...rest}
    />
  );
}

export function ColumnHeader({ id, label, count }: { id: string; label: string; count: number }) {
  return (
    <div className="flex items-center justify-between border-b-2 border-(--status) pb-2 max-md:sr-only">
      <h3 id={id} className="text-label font-bold tracking-label text-(--status-text) uppercase">{label}</h3>
      <span aria-hidden="true" className="grid size-6 place-items-center rounded-pill bg-(--status-text) text-label font-bold text-ground">{count}</span>
    </div>
  );
}

const dropHints = { target: "▾ Drop here", origin: "● Current", blocked: "✕ Not allowed" };

export function DropHint({ hint }: { hint?: keyof typeof dropHints }) {
  return (
    <p
      aria-hidden="true"
      className="mt-2 min-h-4 text-center text-label tracking-label text-dim uppercase group-data-drop-target/stage:font-bold group-data-drop-target/stage:text-(--status-text) max-md:hidden"
    >
      {hint && dropHints[hint]}
    </p>
  );
}

export function Rail() {
  return <div aria-hidden="true" className="mt-4 h-2 rounded-pill bg-linear-to-b from-rail to-rail-shade shadow-inner group-data-drop-blocked/stage:opacity-40" />;
}

export function SlipList({ className, ...rest }: ComponentPropsWithRef<"ul">) {
  return <ul className={cn("-mt-3 flex flex-col gap-4 px-1 group-data-drop-blocked/stage:opacity-40", className)} {...rest} />;
}
