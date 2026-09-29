import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { collectionQuery, fullPageReturnPath, navigate, ticketDetailPath, openTicketFullPage, openTicketModal, setArchivedFilter, setBadgeFilter, useArchivedFilter, useBadgeFilter, useRoute } from "./router";

function RouteProbe() {
  const route = useRoute();
  const badgeIds = useBadgeFilter();
  const archived = useArchivedFilter();
  return (
    <><p data-testid="route">{route.name === "ticket-detail" ? `ticket-detail:${route.ticketId}:${route.background ?? "page"}` : route.name}</p><p data-testid="filter">{badgeIds.join(",")}</p><p data-testid="archived">{String(archived)}</p></>
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

    expect(screen.getByTestId("route")).toHaveTextContent("ticket-detail:abc-123:page");
  });

  it("reads /board on direct load and reacts to navigation back to it", () => {
    window.history.pushState({}, "", "/board");
    render(<RouteProbe />);
    expect(screen.getByTestId("route")).toHaveTextContent("board");

    act(() => navigate("/"));
    expect(screen.getByTestId("route")).toHaveTextContent("backlog");
    act(() => {
      window.history.pushState({}, "", "/board");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByTestId("route")).toHaveTextContent("board");
  });

  it("falls back to the Backlog route for any other path", () => {
    window.history.pushState({}, "", "/something-unknown");

    render(<RouteProbe />);

    expect(screen.getByTestId("route")).toHaveTextContent("backlog");
  });

  it("does not crash on a ticket URL with malformed percent encoding", () => {
    window.history.pushState({}, "", "/tickets/%E0%A4%A");

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
    expect(screen.getByTestId("route")).toHaveTextContent("ticket-detail:xyz-789:page");
  });

  it("reacts to browser back/forward (a real popstate event), not only navigate()", () => {
    window.history.pushState({}, "", "/");
    render(<RouteProbe />);

    act(() => {
      window.history.pushState({}, "", "/tickets/back-forward-test");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(screen.getByTestId("route")).toHaveTextContent("ticket-detail:back-forward-test:page");
  });

  it("openTicketModal() keeps the canonical Ticket URL and records the view underneath", () => {
    window.history.pushState({}, "", "/board");
    render(<RouteProbe />);

    act(() => openTicketModal("a/b", "board"));

    expect(window.location.pathname).toBe("/tickets/a%2Fb");
    expect(screen.getByTestId("route")).toHaveTextContent("ticket-detail:a/b:board");
  });

  it("ignores modal history state written by an earlier page load", () => {
    window.history.pushState({ ticketModal: { pageLoadId: "earlier-load", background: "backlog" } }, "", "/tickets/abc-123");

    render(<RouteProbe />);

    expect(screen.getByTestId("route")).toHaveTextContent("ticket-detail:abc-123:page");
  });

  it("openTicketFullPage() replaces the modal entry with the full page", () => {
    window.history.pushState({}, "", "/");
    render(<RouteProbe />);
    act(() => openTicketModal("abc-123", "backlog"));
    const length = window.history.length;

    act(() => openTicketFullPage("abc-123"));

    expect(window.history.length).toBe(length);
    expect(screen.getByTestId("route")).toHaveTextContent("ticket-detail:abc-123:page");
  });

  it("keeps the origin view for Archive after opening full-page detail from the board", () => {
    window.history.pushState({}, "", "/board");
    render(<RouteProbe />);
    act(() => openTicketModal("abc-123", "board"));
    act(() => openTicketFullPage("abc-123"));
    expect(fullPageReturnPath()).toBe("/board");
  });

  it("keeps the Board origin and Badge filter for a detail URL opened in a new tab", () => {
    window.history.pushState({}, "", "/board?badgeId=first");
    const href = ticketDetailPath("abc-123", "board");
    window.history.pushState(null, "", href);

    expect(href).toBe("/tickets/abc-123?badgeId=first&from=board");
    expect(fullPageReturnPath()).toBe("/board?badgeId=first");
    expect(collectionQuery()).toBe("?badgeId=first");
  });

  it("returns a direct detail URL without an origin to the Backlog", () => {
    window.history.pushState(null, "", "/tickets/abc-123?badgeId=first");

    expect(fullPageReturnPath()).toBe("/?badgeId=first");
  });

  it("returns a full-page Archived detail to the Archived list with its Badges", () => {
    window.history.pushState({}, "", "/?badgeId=first&archived=true");
    const href = ticketDetailPath("abc-123", "backlog");
    window.history.pushState(null, "", href);

    expect(href).toBe("/tickets/abc-123?badgeId=first&archived=true");
    expect(fullPageReturnPath()).toBe("/?badgeId=first&archived=true");
  });

  it("keeps selected Badges across modal navigation and reacts to query changes", () => {
    window.history.pushState({}, "", "/?badgeId=first");
    render(<RouteProbe />);
    expect(screen.getByTestId("filter")).toHaveTextContent("first");
    act(() => setBadgeFilter(["first", "second"]));
    expect(screen.getByTestId("filter")).toHaveTextContent("first,second");
    act(() => openTicketModal("id", "backlog"));
    expect(window.location.search).toBe("?badgeId=first&badgeId=second");
    expect(screen.getByTestId("filter")).toHaveTextContent("first,second");
  });

  it("preserves Badge selection when toggling Archived and keeps it across a modal", () => {
    window.history.pushState({}, "", "/?badgeId=first");
    render(<RouteProbe />);
    act(() => setArchivedFilter(true));
    expect(window.location.search).toBe("?badgeId=first&archived=true");
    expect(screen.getByTestId("archived")).toHaveTextContent("true");
    act(() => openTicketModal("id", "backlog"));
    expect(screen.getByTestId("archived")).toHaveTextContent("true");
    act(() => setArchivedFilter(false));
    expect(window.location.search).toBe("?badgeId=first");
  });
});
