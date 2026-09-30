# Agents and Agent assignment

## Purpose

[M4.1 #127](https://github.com/cristoforows/ticketIt/issues/127) adds reusable Agents and lets a Ticket be assigned to one, with no execution. It changes Galley, Swiftlet, the contract and the browser suite. It also creates this milestone's `TEMPLATE.md`.

## What already existed

- A Ticket's Assignee was either unassigned or the Owner (`tickets.assignee_type`, migration 000007).
- `PUT /api/tickets/{id}/assignee` took no body and always assigned the Owner.
- #93 put every assignment behind `lockTicketForMutation`.
- There was no Agent record, route or screen.
- The receipt offered **Assign to me** / **Unassign**, and the slip showed Owner or Unassigned.

## What this slice added

**Contract**
- `GET`/`POST /api/agents` and `PATCH /api/agents/{id}` (tag `agents`).
- New schemas: `Agent`, `AgentKind`, `AgentList`, `CreateAgentRequest`, `RenameAgentRequest`.
- The assignee `PUT` now requires `AssignTicketRequest` (`{"type":"owner"}` or `{"type":"agent","agentId":"<uuid>"}`).
- `TicketAssigneeType` gains `agent`.
- `Ticket.assigneeAgent` is required and nullable.
- `AgentKind` carries `x-enum-varnames`. Without them, `coding` collides with `TicketTemplate`'s `Coding`, and oapi-codegen renames both enums' constants.

**Migration `000010_create_agents.up.sql`**
- **`agents` table:** identity key, `owner_id`, a unique public UUID, `name`, `kind` and `created_at`.
- **Name rule:** a unique index `agents_owner_name_ci_unique` on `(owner_id, lower(name))` makes names unique per Owner, ignoring case. Because the index enforces it, concurrent duplicates get a 409 without an application-level lock.
- **Agent reference on Tickets:** nullable `tickets.assignee_agent_id` with a composite foreign key to `agents (owner_id, id)`, so the database cannot link a Ticket to another Owner's Agent.
- **Consistency check:** `tickets_assignee_agent_iff_agent_type` requires the Agent id exactly when `assignee_type` is `agent`. It uses `IS NOT DISTINCT FROM`, because with a plain `=`, an unassigned (NULL) Ticket carrying an Agent would pass.
- **No CHECK on `kind`:** Galley validates it, like `assignee_type` and `template`.

**Galley**
- `agent.go` handles list, create and rename:
  - names are trimmed, 1–80 runes, with strict decoding;
  - rename's body has only `name`, so `kind` is rejected as an unknown property;
  - unknown or malformed ids return a 404.
- `AssignTicketOwner` became `AssignTicket`:
  - it validates the body;
  - it locks the Ticket;
  - it resolves the Agent inside the Owner's scope;
  - it writes both columns in one statement.
- `DELETE` clears both columns.
- An unknown, malformed or foreign Agent returns the shared 404, `no ticket or agent with that identifier`.
- `ticketSelectColumns` reads `assigneeAgent` as a `json_build_object` subquery. `RETURNING` clauses share the same column list, and a rename is visible on every Ticket without denormalising.
- Nothing reads the Template, the Agent's kind or any readiness rule.
- The 405s for both new paths are registered in `handler.go`.

**Tests**
- New `agent_test.go` covers:
  - name and kind validation;
  - case-insensitive duplicates;
  - concurrent create and rename races (5 trials each, one success and one 409);
  - ordering;
  - assignment on both Templates and in all six Statuses;
  - reassignment keeping everything else unchanged (`reflect.DeepEqual` on response and list);
  - invalid bodies;
  - the database constraints;
  - two-Owner isolation over HTTP.
- `contract_test.go` validates every new response and the 405s.
- `no_execution_side_effects_test.go` lists `agents` as a known table. It expects exactly one new Agent and one new Ticket while assigning Agent → Owner → Agent.

**Swiftlet**
- `/agents` route (`AgentsPage`), linked from a **Settings** nav in the shell:
  - the list with each kind;
  - a **New Agent** form with labelled name and kind, and a hint that kind is fixed;
  - a per-row **Rename** with a labelled input. Escape cancels and focus returns to **Rename**.
  - Every change reloads from Galley, and Galley's message is shown verbatim.
- **Receipt:** the **Assign to** select lists "Me" first, then Galley's Agents in its order, with **Assign** and **Unassign** buttons. The receipt and slip show the Agent's name.
- `parseTicket` and `api/agents.ts` share one Agent guard (`isAgentSummary`), including the kind enum. The authenticated fetch and error-message helpers moved to `api/http.ts`, so `agents.ts` does not depend on `tickets.ts`.
- A failed reload after a create or rename keeps the rows and says the list may be out of date.

**Browser suite**
- `tests/agents.spec.ts` is registered in `run.sh` with its exit-code check.
- `e2e/support/tickets.ts` gains `assigneeType`, `assigneeAgent`, `createAgent` and `listAgents`.
- Existing specs pick "Me" before **Assign**.

**Engineering choices inside the Decisions**
- **Operation id:** renamed `assignTicketOwner` → `assignTicket`, since the command no longer only assigns the Owner.
- **Required body:** the `PUT` body is required. A body-less `PUT` is now a 400 rather than an implied Owner assignment, because the issue defines the body.
- **Agents 404:**
  - `PATCH /api/agents/{id}` uses its own `no agent with that identifier`.
  - Assignment uses one message for both Ticket and Agent, so a caller cannot tell which id was wrong.
  - Swiftlet shows that message for an Agent assignment, instead of the "Ticket not found" state.
- **Receipt control:**
  - Selecting then pressing **Assign** keeps a keyboard user's arrow keys from firing a command on each option.
  - **Unassign** stays, because the select has no "nobody" choice.
  - An unassigned Ticket shows a disabled "Unassigned" placeholder above "Me".
- **List rows:** they do not show the Assignee; the issue names the slip and the receipt.
- **"Alphabetically":** means Galley's `ORDER BY lower(name), public_id`. Swiftlet does not re-sort.
- **Racy assertion hardened:** `ticket-board-moves.spec.ts` used a non-retrying `allTextContents()` read right after opening the modal. It failed once (it read `[]`) and passed on the rerun. It is now the retrying `toHaveText`.

## Exact versions and toolchain

- **Runtimes:** Go 1.27.1, Node 26.9.0, npm 11.19.1, PostgreSQL 17.11 (Homebrew, this host).
- **Galley (`apps/galley/go.mod`):** pgx/v5 5.11.0, golang-migrate/v4 4.20.1, oapi-codegen/v2 2.8.0, kin-openapi 0.149.0.
- **Contracts (`contracts/package.json`):** openapi-typescript 7.13.0.
- **Swiftlet (`apps/swiftlet/package.json`):** TypeScript 7.0.2, Vite 8.3.0, Vitest 5.0.1.
- **Browser suite (`e2e/package.json`):** Playwright 1.63.0.

## Reproducible commands

These need local PostgreSQL with `ticketit_test` and `ticketit_e2e`, and `psql` on PATH:

```sh
(cd contracts && npm ci && npm run generate:swiftlet && npm run check:swiftlet-drift)
(cd apps/galley && go generate ./... && go test ./... -count=1 && go vet ./... && go build ./... && ./scripts/check-contract-drift.sh)
(cd apps/swiftlet && npm ci && npm test && npm run build)
(cd e2e && ./run.sh)
```

Stage the regenerated outputs before running the drift scripts, because they compare against the Git index.

## Observed results

**Galley: `go test ./... -count=1`, `go vet ./...`, `go build ./...` and both drift checks**

```text
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/galley	4.218s
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/githubfake	2.207s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/auth	0.853s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/config	1.336s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/githubfake	1.802s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	6.921s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/postgres	3.026s
VET_BUILD_OK
OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).
OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
```

**Galley: the new and guardrail tests (`go test ./internal/httpapi -count=1 -v`, 133 top-level passes)**

```text
--- PASS: TestCreateAgent_ValidatesNameAndKind (0.04s)
--- PASS: TestCreateAgent_DuplicateNameIgnoringCaseIsRejected (0.02s)
--- PASS: TestCreateAgent_ConcurrentDuplicateNamesYieldOneAgent (0.02s)
--- PASS: TestListAgents_OrderedCaseInsensitively (0.02s)
--- PASS: TestRenameAgent_ValidatesNameAndKeepsKind (0.01s)
--- PASS: TestRenameAgent_DuplicateNameIgnoringCaseIsRejected (0.01s)
--- PASS: TestRenameAgent_ConcurrentRenamesToOneNameYieldOneWinner (0.02s)
--- PASS: TestRenameAgent_UnknownAndMalformedIdentifiers404 (0.01s)
--- PASS: TestAssignTicket_AgentOnBothTemplatesAndReassignmentKeepsTheRest (0.59s)
--- PASS: TestAssignTicket_AgentAllowedInEveryStatus (0.02s)
--- PASS: TestAssignTicket_RejectsInvalidBodiesAndUnknownAgentsWithoutChange (0.02s)
--- PASS: TestTicketResponses_CarryAssigneeAgentAndReflectRename (0.05s)
--- PASS: TestAgentAssigneeConstraints_RejectInconsistentRows (0.09s)
--- PASS: TestAgents_OwnersAreIsolatedThroughHTTP (0.11s)
--- PASS: TestAgents_ResponsesMatchContractAndMethod405 (0.07s)
--- PASS: TestManualLifecycleActionsCreateNoExecutionRecords (0.03s)
--- PASS: TestNoTemplateToCapabilityMapping (0.00s)
```

**Galley: two real Owners, using `NewEmptyMigratedTestPool` with `owners.singleton=false`**

```text
=== RUN   TestAgents_OwnersAreIsolatedThroughHTTP
    agent_test.go:513: PATCH /api/agents/1c3ff28e-61ff-40b9-a4bc-6948f768fbe5 (foreign) -> HTTP 404 {"error":{"code":"not_found","message":"no agent with that identifier"}}
    agent_test.go:520: PUT /api/tickets/3e15135e-0083-4007-b129-e074cd0582a4/assignee with a foreign Agent -> HTTP 404 {"error":{"code":"not_found","message":"no ticket or agent with that identifier"}}
--- PASS: TestAgents_OwnersAreIsolatedThroughHTTP (0.08s)
```

**Falsification**
- **Owner scoping:** I removed `owner_id = $1` from `agentRowIDForOwner`'s lookup. The test went red, and the composite foreign key rejected the write underneath:

  ```text
  --- FAIL: TestAgents_OwnersAreIsolatedThroughHTTP (0.14s)
      agent_test.go:519: PUT /api/tickets/313dba33-354c-4b4b-a235-9fb0c7c6d086/assignee: status=503, want 404; body={"error":{"code":"database_unavailable","message":"failed to assign the ticket"}}
  FAIL
  ```

  After restoring the line, `go test ./internal/httpapi -run 'TestAgents_' -count=1` printed `ok`.
- **Contract test:** temporarily renaming `Agent.kind`'s JSON key made `TestAgents_ResponsesMatchContractAndMethod405` fail schema validation.
- **Guardrail trip wire:** adding the migration first failed `TestManualLifecycleActionsCreateNoExecutionRecords` on the unknown `agents` table. That confirms the trip wire before it was deliberately extended.

None of these temporary changes is in the slice.

**Swiftlet: `npm test && npm run build`**

```text
 Test Files  15 passed (15)
      Tests  213 passed (213)
✓ built in 110ms
```

**Browser suite: full `e2e/run.sh`**

It exited 0. All 29 registered spec invocations passed (75 Chromium tests), against migrations at schema version 10:

```text
migrations applied: schema version 10
[run.sh] running tests/agents.spec.ts against the restarted galley

Running 1 test using 1 worker

  ✓  1 [chromium] › tests/agents.spec.ts:21:1 › create and rename Agents, assign them on Basic and Coding Tickets, then replace with the Owner (1.0s)

  1 passed (1.3s)
[run.sh] agents.spec.ts exit code: 0
[run.sh] SUITE PASSED
```

`agents.spec.ts` covers:
- creating an Agent in the UI;
- the live `409 duplicate_agent_name` message;
- renaming, with focus returning to **Rename**;
- the select offering "Me" then Galley's Agent list;
- assigning on Basic (Board modal) and Coding (full page), checked against each `PUT` response;
- replacing with the Owner;
- the Ticket list API;
- the List view's modal;
- both slips.

## Implementation limitations and follow-ups

Nothing from M4.1 was left unimplemented.

Agent delete or retirement, model, instructions, Skills and provider settings belong to M6 #7, as are any changes to the kind. Assignment keeps the Ticket's fields and completion condition, but no assignment history is recorded, because none existed before this slice.

## Outstanding checks and owning milestone

- **Later M4 slices:**
  - D3 says Agent kind is used only for action prerequisites. That check belongs to the slices that request execution.
  - Their claim and eligibility checks must also treat an Agent assignment as no request for work.
- **M5 #6:**
  - locking assignment while a Round is open;
  - showing Agent and runner state on the active card.
- **M10:** real-provider OAuth remains out of scope; the browser suite uses the local substitute.

## Decision impacts (open-decision IDs)

No open decision was resolved. D3 §1 is respected: assignment never reads the Template, and `TestNoTemplateToCapabilityMapping` is unchanged. D1, D2 and D4–D9 remain open.
