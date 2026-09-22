import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { navigate } from "../router";

interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string;
}

/**
 * A same-app navigation link: a real <a href> (so middle-click, ctrl/
 * cmd-click, and "open in new tab" keep working exactly as a browser
 * expects) that otherwise navigates client-side via router.navigate()
 * instead of a full page load.
 */
export function Link({ to, onClick, children, ...rest }: LinkProps) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    navigate(to);
  }

  return (
    <a href={to} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
