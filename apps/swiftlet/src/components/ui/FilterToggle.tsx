import type { ComponentPropsWithRef } from "react";
import { cx } from "./cx";
import type { ButtonTone } from "./Button";

type FilterToggleProps = Omit<ComponentPropsWithRef<"input">, "type"> & { tone?: ButtonTone };

export function FilterToggle({ tone = "paper", className, children, ...rest }: FilterToggleProps) {
  const ground = tone === "ground";
  return (
    <label
      className={cx(
        "relative m-0 inline-flex cursor-pointer items-center px-2 py-1 text-label tracking-label uppercase ring-1 has-checked:font-bold has-checked:before:mr-1 has-checked:before:content-['✓'] has-focus-visible:outline-2 has-focus-visible:outline-offset-2",
        ground
          ? "text-dim ring-dim hover:text-paper has-checked:bg-paper has-checked:text-ink has-checked:ring-paper has-focus-visible:outline-amber"
          : "text-muted ring-ink hover:text-ink has-checked:bg-ink has-checked:text-paper has-focus-visible:outline-ink",
      )}
    >
      <input type="checkbox" className={cx("absolute inset-0 m-0 size-full cursor-pointer opacity-0", className)} {...rest} />
      {children}
    </label>
  );
}
