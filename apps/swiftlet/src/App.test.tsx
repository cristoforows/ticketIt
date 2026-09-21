import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import App from "./App";

describe("App", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the Swiftlet heading and delegates status rendering to StatusView", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(new Promise(() => {})),
    );

    render(<App />);

    expect(screen.getByRole("heading", { name: "Swiftlet" })).toBeInTheDocument();
    expect(screen.getByTestId("status-loading")).toBeInTheDocument();
  });
});
