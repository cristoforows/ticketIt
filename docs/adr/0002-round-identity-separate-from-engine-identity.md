# 0002. Round identity separate from engine session/thread identity

Status: Accepted
Date: 2026-09-19

## Context

ticketIt executes Agent work through two engines: a native LangChain/LangGraph harness for research, and a headless OpenCode process for coding, both supervised by Michelin. Each engine has its own notion of a unit of work: an OpenCode session ID, or a LangGraph thread ID. ticketIt's own unit of Agent work is the Round, defined in [CONTEXT.md](../../CONTEXT.md) as "one period of an Agent working on a Ticket, with its own activity, result, and usage."

The v1 spec (issue #1, "Ticket model and contracts") states: "Keep external engine session/thread identifiers separate from ticketIt round identity." [integration-feasibility.md](../integration-feasibility.md) reaches the same conclusion from the adapter side: "A ticketIt round, OpenCode session, and LangGraph thread have distinct identities and lifecycles," and warns that "no selected library replaces ticket ownership checks, round accounting, human review, or idempotent side-effect handling." If Round identity were the engine's session/thread ID, ticketIt's lifecycle would be at the mercy of each engine's own resume/restart semantics, which differ between engines and are not guaranteed to align with ticketIt's Waiting for Input, Stop, Failed, or Interrupted outcomes.

## Decision

A Round ID is issued and owned by Galley, independent of any engine identifier. An engine execution reference (OpenCode session ID or LangGraph thread ID) is a separate record attached to a Round, not the Round itself.

A Round has at most one current engine execution reference at a time. A new reference can become current only when reattachment is explicitly authorized (for example, recovery routed through D5); the prior reference is retained in history but stops being current.

Engine execution references never drive Ticket status. Only the Galley-interpreted events defined in [docs/contracts/execution-interface.md](../contracts/execution-interface.md) change Status or Round outcome; the mere existence, absence, or internal state of an engine session or thread proves nothing by itself.

## Consequences

- Michelin can restart, reconnect, or replace the underlying engine session/thread without redefining what a Round is or losing Round history.
- ticketIt's lifecycle (Waiting for Input, Stopped, Failed, Interrupted) is defined once, in Galley, instead of being reimplemented per engine or inferred from framework-specific checkpoint state.
- Supports future engines and future remote runners without changing Round semantics, since a Round's identity never depends on which engine or process produced it.
- Requires an explicit attach/reattach step and reconciliation logic whenever the current engine reference changes; this contract states the "at most one current reference" rule but does not itself design the reattachment mechanism for a stranded claim, which is routed to D5.

## References

- v1 spec ([issue #1](https://github.com/cristoforows/ticketIt/issues/1)), section "Ticket model and contracts."
- [M1.1 (issue #12)](https://github.com/cristoforows/ticketIt/issues/12), "Identity model."
- [CONTEXT.md](../../CONTEXT.md), glossary entry for Round.
- [integration-feasibility.md](../integration-feasibility.md), "Interpretation for ticketIt."
- [docs/contracts/execution-interface.md](../contracts/execution-interface.md), "Identity model."
