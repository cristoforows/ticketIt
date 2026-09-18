# Execution interface contract

Status: describes intended behavior for the M4+ execution interface, agreed during M1. Not a frozen payload schema, not a transport choice, not a provider choice. Those are engineering work for later milestones (see [open-decisions.md](../open-decisions.md)).

This document covers two boundaries:

1. **Galley ↔ Michelin**, the execution interface. Michelin reports execution facts and pulls commands; Galley owns every authoritative decision.
2. **Swiftlet → Galley**, the owner-command boundary. Swiftlet submits owner commands and renders Galley-provided state.

Sources: [v1 spec #1](https://github.com/cristoforows/ticketIt/issues/1) sections "Applications and ownership," "Ticket model and contracts," and "Execution and state transitions"; [v1-scope.md](../v1-scope.md); [implementation-plan.md](../implementation-plan.md) "Proposed boundaries and records"; [agent-execution.md](../agent-execution.md); [deployment.md](../deployment.md); [integration-feasibility.md](../integration-feasibility.md).

## Ownership statement

- **Galley alone mutates authoritative records**: Ticket Status, Round outcome, Permission grants, and usage observations. No other application writes these directly.
- **Michelin never sets Ticket status directly.** It reports execution facts as events. Galley's own state machine interprets those facts and decides the resulting Status and Round outcome.
- **Swiftlet never talks to Michelin.** It submits owner commands to Galley and renders the state Galley returns. There is no direct browser-to-runner channel.
- Engine frameworks (LangGraph checkpoints, OpenCode sessions) hold execution-internal state. That state is not a substitute for Galley's Round record, and it never drives Ticket status on its own.

## Identity model

- **Round ID**: issued by Galley. A Round is ticketIt's unit of Agent work on a Ticket, with its own activity, result, and usage, independent of any engine's internal identifiers.
- **Engine execution reference**: an OpenCode session ID or a LangGraph thread ID. It is a separate record attached to a Round, not the Round itself.
- **At most one current engine execution reference per Round.** A Round can be attached to a new reference only when reattachment is authorized (for example, a stranded-claim recovery under D5). The prior reference is retained for history but stops being current.
- **Engine references never drive Ticket status.** Only Galley-interpreted events (below) change Status or Round outcome. The presence, absence, or internal state of an engine session/thread proves nothing about Ticket status by itself.
- A Round is created by Galley at the moment its work claim is admitted (see "Work claim"), carrying the fencing token from that claim. Creating the Round does not by itself move the Ticket to In Progress; that happens only when Michelin reports the "Execution started" event, so a claimed-but-not-yet-started Round is never falsely shown as running.

## Runner registration and health

- **Register**: Michelin authenticates to Galley and establishes a recognized runner identity before it can claim work, report events, or pull commands. Credential mechanics are routed to engineering decisions (see [open-decisions.md](../open-decisions.md), "Engineering decisions within the approved design").
- **Heartbeat**: Michelin periodically signals liveness to Galley while connected.
- **Disconnect rule**: lost contact never proves execution stopped. When heartbeats stop arriving within the expected window, Galley marks the connection lost, pauses admission of any new supported action for that runner, keeps the affected Ticket locked, and shows a Runner disconnected indicator. This is not a Status transition by itself: a Ticket already In Progress stays In Progress, locked, with the indicator overlaid, until reconciliation determines the outcome.
- Reconnection triggers Reconciliation (below), which alone decides whether the open Round continues or becomes Interrupted.

## Work claim

- **Eligibility**: the Ticket is unarchived, Ready, and Agent-assigned; it has a goal and Success Criteria; capability-specific prerequisites are met (for example, a selected repository for coding work). Concrete Agent/Template compatibility rules are routed to D3.
- **Atomic claim**: Michelin requests eligible work; Galley admits at most one claim per request in a single transaction, issuing a fencing token (claim epoch) and creating the Round record. This prevents two runners, or two claim attempts, from both starting the same Ticket.
- **Sequential scheduling**: one active Round globally across the native and OpenCode engines. A Round that is Waiting for Input keeps its slot; it does not free capacity for another Ticket while paused. Queue ordering among otherwise-eligible Ready Tickets is an engineering decision, not fixed here.
- **Archive-versus-claim race**: archiving and claiming are mutually exclusive under the same transactional guard. If an archive request commits first, the Ticket is no longer eligible and the pending claim is rejected. If a claim already produced an open Round, archiving is rejected until that Round ends, consistent with the requirement that any open Round end before archive.
- **Stranded claim**: if a runner claims work and never returns, editing and archiving still require the Round to end, but the disconnect rule forbids inferring that execution actually stopped. This contract does not invent recovery authority or timeouts for that case; it is explicitly routed to **D5** ("Stranded runner and stop recovery," owned by the M5 milestone). Until D5 resolves it, Galley keeps the Ticket locked with Runner disconnected rather than assuming Interrupted, Failed, or Stopped.

## Events reported by Michelin

Every event is a fact report, not a request for permission. Each carries an idempotency key and the fencing token/claim epoch for the Round it reports on. Galley treats a replayed event (same idempotency key) as a no-op producing no new effect, and rejects an event carrying a fencing token that is not the Round's current claim epoch, without changing any state.

| Event | Direction | Purpose | Required fields (in words) | Idempotency key | Fencing / claim epoch | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| Execution started | Michelin → Galley | Report that the engine has actually begun work for a claimed Round. | Round ID, engine execution reference to attach as current, timestamp. | One key per Round's transition into started. | Must match the Round's current claim epoch. | Ticket moves to In Progress; Round is now open and shown as running. Replay no-op; stale token rejected. |
| Progress | Michelin → Galley | Report incremental activity within an open Round, for display only. | Round ID, a human-readable activity note, timestamp. | One key per reported activity increment (for example, a sequence number). | Must match current claim epoch. | Activity history appended. No Status change. Replay no-op; stale token rejected. |
| Question raised | Michelin → Galley | Report that continuing needs a human answer. | Round ID, the question content, timestamp. | One key per distinct question instance. | Must match current claim epoch. | Round becomes Waiting for Input; Ticket becomes Blocked; the Round keeps its execution slot. Replay no-op (no duplicate pending question); stale token rejected. |
| Permission requested | Michelin → Galley | Report that continuing needs a Permission grant, renewal, or approval. | Round ID, the requested account/action/resource scope, timestamp. | One key per distinct request instance. | Must match current claim epoch. | Round becomes Waiting for Input; Ticket becomes Blocked. Replay no-op; stale token rejected. |
| Delivered | Michelin → Galley | Report the Agent's result is ready for review. | Round ID, deliverable reference(s) (Report or PR/commit reference), a change summary, an assessment against Success Criteria. | One key per delivery. | Must match current claim epoch. | Ticket moves to In Review; the deliverable is retained on the Round. Replay no-op (no duplicate deliverable record); stale token rejected. |
| Failed | Michelin → Galley | Report the Agent cannot complete the work after reasonable attempts. | Round ID, an explanation, references to retained partial work and usage. | One key per Round's Failed transition. | Must match current claim epoch. | Round becomes Failed; Ticket becomes Blocked, retaining the explanation and partial work. Replay no-op; stale token rejected. |
| Stop confirmed | Michelin → Galley | Report that execution actually ceased in response to a Stop, with evidence. | Round ID, evidence that execution stopped, retained partial results and usage. | One key per Round's Stopped transition. | Must match current claim epoch. | Round becomes Stopped; Ticket returns to Backlog with a Stopped Badge, preserving usage, history, and partial results. Replay no-op; stale token rejected. |
| Interrupted | Michelin → Galley | Report that execution actually stopped unexpectedly, not through an owner Stop request. | Round ID, evidence/explanation of the interruption, retained partial work and usage. | One key per Round's Interrupted transition. | Must match the last known claim epoch being closed out. | Round becomes Interrupted; Ticket becomes Blocked; explicit recovery (a new Round after return to Ready) is required. Replay no-op; stale token rejected. |
| Usage observation | Michelin → Galley | Report AI usage (tokens, cost, active time) attributable to the Round. | Round ID, provider/model, the observed figures, whether reported or estimated. | One key per reported observation, since usage can be reported incrementally. | Must match current claim epoch. | Usage ledger appended; overlapping or repeated observations are reconciled by idempotency key. Replay no-op; stale token rejected. Full reconciliation semantics belong to the M9 usage-accounting milestone; this contract only states the event-level baseline. |

Reviewed-PR merge is not one of these nine events. A Ticket in In Review has no open Round, so there is no claim epoch to fence against. Michelin's GitHub connection can check merge status, and the owner can confirm merge in Swiftlet; either path reports that fact to Galley outside the Round-fencing model, using a Ticket-scoped idempotency key instead. The concrete transport for that check, and exceptional-PR handling, are routed to **D2** and **D4** (owned by M8).

## Commands pulled by Michelin

Michelin retrieves pending commands by polling Galley; commands are not pushed to the runner. Each command is idempotent and acknowledged: re-delivering an unacknowledged command must not cause a duplicate effect, and Michelin's acknowledgment is itself recorded so a repeated poll cannot re-trigger it.

| Command | Direction | Purpose | Required fields (in words) | Idempotency key | Fencing / claim epoch | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| Stop requested | Galley → Michelin | Instruct the runner to stop the open Round's execution. | Round ID, the claim epoch the command targets, an owner-issued timestamp. | One key per Stop request; a second owner click while one is pending does not queue a second stop attempt. | Targets a specific claim epoch; if Michelin no longer holds that epoch, it ignores the command. | Ticket shows Stopping, locked, until a Stop confirmed event arrives. Command acknowledged once; replayed acknowledgment is a no-op. |
| Answer/approval supplied | Galley → Michelin | Deliver the owner's answer to a pending question, or decision on a pending Permission request, so the same Round can continue. | Round ID, a reference to which pending question or request it answers, the answer or grant content. | Keyed to the specific pending question/request; a duplicate answer to an already-answered item is ignored. | Must match current claim epoch. | Round resumes active work; Ticket returns to In Progress. Acknowledged once. |
| Authority changed / check-authority | Galley → Michelin | Notify the runner that current authority may have changed (grant approved, expired, or revoked), or prompt it to check authority before its next tool action. | Round ID or Agent scope, the nature of the change. | Informational; repeated delivery is a safe no-op. | Not fenced; authority checks apply regardless of claim epoch. | Michelin checks live authority before its next tool action. Already-dispatched actions may still finish; they are not undone. |
| Reconcile | Galley ↔ Michelin | On connect or reconnect, exchange what each side believes about the Round's state before allowing any continuation. | Round ID, the last claim epoch Michelin holds, Michelin's belief about execution state, Galley's authoritative Ticket/Round state, the current claim epoch to use going forward, any pending commands. | Reconciliation is repeatable; running it twice produces no duplicate effect. | Establishes or confirms the current claim epoch for subsequent events/commands. | Continuation only if execution is intact and the claim epoch is current; otherwise the Round becomes Interrupted. |

## Question and permission waits

A necessary question or Permission need pauses the Round without ending it:

- The Round becomes Waiting for Input; the Ticket becomes Blocked and stays locked with its active-card treatment and View/Stop controls.
- The Round keeps its sequential execution slot; no other Ticket is admitted while it waits.
- The owner answers or approves through Swiftlet, which submits an owner command to Galley; Galley records the answer and makes it available as a pulled "Answer/approval supplied" command.
- A duplicate answer to an already-answered question or request is ignored: it produces no second effect and does not reopen a resolved wait.
- Answering resumes the same Round; it does not start a new Round.

## Stop with evidence-bearing confirmation

- The owner's Stop request is an owner command to Galley, which records a pending "Stop requested" command for the Round and keeps the Ticket locked with a Stopping indicator. The Ticket is not assumed stopped yet.
- Michelin pulls "Stop requested," attempts to stop the engine, and reports "Stop confirmed" only once it has evidence that execution actually ceased.
- Only "Stop confirmed" moves the Round to Stopped and the Ticket to Backlog with a Stopped Badge. No other signal (disconnect, timeout, or an unacknowledged Stop command) is treated as confirmation.
- Repeated Stop requests before confirmation do not create multiple stop attempts; the pending command's idempotency key covers this.

## Reconciliation on reconnect

- On reconnect, Michelin reports what it believes about the Round it was executing (running, stopped, or unknown), and the claim epoch it last held.
- Galley returns authoritative Ticket/Round state, any pending commands (Stop, answers, authority changes), and current authority.
- Continuation of the same Round happens only when execution is reported intact and the claim epoch matches what Galley expects. Otherwise, Galley records the Round as Interrupted and the Ticket becomes Blocked, requiring an explicit return to Ready for a new Round.
- Reconciliation never assumes success from silence; it requires the runner's own report plus Galley's authoritative check before resuming anything.

## Swiftlet → Galley owner-command boundary

Swiftlet submits owner commands to Galley; it never talks to Michelin, never mutates Ticket/Round records directly, and never reads the database directly. Representative owner commands used across the lifecycle: create a Ticket, set it Ready, assign an Agent, request rework, accept a Ticket, archive a Ticket, request Stop, supply an answer, supply a Permission decision, grant or revoke a Permission. Each becomes a Galley-authoritative record; where the command affects an open Round, Galley exposes the resulting instruction to Michelin through the pulled-commands mechanism above. Swiftlet only ever renders what Galley returns.

## Traceability: v1-scope lifecycle table

Every row of the [v1-scope.md](../v1-scope.md) "Lifecycle" table maps to at least one named event or command defined above.

| Lifecycle row (v1-scope.md) | Named events/commands |
| --- | --- |
| Capture (→ Backlog, no execution Round) | Owner command: create a Ticket (Swiftlet → Galley). No execution-interface event applies; no Round exists yet. |
| Valid, unarchived Ticket becomes Ready and Agent-assigned, in either order | Owner commands: set Ready, assign an Agent (Swiftlet → Galley). Work claim eligibility check applies once both conditions hold; the Ticket is not admitted into execution until a claim succeeds. |
| Michelin begins work | Work claim (atomic claim, fencing token issued, Round created) followed by the "Execution started" event. |
| Necessary answer or permission needed | "Question raised" event or "Permission requested" event. |
| Answer/approval permits continuation | "Answer/approval supplied" command (originating from the owner's answer/approval owner command). |
| Agent delivers result | "Delivered" event. |
| Owner explicitly requests rework in ticketIt | Owner command: request rework (Swiftlet → Galley). The next admitted claim creates a new Round. |
| Human acceptance for a Ticket with that completion condition | Owner command: accept a Ticket (Swiftlet → Galley). |
| Reviewed PR merges for a Ticket requiring merge | "Delivered" event establishes the PR reference; the merge fact itself is reported outside Round fencing (no open Round in In Review), via Michelin's GitHub connection or owner confirmation. Transport routed to D2/D4. |
| Owner requests Stop | Owner command: request Stop (Swiftlet → Galley), recorded as the pulled "Stop requested" command. |
| Michelin confirms Stop | "Stop confirmed" event. |
| Agent cannot complete after reasonable attempts | "Failed" event. |
| Execution actually stops unexpectedly | "Interrupted" event. |
| Michelin loses contact with Galley | Heartbeat timeout (registration/health) triggers the Runner disconnected indicator; "Reconcile" on reconnect determines continuation or Interrupted. |

## What this contract does not decide

- No payload schema, serialization, or transport (HTTP/gRPC/other) is chosen. See [open-decisions.md](../open-decisions.md), "Engineering decisions within the approved design."
- No queue technology is chosen; see [ADR 0003](../adr/0003-postgresql-work-claims-before-queue.md).
- Stranded-runner recovery authority is **D5**. Human-review/merge evidence is **D2**. Exceptional PR transitions are **D4**. Agent/Template compatibility is **D3**. Grill Mode scheduling relative to the single active-Round slot is **D6**. None of these are resolved here.
