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

const dropHints = { target: "▾ Drop here", origin: "● Current", reorder: "↕ Reorder", blocked: "✕ Not allowed" };

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

function Spike() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 40" className="archive-spike h-10 w-6 shrink-0 origin-bottom fill-current">
      <path d="M12 0C12.4 8 13.2 19 13.8 31H10.2C10.8 19 11.6 8 12 0Z" />
      <path d="M2 39C2 33.5 6.5 30 12 30S22 33.5 22 39Z" />
    </svg>
  );
}

export function ArchiveZone({ armed, over, className, ...rest }: ComponentPropsWithRef<"div"> & { armed: boolean; over: boolean }) {
  return (
    <div
      data-armed={armed ? "true" : undefined}
      data-over={over ? "true" : undefined}
      className={cn(
        "archive-zone mt-2 flex min-h-20 items-center justify-center gap-4 border-2 border-dashed border-dim px-4 py-5 text-center text-label tracking-label text-dim uppercase data-armed:border-paper data-armed:text-paper data-over:border-amber data-over:bg-amber/10 data-over:font-bold data-over:text-amber",
        className,
      )}
      {...rest}
    >
      <Spike />
      {over ? "Yes! Let go to archive it" : armed ? "Toss it on the spike!" : "The spike · drag a slip here to archive it"}
      <Spike />
    </div>
  );
}
