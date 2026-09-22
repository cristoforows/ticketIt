import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { navigate, useRoute } from "./router";

function RouteProbe() {
  const route = useRoute();
  return (
    <p data-testid="route">
      {route.name === "backlog" ? "backlog" : `ticket-detail:${route.ticketId}`}
    </p>
  );
}

describe("router", () => {
  afterEach(() => {
    cleanup();
    window.history.pushState({}, "", "/");
  });

  it("reads the Backlog route from the current path", () => {
    window.history.pushState({}, "", "/");

    render(<RouteProbe />);

    expect(screen.getByTestId("route")).toHaveTextContent("backlog");
  });

  it("reads a Ticket detail route, including its id, from the current path", () => {
    window.history.pushState({}, "", "/tickets/abc-123");

    render(<RouteProbe />);

    expect(screen.getByTestId("route")).toHaveTextContent("ticket-detail:abc-123");
  });

  it("falls back to the Backlog route for any other path", () => {
    window.history.pushState({}, "", "/something-unknown");

    render(<RouteProbe />);

    expect(screen.getByTestId("route")).toHaveTextContent("backlog");
  });

  it("navigate() updates the URL and re-renders every subscriber, without a full page load", () => {
    window.history.pushState({}, "", "/");
    render(<RouteProbe />);
    expect(screen.getByTestId("route")).toHaveTextContent("backlog");

    act(() => {
      navigate("/tickets/xyz-789");
    });

    expect(window.location.pathname).toBe("/tickets/xyz-789");
    expect(screen.getByTestId("route")).toHaveTextContent("ticket-detail:xyz-789");
  });

  it("reacts to browser back/forward (a real popstate event), not only navigate()", () => {
    window.history.pushState({}, "", "/");
    render(<RouteProbe />);

    act(() => {
      window.history.pushState({}, "", "/tickets/back-forward-test");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(screen.getByTestId("route")).toHaveTextContent("ticket-detail:back-forward-test");
  });
});
