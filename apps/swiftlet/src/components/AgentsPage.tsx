import { useCallback, useEffect, useRef, useState } from "react";
import { AGENT_KINDS, AGENT_NAME_MAX_LENGTH, createAgent, fetchAgents, renameAgent, type Agent, type AgentKind } from "../api/agents";
import { UnauthenticatedError } from "../api/session";
import { RunnerSection } from "./RunnerSection";
import { Caption, EmptyMessage, ErrorMessage, FieldHint, FieldLabel, LoadingMessage, LogRow, LogRowMain, Paper, PrimaryButton, ReceiptTitle, Rule, SecondaryButton, Select, TextInput } from "./ui";

export function agentKindLabel(kind: AgentKind): string {
  return kind === "coding" ? "Coding" : "Research";
}

type ListState =
  | { kind: "loading" }
  | { kind: "loaded"; agents: Agent[]; reloadError?: string }
  | { kind: "error"; message: string };

export function AgentsPage({ onUnauthenticated }: { onUnauthenticated: () => void }) {
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const mounted = useRef(true);

  const failed = useCallback((error: unknown, fallback: string): string => {
    if (error instanceof UnauthenticatedError) onUnauthenticated();
    return error instanceof Error ? error.message : fallback;
  }, [onUnauthenticated]);

  const load = useCallback(async () => {
    try {
      const agents = await fetchAgents();
      if (mounted.current) setState({ kind: "loaded", agents });
    } catch (error) {
      const message = failed(error, "Unknown error loading Agents.");
      if (mounted.current) {
        setState((current) => current.kind === "loaded" ? { ...current, reloadError: message } : { kind: "error", message });
      }
    }
  }, [failed]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  return (
    <div className="mx-auto flex max-w-(--size-log) flex-col gap-6">
      <CreateAgentForm onCreated={load} onFailed={failed} />
      <Paper as="section" aria-labelledby="agents-title" data-testid="agent-list" className="p-5 sm:p-6">
        <ReceiptTitle id="agents-title">Agents</ReceiptTitle>
        <Rule weight="thick" />
        {state.kind === "loading" && <LoadingMessage flat data-testid="agent-list-loading">Loading Agents…</LoadingMessage>}
        {state.kind === "error" && (
          <ErrorMessage flat title="Unable to load Agents." data-testid="agent-list-error">
            <p className="m-0">{state.message}</p>
          </ErrorMessage>
        )}
        {state.kind === "loaded" && state.reloadError && (
          <ErrorMessage flat title="Unable to refresh Agents; this list may be out of date." data-testid="agent-list-reload-error">
            <p className="m-0">{state.reloadError}</p>
          </ErrorMessage>
        )}
        {state.kind === "loaded" && state.agents.length === 0 && (
          <EmptyMessage flat data-testid="agent-list-empty">No Agents yet. Create your first one above.</EmptyMessage>
        )}
        {state.kind === "loaded" && state.agents.length > 0 && (
          <ul className="m-0 list-none p-0">
            {state.agents.map((agent) => <AgentRow key={agent.id} agent={agent} onRenamed={load} onFailed={failed} />)}
          </ul>
        )}
      </Paper>
      <RunnerSection onUnauthenticated={onUnauthenticated} onFailed={failed} />
    </div>
  );
}

function CreateAgentForm({ onCreated, onFailed }: { onCreated: () => Promise<void>; onFailed: (error: unknown, fallback: string) => string }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AgentKind>("research");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await createAgent(name, kind);
      setName("");
      await onCreated();
    } catch (cause) {
      setError(onFailed(cause, "Failed to create the Agent."));
    } finally {
      setPending(false);
    }
  }

  return (
    <Paper as="section" aria-labelledby="new-agent-title" className="p-5 sm:p-6">
      <form data-testid="agent-create-form" onSubmit={submit} className="flex flex-col gap-3">
      <FieldLabel as="h2" id="new-agent-title">New Agent</FieldLabel>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-[2_1_12rem]">
          <FieldLabel htmlFor="agent-name-input">Name</FieldLabel>
          <TextInput id="agent-name-input" data-testid="agent-name-input" value={name} maxLength={AGENT_NAME_MAX_LENGTH} autoComplete="off" onChange={(event) => setName(event.target.value)} disabled={pending} />
        </div>
        <div className="min-w-36 flex-[1_1_8rem]">
          <FieldLabel htmlFor="agent-kind-select">Kind</FieldLabel>
          <Select id="agent-kind-select" data-testid="agent-kind-select" aria-describedby="agent-kind-hint" value={kind} onChange={(event) => setKind(event.target.value as AgentKind)} disabled={pending}>
            {AGENT_KINDS.map((option) => <option key={option} value={option}>{agentKindLabel(option)}</option>)}
          </Select>
        </div>
        <PrimaryButton type="submit" data-testid="agent-create-button" disabled={pending} className="max-sm:w-full">Create Agent</PrimaryButton>
      </div>
      <FieldHint id="agent-kind-hint" className="m-0">Kind is fixed once the Agent is created.</FieldHint>
      {error && (
        <ErrorMessage flat title="Could not create the Agent.">
          <p data-testid="agent-create-error" className="m-0">{error}</p>
        </ErrorMessage>
      )}
      </form>
    </Paper>
  );
}

function AgentRow({ agent, onRenamed, onFailed }: { agent: Agent; onRenamed: () => Promise<void>; onFailed: (error: unknown, fallback: string) => string }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(agent.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const renameButton = useRef<HTMLButtonElement>(null);
  const inputId = `agent-rename-${agent.id}`;

  function startEditing() {
    setName(agent.name);
    setError(null);
    setEditing(true);
  }

  function stopEditing() {
    setEditing(false);
    setError(null);
    requestAnimationFrame(() => renameButton.current?.focus());
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await renameAgent(agent.id, name);
      stopEditing();
      await onRenamed();
    } catch (cause) {
      setError(onFailed(cause, "Failed to rename the Agent."));
    } finally {
      setPending(false);
    }
  }

  return (
    <LogRow data-testid={`agent-row-${agent.id}`}>
      {editing ? (
        <form onSubmit={submit} onKeyDown={(event) => { if (event.key === "Escape") stopEditing(); }} className="flex flex-[1_1_100%] flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1">
            <FieldLabel htmlFor={inputId}>New name for {agent.name}</FieldLabel>
            <TextInput id={inputId} data-testid="agent-rename-input" value={name} maxLength={AGENT_NAME_MAX_LENGTH} autoComplete="off" autoFocus onChange={(event) => setName(event.target.value)} disabled={pending} />
          </div>
          <PrimaryButton type="submit" data-testid="agent-rename-save" disabled={pending}>Save</PrimaryButton>
          <SecondaryButton data-testid="agent-rename-cancel" onClick={stopEditing} disabled={pending}>Cancel</SecondaryButton>
          {error && (
            <ErrorMessage flat title="Could not rename the Agent." className="basis-full">
              <p data-testid="agent-rename-error" className="m-0">{error}</p>
            </ErrorMessage>
          )}
        </form>
      ) : (
        <>
          <LogRowMain>
            <span data-testid="agent-name" className="min-w-0 font-bold break-words">{agent.name}</span>
          </LogRowMain>
          <Caption as="span" data-testid="agent-kind">{agentKindLabel(agent.kind)}</Caption>
          <SecondaryButton ref={renameButton} size="sm" data-testid="agent-rename-button" aria-label={`Rename ${agent.name}`} onClick={startEditing}>Rename</SecondaryButton>
        </>
      )}
    </LogRow>
  );
}
