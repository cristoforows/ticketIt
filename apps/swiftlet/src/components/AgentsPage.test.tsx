import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AgentsPage } from "./AgentsPage";

type MockResponse = Pick<Response, "ok" | "status" | "statusText" | "json">;

function jsonResponse(body: unknown, status = 200, statusText = ""): MockResponse {
  return { ok: status >= 200 && status < 300, status, statusText, json: async () => body };
}

const ATLAS = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "atlas", kind: "research", createdAt: "2026-09-30T10:00:00Z" };
const BUILDER = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Builder", kind: "coding", createdAt: "2026-09-30T10:00:00Z" };

type Route = (init?: RequestInit) => MockResponse;

function stubGalley(routes: Record<string, Route>) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const route = routes[`${init?.method ?? "GET"} ${String(input)}`];
    if (!route) throw new Error(`unexpected fetch to ${init?.method ?? "GET"} ${String(input)}`);
    return Promise.resolve(route(init));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function rowNames(): string[] {
  return screen.getAllByTestId("agent-name").map((name) => name.textContent ?? "");
}

describe("AgentsPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists Galley's Agents in its order with their kind", async () => {
    stubGalley({ "GET /api/agents": () => jsonResponse({ agents: [ATLAS, BUILDER] }) });

    render(<AgentsPage onUnauthenticated={() => {}} />);

    await screen.findByTestId(`agent-row-${ATLAS.id}`);
    expect(rowNames()).toEqual(["atlas", "Builder"]);
    expect(within(screen.getByTestId(`agent-row-${ATLAS.id}`)).getByTestId("agent-kind")).toHaveTextContent("Research");
    expect(within(screen.getByTestId(`agent-row-${BUILDER.id}`)).getByTestId("agent-kind")).toHaveTextContent("Coding");
  });

  it("shows an empty state, and an error state when loading fails", async () => {
    stubGalley({ "GET /api/agents": () => jsonResponse({ agents: [] }) });
    render(<AgentsPage onUnauthenticated={() => {}} />);
    expect(await screen.findByTestId("agent-list-empty")).toBeInTheDocument();
    cleanup();

    stubGalley({ "GET /api/agents": () => jsonResponse({ error: { code: "database_unavailable", message: "failed to read agents" } }, 503) });
    render(<AgentsPage onUnauthenticated={() => {}} />);
    expect(await screen.findByTestId("agent-list-error")).toHaveTextContent("failed to read agents");
  });

  it("returns to sign-in on a 401", async () => {
    stubGalley({ "GET /api/agents": () => jsonResponse({ error: { code: "unauthenticated", message: "sign-in required" } }, 401) });
    const onUnauthenticated = vi.fn();

    render(<AgentsPage onUnauthenticated={onUnauthenticated} />);

    await waitFor(() => expect(onUnauthenticated).toHaveBeenCalled());
  });

  it("creates an Agent with a labelled name and kind, then shows Galley's refreshed list", async () => {
    let agents = [ATLAS];
    const fetchMock = stubGalley({
      "GET /api/agents": () => jsonResponse({ agents }),
      "POST /api/agents": () => {
        agents = [ATLAS, BUILDER];
        return jsonResponse(BUILDER, 201);
      },
    });
    render(<AgentsPage onUnauthenticated={() => {}} />);
    await screen.findByTestId(`agent-row-${ATLAS.id}`);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Builder" } });
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "coding" } });
    expect(screen.getByLabelText("Kind")).toHaveAccessibleDescription("Kind is fixed once the Agent is created.");
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    await screen.findByTestId(`agent-row-${BUILDER.id}`);
    expect(rowNames()).toEqual(["atlas", "Builder"]);
    expect(screen.getByLabelText("Name")).toHaveValue("");
    expect(fetchMock).toHaveBeenCalledWith("/api/agents", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ name: "Builder", kind: "coding" }),
    }));
  });

  it("shows Galley's duplicate-name rejection and keeps the typed name", async () => {
    stubGalley({
      "GET /api/agents": () => jsonResponse({ agents: [ATLAS] }),
      "POST /api/agents": () => jsonResponse({ error: { code: "duplicate_agent_name", message: "an agent with that name already exists" } }, 409),
    });
    render(<AgentsPage onUnauthenticated={() => {}} />);
    await screen.findByTestId(`agent-row-${ATLAS.id}`);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "ATLAS" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    expect(await screen.findByTestId("agent-create-error")).toHaveTextContent("an agent with that name already exists");
    expect(screen.getByLabelText("Name")).toHaveValue("ATLAS");
    expect(rowNames()).toEqual(["atlas"]);
  });

  it("renames an Agent through PATCH without sending its kind, then shows Galley's refreshed list", async () => {
    let agents = [ATLAS];
    const fetchMock = stubGalley({
      "GET /api/agents": () => jsonResponse({ agents }),
      [`PATCH /api/agents/${ATLAS.id}`]: () => {
        agents = [{ ...ATLAS, name: "Atlas Prime" }];
        return jsonResponse(agents[0]);
      },
    });
    render(<AgentsPage onUnauthenticated={() => {}} />);
    await screen.findByTestId(`agent-row-${ATLAS.id}`);

    fireEvent.click(screen.getByRole("button", { name: "Rename atlas" }));
    const input = screen.getByLabelText("New name for atlas");
    expect(input).toHaveFocus();
    expect(input).toHaveValue("atlas");
    fireEvent.change(input, { target: { value: "Atlas Prime" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(rowNames()).toEqual(["Atlas Prime"]));
    expect(within(screen.getByTestId(`agent-row-${ATLAS.id}`)).getByTestId("agent-kind")).toHaveTextContent("Research");
    expect(fetchMock).toHaveBeenCalledWith(`/api/agents/${ATLAS.id}`, expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ name: "Atlas Prime" }),
    }));
  });

  it("keeps the rename form open with Galley's rejection", async () => {
    stubGalley({
      "GET /api/agents": () => jsonResponse({ agents: [ATLAS, BUILDER] }),
      [`PATCH /api/agents/${ATLAS.id}`]: () => jsonResponse({ error: { code: "duplicate_agent_name", message: "an agent with that name already exists" } }, 409),
    });
    render(<AgentsPage onUnauthenticated={() => {}} />);
    await screen.findByTestId(`agent-row-${ATLAS.id}`);

    fireEvent.click(screen.getByRole("button", { name: "Rename atlas" }));
    fireEvent.change(screen.getByLabelText("New name for atlas"), { target: { value: "builder" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByTestId("agent-rename-error")).toHaveTextContent("an agent with that name already exists");
    expect(screen.getByLabelText("New name for atlas")).toHaveValue("builder");
  });

  it("cancels a rename with Escape and returns focus to the Rename button", async () => {
    stubGalley({ "GET /api/agents": () => jsonResponse({ agents: [ATLAS] }) });
    render(<AgentsPage onUnauthenticated={() => {}} />);
    await screen.findByTestId(`agent-row-${ATLAS.id}`);

    fireEvent.click(screen.getByRole("button", { name: "Rename atlas" }));
    fireEvent.change(screen.getByLabelText("New name for atlas"), { target: { value: "discarded" } });
    fireEvent.keyDown(screen.getByLabelText("New name for atlas"), { key: "Escape" });

    expect(screen.queryByLabelText("New name for atlas")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Rename atlas" })).toHaveFocus());
    expect(rowNames()).toEqual(["atlas"]);
  });
});
