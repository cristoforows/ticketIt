import type { ComponentPropsWithRef } from "react";
import { cx } from "./cx";

type RuleProps = ComponentPropsWithRef<"hr"> & { weight?: "thin" | "thick" };

export function Rule({ weight = "thin", className, ...rest }: RuleProps) {
  return (
    <hr
      className={cx(
        "my-3 border-0 border-t border-dashed border-rule",
        weight === "thick" && "border-t-2",
        className,
      )}
      {...rest}
    />
  );
}
