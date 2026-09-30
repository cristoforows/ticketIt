import type { ComponentProps } from "react";
import { Link } from "../Link";
import { cn } from "./cn";

export function NavTab({ current, className, ...rest }: Omit<ComponentProps<typeof Link>, "aria-current"> & { current: boolean }) {
  return (
    <Link
      aria-current={current ? "page" : undefined}
      className={cn(
        "px-3 py-1.5 text-label font-bold tracking-label text-dim uppercase no-underline ring-1 ring-dim hover:text-paper aria-[current=page]:bg-amber aria-[current=page]:text-ink aria-[current=page]:ring-amber",
        className,
      )}
      {...rest}
    />
  );
}
