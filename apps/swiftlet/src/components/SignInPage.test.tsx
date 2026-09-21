import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SignInPage } from "./SignInPage";

describe("SignInPage", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a single action that starts Galley's GitHub OAuth flow", () => {
    render(<SignInPage />);

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/api/auth/github/start");
    expect(links[0]).toHaveAccessibleName(/sign in with github/i);
  });
});
