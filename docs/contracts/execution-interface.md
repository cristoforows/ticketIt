# Execution interface contract

Status: behavior agreed during M1, reconciled with what M4 shipped ([M4 evidence](../evidence/m4/README.md)). HTTP polling is the transport ([ADR 0003](../adr/0003-postgresql-work-claims-before-queue.md)) and [`contracts/openapi.yaml`](../../contracts/openapi.yaml) is the authority for paths, payloads and error codes; this document states behavior and ownership. Sections and rows marked **M5 (#6)** or **M8 (#9)** are not implemented. No provider is chosen here (see [open-decisions.md](../open-decisions.md)).

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

- **Round ID**: a UUID issued by Galley. A Round is ticketIt's unit of Agent work on a Ticket, with its own activity, result, and usage, independent of any engine's internal identifiers. A Ticket's Rounds are numbered by `sequence`.
- **Engine execution reference**: an OpenCode session ID or a LangGraph thread ID. It is a separate record attached to a Round, not the Round itself.
- **At most one current engine execution reference per Round.** The first is attached by `execution_started`. A Round can be attached to a new reference only when reattachment is authorized (for example, a stranded-claim recovery under D5, **M5 (#6)**). The prior reference is retained for history but stops being current.
- **Engine references never drive Ticket status.** Only Galley-interpreted events (below) change Status or Round outcome. The presence, absence, or internal state of an engine session/thread proves nothing about Ticket status by itself.
- A Round is created by Galley at the moment its work claim is admitted (see "Work claim"), carrying the fencing token from that claim (`claimEpoch`, increasing per Ticket, so Round 2 of a Ticket never shares Round 1's epoch). Creating the Round does not by itself move the Ticket to In Progress; that happens only when Michelin reports the "Execution started" event, so a claimed-but-not-yet-started Round is never falsely shown as running.

## Runner registration and health

- **Pair**: the Owner issues one runner credential per Owner (`POST /api/runner-credential`, Owner session). The token is returned once; Galley stores its SHA-256 hash. Pairing again revokes the previous credential. Runner routes under `/api/runner/` accept only this bearer token, and Owner routes refuse it.
- **Register**: Michelin calls `POST /api/runner/register` on start, sending its version and hostname. Registration also counts as a heartbeat. A credential that has not registered since it was issued gets `409 runner_not_registered` from the heartbeat.
- **Heartbeat**: `POST /api/runner/heartbeat` records last-seen. Health is derived on read: `connected` while the last heartbeat is under 30 s old, `disconnected` after that or before the first, `not_paired` without a credential. An event or claim is not a heartbeat, and an event from a runner that is not connected is still accepted.
- **Disconnect rule**: lost contact never proves execution stopped. When heartbeats stop arriving within the window, Galley marks the connection lost, pauses admission of new work (a claim gets `204`), keeps the affected Ticket locked, and shows a Runner disconnected indicator. This is not a Status transition by itself: a Ticket already In Progress stays In Progress, locked, with the indicator overlaid, until recovery (D5, **M5 (#6)**) determines the outcome.
- Reconnection changes nothing about the open Round in M4. Reconciliation (below) is **M5 (#6)**.

## Work claim

- **Eligibility**: the Ticket is unarchived, Ready, and Agent-assigned; it has a goal and Success Criteria; actual execution prerequisites are met. M4 requires a non-blank repository when the assigned Agent's kind is `coding`, whatever the Template; mapping it to a checkout the runner can use is **M8 (#9)**. Galley publishes the result as `Ticket.requestingAgentWork` and refuses Ready, however reached, while an input is missing (`agent_readiness_incomplete`). In Progress, In Review and Blocked on an Agent-assigned Ticket are set by execution only (`agent_owned_transition`). [D3](../decisions/d3-agent-template-compatibility.md) permits any Agent on either Template. Validate required inputs and action authority, never a template/capability whitelist. A Round may contribute without completing the whole Ticket, whose completion condition remains unchanged.
- **Atomic claim**: Michelin calls `POST /api/runner/claims`; Galley admits at most one claim per request in a single transaction, re-checking the Ticket under its row lock, issuing a fencing token (claim epoch) and creating the Round record (`201`, with the Round, `claimEpoch` and the Ticket's inputs). `204` means no work: nothing is requesting it, a Round is already open, or the runner is not connected. This prevents two runners, or two claim attempts, from both starting the same Ticket. The claim is not idempotency-keyed: a repeated claim creates no second Round, and a committed claim whose `201` never reached Michelin is the stranded claim below.
- **Sequential scheduling**: one open Round per Owner, enforced by a partial unique index, across the native and OpenCode engines. A Round that is Waiting for Input keeps its slot (**M5 (#6)**); it does not free capacity for another Ticket while paused. Delivery frees the slot.
- **Queue order**: the claim takes the first eligible Ready Ticket in the Owner's persisted priority order (`priority_rank`, then id), set by `POST /api/tickets/{id}/position`. Capture goes to the top; entering Ready, including by rework, goes to the bottom of the order. `created_at` is not priority ([#108](https://github.com/cristoforows/ticketIt/issues/108)).
- **Archive-versus-claim race**: archiving and claiming are mutually exclusive under the same transactional guard. If an archive request commits first, the Ticket is no longer eligible and the pending claim is rejected. If a claim already produced an open Round, archiving is rejected (`400 round_open`) until that Round ends, consistent with the requirement that any open Round end before archive. Every other Owner mutation of a Ticket with a claimed or running Round is rejected the same way.
- **Stranded claim**: if a runner claims work and never returns, editing and archiving still require the Round to end, but the disconnect rule forbids inferring that execution actually stopped. This contract does not invent recovery authority or timeouts for that case; it is explicitly routed to **D5** ("Stranded runner and stop recovery," owned by the M5 milestone). Until D5 resolves it, Galley keeps the Ticket locked with Runner disconnected rather than assuming Interrupted, Failed, or Stopped. M4 has no recovery: a `claimed` or `running` Round whose runner is gone stays open, and a restarted Michelin does not resume it.

## Events reported by Michelin

Every event is a fact report, not a request for permission. Each carries an idempotency key and the fencing token/claim epoch for the Round it reports on. Galley treats a replayed event (same idempotency key) as a no-op producing no new effect, and rejects an event carrying a fencing token that is not the Round's current claim epoch, without changing any state.

**Wire (M4).** All implemented events use one endpoint, `POST /api/runner/rounds/{roundId}/events`, with body `{type, idempotencyKey, claimEpoch, occurredAt, data}`; the Round is the path, not a body field. `type` is one of `execution_started`, `progress`, `usage_observed`, `delivered`. Galley checks in order: authentication, Round lookup (unknown, malformed or foreign is the shared `404`), body shape (`400`), replay by `(roundId, idempotencyKey)`, epoch, Round open, and event suited to the Round's state. A replay with the same payload returns the stored result with `200`; the same key with another payload is `409 idempotency_key_conflict`; then `409 stale_claim_epoch`, `409 round_not_open` and `409 event_out_of_order`. A rejection changes nothing. `occurredAt` is the runner's clock; Galley times the Round by its own. Bodies over 8 MiB are `413`.

Event names below carry their M4 status.

| Event | Direction | Purpose | Required fields (in words) | Idempotency key | Fencing / claim epoch | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| Execution started (`execution_started`) | Michelin → Galley | Report that the engine has actually begun work for a claimed Round. | Round ID, engine execution reference to attach as current (`data.engineReference`), timestamp. | One key per Round's transition into started. | Must match the Round's current claim epoch. | Ticket moves to In Progress; Round is now open and shown as running. Replay no-op; stale token rejected. |
| Progress (`progress`) | Michelin → Galley | Report incremental activity within an open Round, for display only. | Round ID, a human-readable activity note (`data.note`, at most 2000 characters), timestamp. | One key per reported activity increment (M4: Round and script step). | Must match current claim epoch. | Activity history appended. No Status change. Replay no-op; stale token rejected. |
| Question raised (**M5 (#6)**) | Michelin → Galley | Report that continuing needs a human answer. | Round ID, the question content, timestamp. | One key per distinct question instance. | Must match current claim epoch. | Round becomes Waiting for Input; Ticket becomes Blocked; the Round keeps its execution slot. Replay no-op (no duplicate pending question); stale token rejected. |
| Permission requested (**M5 (#6)**) | Michelin → Galley | Report that continuing needs a Permission grant, renewal, or approval. | Round ID, the requested account/action/resource scope, timestamp. | One key per distinct request instance. | Must match current claim epoch. | Round becomes Waiting for Input; Ticket becomes Blocked. Replay no-op; stale token rejected. |
| Delivered (`delivered`) | Michelin → Galley | Report the Agent's result is ready for review. | Round ID, the deliverable, a change summary, an assessment against Success Criteria. M4 carries the Report inline as `data.bodyMarkdown` (at most 1 MiB, stored in PostgreSQL), with `summary` and `criteriaAssessment`; PR or commit references are **M8 (#9)** and object storage is **M7 (#8)**. | One key per delivery. | Must match current claim epoch. | In one transaction the deliverable is retained, the Round ends as `delivered`, the slot is freed, the lock lifts and the Ticket moves In Progress → In Review, never Done. Replay returns the stored result (no duplicate deliverable record); stale token rejected. |
| Failed (**M5 (#6)**) | Michelin → Galley | Report the Agent cannot complete the work after reasonable attempts. | Round ID, an explanation, references to retained partial work and usage. | One key per Round's Failed transition. | Must match current claim epoch. | Round becomes Failed; Ticket becomes Blocked, retaining the explanation and partial work. Replay no-op; stale token rejected. |
| Stop confirmed (**M5 (#6)**) | Michelin → Galley | Report that execution actually ceased in response to a Stop, with evidence. | Round ID, evidence that execution stopped, retained partial results and usage. | One key per Round's Stopped transition. | Must match current claim epoch. | Round becomes Stopped; Ticket returns to Backlog with a Stopped Badge, preserving usage, history, and partial results. Replay no-op; stale token rejected. |
| Interrupted (**M5 (#6)**) | Michelin → Galley | Report that execution actually stopped unexpectedly, not through an owner Stop request. | Round ID, evidence/explanation of the interruption, retained partial work and usage. | One key per Round's Interrupted transition. | Must match the last known claim epoch being closed out. | Round becomes Interrupted; Ticket becomes Blocked; explicit recovery (a new Round after return to Ready) is required. Replay no-op; stale token rejected. |
| Usage observation (`usage_observed`) | Michelin → Galley | Report AI usage (tokens, cost, active time) attributable to the Round. | Round ID, provider/model, the observed figures (each null when unknown, never zero), whether `reported` or `estimated`, and the provider generation ID or null. | One key per reported observation, since usage can be reported incrementally. The key is the runner-generated `observationId` UUID, which is the observation's identity and never the provider generation ID. | Must match current claim epoch. | One ledger row per observation, attributed to the Round and never merged or updated; the provider generation ID is kept as the non-unique join point for later enrichment. Replay no-op; stale token rejected; an `observationId` already recorded for another Round is `409 observation_id_conflict`. Aggregation and enrichment belong to M9 (#10); this contract only states the event-level baseline. |

Reviewed-PR merge is not one of these nine events. A Ticket in In Review has no open Round, so there is no claim epoch to fence against. Michelin's GitHub connection can check merge status, and the owner can confirm merge in Swiftlet; either path reports that fact to Galley outside the Round-fencing model, using a Ticket-scoped idempotency key instead. The concrete transport for that check, and exceptional-PR handling, are routed to **D2** and **D4** (owned by M8).

## Commands pulled by Michelin

**Not implemented in M4 (M5, #6).** M4 has no command endpoint; Michelin pulls only work, through claims. The design below is unchanged except for the Reconcile row.

Michelin retrieves pending commands by polling Galley; commands are not pushed to the runner. Each command is idempotent and acknowledged: re-delivering an unacknowledged command must not cause a duplicate effect, and Michelin's acknowledgment is itself recorded so a repeated poll cannot re-trigger it.

| Command | Direction | Purpose | Required fields (in words) | Idempotency key | Fencing / claim epoch | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| Stop requested | Galley → Michelin | Instruct the runner to stop the open Round's execution. | Round ID, the claim epoch the command targets, an owner-issued timestamp. | One key per Stop request; a second owner click while one is pending does not queue a second stop attempt. | Targets a specific claim epoch; if Michelin no longer holds that epoch, it ignores the command. | Ticket shows Stopping, locked, until a Stop confirmed event arrives. Command acknowledged once; replayed acknowledgment is a no-op. |
| Answer/approval supplied | Galley → Michelin | Deliver the owner's answer to a pending question, or decision on a pending Permission request, so the same Round can continue. | Round ID, a reference to which pending question or request it answers, the answer or grant content. | Keyed to the specific pending question/request; a duplicate answer to an already-answered item is ignored. | Must match current claim epoch. | Round resumes active work; Ticket returns to In Progress. Acknowledged once. |
| Authority changed / check-authority | Galley → Michelin | Notify the runner that current authority may have changed (grant approved, expired, or revoked), or prompt it to check authority before its next tool action. | Round ID or Agent scope, the nature of the change. | Informational; repeated delivery is a safe no-op. | Not fenced; authority checks apply regardless of claim epoch. | Michelin checks live authority before its next tool action. Already-dispatched actions may still finish; they are not undone. |
| Reconcile | Galley ↔ Michelin | On connect or reconnect, exchange what each side believes about the Round's state before allowing any continuation. | Round ID, the last claim epoch Michelin holds, Michelin's belief about execution state, Galley's authoritative Ticket/Round state, the current claim epoch to use going forward, any pending commands. | Reconciliation is repeatable; running it twice produces no duplicate effect. | Establishes or confirms the current claim epoch for subsequent events/commands. | Continuation only if execution is reported intact and the claim epoch is current. Any other result leaves the Round open and locked and is recorded as the case it is (see "Reconciliation on reconnect"). |

## Question and permission waits

**Not implemented in M4 (M5, #6).** A necessary question or Permission need pauses the Round without ending it:

- The Round becomes Waiting for Input; the Ticket becomes Blocked and stays locked with its active-card treatment and View/Stop controls.
- The Round keeps its sequential execution slot; no other Ticket is admitted while it waits.
- The owner answers or approves through Swiftlet, which submits an owner command to Galley; Galley records the answer and makes it available as a pulled "Answer/approval supplied" command.
- A duplicate answer to an already-answered question or request is ignored: it produces no second effect and does not reopen a resolved wait.
- Answering resumes the same Round; it does not start a new Round.

## Stop with evidence-bearing confirmation

**Not implemented in M4 (M5, #6).**

- The owner's Stop request is an owner command to Galley, which records a pending "Stop requested" command for the Round and keeps the Ticket locked with a Stopping indicator. The Ticket is not assumed stopped yet.
- Michelin pulls "Stop requested," attempts to stop the engine, and reports "Stop confirmed" only once it has evidence that execution actually ceased.
- Only "Stop confirmed" moves the Round to Stopped and the Ticket to Backlog with a Stopped Badge. No other signal (disconnect, timeout, or an unacknowledged Stop command) is treated as confirmation.
- Repeated Stop requests before confirmation do not create multiple stop attempts; the pending command's idempotency key covers this.

## Reconciliation on reconnect

**Not implemented in M4.** M5 ([#6](https://github.com/cristoforows/ticketIt/issues/6)) builds it and resolves D5. What M4 fixes:

- On reconnect, Michelin reports what it believes about the Round it was executing (running, stopped, or unknown) and the claim epoch it last held. Galley returns authoritative Ticket/Round state, any pending commands (Stop, answers, authority changes), and current authority.
- These cases stay distinct and are never collapsed into one another:
  - **Lost contact**: heartbeats stopped. It proves nothing about execution.
  - **Unknown execution**: the runner cannot say whether the Round's execution is alive.
  - **Stale report**: a report carries an epoch that is not the Round's current one. Galley rejects it with no change (`409 stale_claim_epoch`); an event for an ended Round is `409 round_not_open`.
  - **Confirmed cessation**: the runner's own evidence that execution stopped, reported as Stop confirmed or Interrupted.
- Unknown or stale does not prove cessation. Only confirmed cessation can end a Round as Stopped or Interrupted.
- Nothing closes or unlocks a Round because a check failed. If execution is not reported intact or the epoch does not match, the Round stays open and the Ticket stays locked with Runner disconnected until the recovery authority D5 defines resolves it. Continuation of the same Round needs both intact execution and a matching epoch.
- Reconciliation never assumes success from silence and never starts duplicate execution.

## Swiftlet → Galley owner-command boundary

Swiftlet submits owner commands to Galley; it never talks to Michelin, never mutates Ticket/Round records directly, and never reads the database directly. Representative owner commands used across the lifecycle: create a Ticket, set it Ready (`POST /api/tickets/{id}/status`), assign an Agent (`PUT /api/tickets/{id}/assignee`), reorder the queue (`POST /api/tickets/{id}/position`), request rework (`POST /api/tickets/{id}/rework`), accept a Ticket (`POST /api/tickets/{id}/accept`), archive a Ticket, read a Ticket's Rounds (`GET /api/tickets/{id}/rounds`); and, **M5 (#6)**, request Stop, supply an answer, supply a Permission decision, grant or revoke a Permission. Rework is available only to an Agent-assigned Ticket in In Review with no open Round and the inputs Ready requires. Each becomes a Galley-authoritative record; where the command affects an open Round, Galley exposes the resulting instruction to Michelin through the pulled-commands mechanism above. Swiftlet only ever renders what Galley returns.

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
| Owner explicitly requests rework in ticketIt | Owner command: request rework (Swiftlet → Galley), which returns the Ticket to Ready. The next admitted claim creates a new Round with a new ID and epoch; earlier Rounds are unchanged. |
| Human acceptance for a Ticket with that completion condition | Owner command: accept a Ticket (Swiftlet → Galley). |
| Reviewed PR merges for a Ticket requiring merge | "Delivered" event establishes the PR reference; the merge fact itself is reported outside Round fencing (no open Round in In Review), via Michelin's GitHub connection or owner confirmation. Transport routed to D2/D4. |
| Owner requests Stop | **M5 (#6).** Owner command: request Stop (Swiftlet → Galley), recorded as the pulled "Stop requested" command. |
| Michelin confirms Stop | "Stop confirmed" event. |
| Agent cannot complete after reasonable attempts | "Failed" event. |
| Execution actually stops unexpectedly | "Interrupted" event. |
| Michelin loses contact with Galley | Heartbeat timeout (registration/health) triggers the Runner disconnected indicator; the Round stays open and locked. "Reconcile" on reconnect and D5 recovery are **M5 (#6)**. |

## What this contract does not decide

- Payload shapes are not restated here; see [`contracts/openapi.yaml`](../../contracts/openapi.yaml). The M5 events and pulled commands have no schema yet.
- No queue technology is chosen; see [ADR 0003](../adr/0003-postgresql-work-claims-before-queue.md).
- Stranded-runner recovery authority is **D5**. Human-review/merge evidence is **D2**. Exceptional PR transitions are **D4**. Grill Mode scheduling relative to the single active-Round slot is **D6**. None of these are resolved here. Agent/Template assignment and human workflow follow the separately accepted [D3 decision](../decisions/d3-agent-template-compatibility.md).
