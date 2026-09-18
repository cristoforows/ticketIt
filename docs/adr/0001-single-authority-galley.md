# 0001. Single authority in Galley, with a fact-reporting runner and a command-submitting frontend

Status: Accepted
Date: 2026-09-19

## Context

ticketIt has three applications: Swiftlet (React frontend), Galley (Go backend), and Michelin (TypeScript/Node.js local runner). Michelin performs Agent execution through a native harness and managed OpenCode, and connects outward to Galley rather than being reachable by the browser. Swiftlet must not own workflow rules or access the database directly.

The v1 spec (issue #1, "Applications and ownership") states that Galley owns authoritative ticket transitions, Permissions, work eligibility, ownership, and round history; that Swiftlet submits owner commands; and that Michelin requests work and reports execution facts. The spec's "Ticket model and contracts" section requires the execution interface to cover registration/health, claiming, progress/results/usage, questions/permissions, stop, and reconciliation, without freezing payload schemas. Issue #2 (M1) requires establishing this ownership and the associated contracts before any execution feature is built. The implementation plan's "Proposed boundaries and records" section states plainly: "Galley alone changes authoritative domain records. Michelin reports facts and requests actions; Swiftlet renders state and submits owner commands. Framework checkpoints and engine histories are execution records, not substitutes for the application's state machine."

Without an explicit rule, it would be tempting to let Michelin set Ticket status directly (it is closest to the actual execution) or let Swiftlet talk to Michelin directly for lower latency. Both would create two writers of ticket state and two sources of truth for execution status, which breaks the replay/idempotency and disconnect-safety guarantees required elsewhere in the spec.

## Decision

Galley is the sole owner and mutator of authoritative records: Ticket Status, Round outcome, Permission grants, and usage observations.

Michelin only reports execution facts and requests actions, through the events and pulled commands defined in [docs/contracts/execution-interface.md](../contracts/execution-interface.md). It never sets Ticket status directly; Galley's state machine interprets Michelin's facts and decides the resulting Status and Round outcome.

Swiftlet only submits owner commands to Galley and renders the state Galley returns. It never talks to Michelin directly, and never accesses the database or mutates domain records itself.

## Consequences

- Ticket/Round state has exactly one writer, which makes replay-safety, fencing, and disconnect handling tractable to reason about.
- Engine-internal state (LangGraph checkpoints, OpenCode sessions) stays a Michelin-side execution detail; it can be replaced or restarted without changing ticketIt's state machine.
- Michelin cannot act unilaterally during a network partition; it must wait for Galley's authoritative response even when it has direct knowledge of execution state. This is accepted as the cost of a single source of truth, and is why the disconnect rule treats lost contact as "not proven stopped" rather than assuming any particular outcome.
- Swiftlet cannot show true real-time execution detail without Galley relaying it; all execution visibility is mediated by Galley.
- Future remote runners or additional engines can be added without changing this boundary, since neither Swiftlet nor any engine is ever a second authority.

## References

- v1 spec ([issue #1](https://github.com/cristoforows/ticketIt/issues/1)), sections "Applications and ownership" and "Ticket model and contracts."
- [M1 milestone (issue #2)](https://github.com/cristoforows/ticketIt/issues/2), "Establish ownership across Swiftlet, Galley, and Michelin."
- [M1.1 (issue #12)](https://github.com/cristoforows/ticketIt/issues/12), "Ownership statement."
- [implementation-plan.md](../implementation-plan.md), "Proposed boundaries and records."
- [docs/contracts/execution-interface.md](../contracts/execution-interface.md).
