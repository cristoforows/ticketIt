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

const slipTilts = [-4, 3, -2, 5, -3, 2, -5, 4, -1];
const slipShifts = [0, 0.6, -0.5, 0.4, -0.7, 0.3, -0.4, 0.5, -0.2];
const slipStripes = ["fill-status-ready", "fill-status-in-progress", "fill-status-in-review"];

function Spike({ slips }: { slips: number }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 40" className="archive-spike h-10 w-6 shrink-0 origin-bottom fill-current">
      <path d="M12 0C12.4 8 13.2 19 13.8 31H10.2C10.8 19 11.6 8 12 0Z" />
      <path d="M2 39C2 33.5 6.5 30 12 30S22 33.5 22 39Z" />
      {slipTilts.slice(0, slips).map((tilt, index) => {
        const y = 28.6 - index * 1.5;
        return (
          <g key={index} transform={`rotate(${tilt} 12 ${y + 0.65})`} className="stroke-ground" strokeWidth=".25">
            <rect x={4 + slipShifts[index]} y={y} width="16" height="1.3" className="fill-paper" />
            <rect x={4 + slipShifts[index]} y={y} width="16" height=".4" className={slipStripes[index % slipStripes.length]} stroke="none" />
          </g>
        );
      })}
    </svg>
  );
}

export function ArchiveZone({ over, className, ...rest }: ComponentPropsWithRef<"div"> & { over: boolean }) {
  return (
    <div
      data-over={over ? "true" : undefined}
      className={cn(
        "archive-zone fixed inset-x-0 bottom-4 z-30 mx-auto flex w-fit items-end justify-center gap-4 px-10 pt-8 pb-2 text-center text-label tracking-label text-paper uppercase data-over:font-bold data-over:text-amber",
        className,
      )}
      {...rest}
    >
      <Spike slips={6} />
      {over ? "Yes! Let go to archive it" : "Toss it on the spike!"}
      <Spike slips={9} />
    </div>
  );
}
