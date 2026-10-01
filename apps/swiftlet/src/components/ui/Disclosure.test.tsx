import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Disclosure } from "./Disclosure";

afterEach(cleanup);

const details = () => screen.getByTestId("disclosure") as HTMLDetailsElement;

function renderDisclosure(defaultOpen: boolean) {
  const element = (open: boolean) => (
    <Disclosure data-testid="disclosure" summary="Round 1" defaultOpen={open}>
      <p>Body</p>
    </Disclosure>
  );
  const view = render(element(defaultOpen));
  return (open: boolean) => view.rerender(element(open));
}

describe("Disclosure", () => {
  it("starts open or closed as defaultOpen says", () => {
    renderDisclosure(true);
    expect(details().open).toBe(true);
    cleanup();
    renderDisclosure(false);
    expect(details().open).toBe(false);
  });

  it("opens from its summary, which is a keyboard-operable control", () => {
    renderDisclosure(false);
    const summary = screen.getByText("Round 1");
    expect(summary.tagName).toBe("SUMMARY");
    fireEvent.click(summary);
    expect(details().open).toBe(true);
  });

  it("keeps the reader's own toggling across re-renders with the same defaultOpen", () => {
    const rerender = renderDisclosure(false);
    fireEvent.click(screen.getByText("Round 1"));
    rerender(false);
    expect(details().open).toBe(true);
  });

  it("follows defaultOpen when it changes", () => {
    const rerender = renderDisclosure(true);
    rerender(false);
    expect(details().open).toBe(false);
  });
});
