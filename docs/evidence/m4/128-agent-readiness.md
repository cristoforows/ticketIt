# Agent readiness and Galley-owned moves

## Purpose

[M4.2 #128](https://github.com/cristoforows/ticketIt/issues/128) makes Galley refuse Ready for an Agent-assigned Ticket that lacks the inputs its Agent needs, however Ready is reached. It also makes In Progress, In Review and Blocked on an Agent-assigned Ticket moves that only execution may make. The slice changes Galley, Swiftlet, the contract, Michelin's generated types and the browser suite. It requests no Agent work: `requestingAgentWork` is a published flag, and the claim that consumes it is #132.

## What already existed

- **Assignment (#127):** a Ticket could be assigned to an Agent in any Status. Nothing read the Agent's kind or checked readiness.
- **Status moves (#60):** `decidePlainStatusChange` applied D3 S2's human table to every Ticket, whoever was assigned. An Agent-assigned Ticket could be moved by hand anywhere a human one could.
- **Published actions (#87):** `allowedActions` was derived from the same decide functions as the commands. It had no way to carry the reason a table-legal move was refused.
- **Locking (#93):** every mutation already ran behind `lockTicketForMutation`'s `SELECT ... FOR UPDATE`. Assignment and `PATCH` read the Ticket's fields only after writing.
- **Michelin (#139):** merged to main during this slice, bringing `generate:michelin`. The branch merged `origin/main` and regenerated Michelin's types.

## What this slice added

**Contract (`contracts/openapi.yaml`)**
- `ErrorDetail.missing`: an optional, non-empty array of the new `AgentReadinessInput` (`goal`, `successCriteria`, `repository`). It appears only with `agent_readiness_incomplete`.
- `Ticket.requestingAgentWork`: required.
- `TicketAllowedActions.statusChangeRejections`: required, a list of `TicketStatusChangeRejection {status, reason: ErrorDetail}`.
- Descriptions updated on the status, assign, unassign and update operations and on `successCriteria` and `repository`.
- Regenerated `api.gen.go` and both Swiftlet's and Michelin's `schema.d.ts`.

**Galley**
- New `internal/httpapi/agent_readiness.go`:
  - `ticketWorkflowState` holds the facts the rules read: Status, archived, the Agent's kind, and the goal, Success Criteria and repository. It leaves out the Template and the completion condition, so `TestNoTemplateToCapabilityMapping` needs no allowlist change.
  - `missingAgentInputs`: a goal and Success Criteria for any Agent, plus a repository only when the Agent's kind is `coding`. Whitespace counts as missing.
  - `decideAgentReadiness`, `decideAssignment`, `decideTicketUpdate` and `decideAgentWorkRequest`.
  - `readLockedTicket` re-reads the locked row inside the transaction.
- `ticket_lifecycle.go`:
  - `decidePlainStatusChange` takes the workflow state and checks, in order: Done, then D3's table, then `agent_owned_transition`, then readiness for Ready.
  - `allowedActionsForTicket` publishes each refusal that is not `invalid_transition` in `statusChangeRejections`.
  - `transitionRejection` carries `missing`.
  - Assignment is decided on the locked row before the write.
- `ticket.go`:
  - `scanTicketRow` sets `requestingAgentWork` from `decideAgentWorkRequest`.
  - `updateTicketForOwner` runs `decideTicketUpdate` on the locked row.
- `agent.go`: `agentForOwner` returns the Agent's kind with its row id.

**Tests**
- New `agent_readiness_test.go`, with 64 grid cases and 96 advertised-against-actual cases:
  - both orderings × both Templates × both kinds × all 8 subsets of the three inputs. Each case checks the rejection, that the Ticket is unchanged, and success once the inputs are filled;
  - repository follows the Agent's kind, not the Template;
  - switching a Ready Ticket to a coding Agent;
  - clearing an input while Ready, off Ready and without an Agent;
  - filling an older incomplete Ready Ticket;
  - human-assigned Tickets keep title-only Ready;
  - archived Tickets never request work;
  - a pure table for `decideAgentWorkRequest`;
  - advertised against actual for every Status × assignee (unassigned, Owner, research, coding) × Template × complete or title-only, including Accept;
  - a real-PostgreSQL race, 20 trials each: clear the goal against moving to Ready, and clear the goal against assigning an Agent while Ready.
- `contract_test.go`: `TestAgentReadiness_ResponsesMatchContract` validates every new 200 and 400 against the schema.
- Existing tests now supply the inputs an Agent needs. Their assertions are unchanged.
- `no_execution_side_effects_test.go` still checks the table allowlist and row counts. It now also asserts `requestingAgentWork` on its Ready steps.

**Swiftlet**
- **Parsing:**
  - `api/http.ts` gains `parseErrorDetail`, which validates `missing` against the enum, and `GalleyError`.
  - `ticketCommand` throws `GalleyError` for a body that holds an error.
  - `parseTicket` requires both new fields.
- **Queued copy:** `QueuedTag` shows **Queued for <Agent name>** on the slip and the receipt, only when Galley's flag is true.
  - It uses its own `queued` variant of the `tag` cva: an outline tag with `border-status-ready-deep`, `bg-paper` and `text-status-ready-deep`. The transient "Moving…" `PendingTag` keeps the ink fill and amber text, so the two no longer look alike.
  - The tokens are the existing Ready deep colour (`--color-status-ready-deep`, `#227f74`) on `--color-paper` (`#fffdf7`). No new colours were added.
  - Contrast is 4.74:1, which passes WCAG AA for text. `tokens.test.ts` now asserts that pair ("queued tag: status-ready-deep on paper") at 4.5:1 or more.
- **Rejection placement on the receipt:**
  - Status control: advertised refusals as "<Status>: <message>", plus refused status commands.
  - Assignee control: refused assignments, shown below it.
  - Save area: refused saves.
- **Missing markers:** each field in `missing` gets a **Missing** marker.
  - The field's value element on the receipt, or its input in the edit form, has `aria-describedby` set to the marker's id followed by the id of Galley's reason. For example, the goal's accessible description is "Missing Ready: <Galley's message>".
  - Edit inputs also get `aria-invalid`.
  - The marker is an `InlineError` with the new `announce={false}` prop, so it has no `role="alert"`, and nothing needs to override its role.
- **Readiness inputs:** `api/http.ts` checks `missing` against `{goal, successCriteria, repository} satisfies Record<ReadinessInput, true>`. If the contract adds an input, the compiler rejects this object until the input is added. Deleting `repository` from the object was confirmed to fail `tsc` with TS2741.
- **New Vitest cases:** 12, bringing the total to 225.

**Browser suite**
- `e2e/tests/agent-readiness.spec.ts`, registered in `run.sh` with its exit-code check.
- `e2e/support/tickets.ts` gains the new fields, `missing`, `assignTicketDirect` and `updateTicketDirect`.

**Ready entry paths and their guards**

| Path | Guard |
| --- | --- |
| `POST /status` to Ready (from Backlog, In Progress or Done) | `decidePlainStatusChange` → `decideAgentReadiness`, on the locked row |
| `PUT /assignee` with an Agent while Ready | `decideAssignment`, on the locked row, with the new Agent's kind |
| `PATCH` leaving a named input blank while Ready with an Agent | `decideTicketUpdate`, on the locked row |
| `POST /tickets` | Always Backlog and unassigned, so it never enters Ready |
| `POST /restore` | Restores Ready as Backlog (#94), so it never enters Ready |
| `POST /accept` | Moves only to Done |
| `PUT /assignee` with the Owner, and `DELETE /assignee` | The result is human-assigned or unassigned, so title-only Ready is correct |
| Badges, archive | Change neither the Status nor any input; `requestingAgentWork` is false while archived |

**Engineering choices inside the Decisions**
- **`statusChangeRejections`:** the issue requires advertised actions to equal the command outcome, and it requires Galley's reason beside the Status control. Omitting Ready from `statusChanges` satisfies the first. Publishing the command's exact error for each table-legal refused move satisfies the second, without Swiftlet computing anything. Moves D3's table forbids stay unlisted, as before.
- **Order of checks:** the table comes first, so Backlog → In Progress on an Agent-assigned Ticket is still `invalid_transition`. The generic table error is kept for moves no one may make.
- **`PATCH`:** it is refused only when a field it names ends up missing. An Agent-assigned Ticket made Ready before this slice with missing inputs can still be filled one field at a time.
- **Message:** Galley builds the message from `missing` in contract order. Swiftlet shows it verbatim and places markers only from `missing`.
- **Unassign:** it never refuses, because the result is never Agent-assigned.
- **`agentOwnedTargets`:** kept as its own set, not derived from D3's table, because D3 S2 names these three Statuses. It maps each Status to its label.
- **`agent_owned_transition` message:** one short line per target, such as "Execution sets In Progress on an Agent-assigned Ticket". Galley returns the same text when a command is refused and when the move is only advertised as refused, so it does not say "attempted". The grid asserts the exact text for each target.

## Exact versions and toolchain

- **Runtimes:** Go 1.27.1, Node 26.9.0, npm 11.19.1, PostgreSQL 17.11 (Homebrew, this host).
- **Galley (`apps/galley/go.mod`):** pgx/v5 5.11.0, oapi-codegen/v2 2.8.0, kin-openapi 0.149.0.
- **Contracts (`contracts/package.json`):** openapi-typescript 7.13.0.
- **Swiftlet (`apps/swiftlet/package.json`):** TypeScript 7.0.2, Vite 8.3.0, Vitest 5.0.1.
- **Michelin (`apps/michelin/package.json`):** TypeScript 5.9.3.
- **Browser suite (`e2e/package.json`):** Playwright 1.63.0.

## Reproducible commands

These need local PostgreSQL with `ticketit_test` and `ticketit_e2e`, and `psql` on PATH:

```sh
(cd contracts && npm ci && npm run generate:swiftlet && npm run generate:michelin)
git add apps/swiftlet/src/api/generated apps/michelin/src/api/generated
(cd contracts && npm run check:swiftlet-drift && npm run check:michelin-drift)
(cd apps/galley && go generate ./... && gofmt -l . && go vet ./... && go build ./... && go test ./... -count=1 && ./scripts/check-contract-drift.sh)
(cd apps/swiftlet && npm ci && npm test && npm run build)
(cd apps/michelin && npm ci && npm run typecheck && npm test)
(cd e2e && ./run.sh)
```

`run.sh` must not inherit `FORCE_COLOR`. On this host it was set to 3, which made `free_port`'s `console.log` emit ANSI-coloured port numbers, and Galley refused `GALLEY_PORT`. The suite was run with `env -u FORCE_COLOR ./run.sh`.

## Observed results

**Galley: `gofmt -l .`, `go vet ./...`, `go build ./...`, `go test ./... -count=1` and the drift check (after merging `origin/main`)**

```text
gofmt: []
VET_OK
BUILD_OK
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/galley	4.663s
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/githubfake	1.685s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/auth	1.197s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/config	0.401s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/githubfake	1.246s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	7.841s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/postgres	3.008s
OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).
OK: ../apps/michelin/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
```

**Galley: `go test ./internal/httpapi -count=1 -v`** (145 top-level passes, 508 passes including subtests, no failures)

```text
--- PASS: TestAgentReadiness_EitherOrderGrid (0.73s)
--- PASS: TestAgentReadiness_RepositoryFollowsAgentKindNotTemplate (0.02s)
--- PASS: TestAgentReadiness_SwitchingToCodingAgentOnReadyTicketNeedsRepository (0.03s)
--- PASS: TestAgentReadiness_ClearingRequiredInputOnReadyAgentTicket (0.08s)
--- PASS: TestAgentReadiness_ClearingIsAllowedOffReadyOrWithoutAnAgent (0.02s)
--- PASS: TestAgentReadiness_IncompleteReadyAgentTicketCanStillBeFilled (0.01s)
--- PASS: TestAgentReadiness_HumanAssignedTicketsKeepTitleOnlyReady (0.02s)
--- PASS: TestAgentWorkRequest_ArchivedTicketsNeverRequest (0.02s)
--- PASS: TestDecideAgentWorkRequest (0.00s)
--- PASS: TestTicketAllowedActions_MatchCommandsForEveryAssignee (0.48s)
--- PASS: TestAgentReadiness_ConcurrentClearAndReadinessNeverBothApply (0.14s)
--- PASS: TestAgentReadiness_ResponsesMatchContract (0.04s)
--- PASS: TestManualLifecycleActionsCreateNoExecutionRecords (0.03s)
--- PASS: TestNoTemplateToCapabilityMapping (0.00s)
--- PASS: TestTicketAllowedActions_MatchCommands (0.07s)
--- PASS: TestChangeTicketStatus_ConcurrentConflictingTransitionsOnlyOneApplies (0.07s)
```

Both race orders happened, so each side was seen losing:

```text
=== RUN   TestAgentReadiness_ConcurrentClearAndReadinessNeverBothApply/clear_goal_vs_move_to_Ready
    agent_readiness_test.go:558: 20 trials: map[clear won:14 readiness won:6]
=== RUN   TestAgentReadiness_ConcurrentClearAndReadinessNeverBothApply/clear_goal_vs_assign_an_Agent_while_Ready
    agent_readiness_test.go:558: 20 trials: map[clear won:10 readiness won:10]
```

**Galley: real responses** (a title-only Basic Ticket assigned to a coding Agent, captured through the test server with a temporary logging test that is not in the slice)

```text
POST /status {"status":"Ready"} -> HTTP 400 {"error":{"code":"agent_readiness_incomplete","message":"this Ticket needs a goal, Success Criteria and a repository before a coding Agent can take it from Ready","missing":["goal","successCriteria","repository"]}}
POST /status {"status":"Blocked"} -> HTTP 400 {"error":{"code":"agent_owned_transition","message":"Execution sets Blocked on an Agent-assigned Ticket"}}
GET -> {"allowedActions":{"accept":{"available":false,"reason":{"code":"invalid_transition","message":"Accept requires the ticket to be In Review (current status Backlog)"}},"statusChangeRejections":[{"reason":{"code":"agent_readiness_incomplete","message":"this Ticket needs a goal, Success Criteria and a repository before a coding Agent can take it from Ready","missing":["goal","successCriteria","repository"]},"status":"Ready"},{"reason":{"code":"agent_owned_transition","message":"Execution sets Blocked on an Agent-assigned Ticket"},"status":"Blocked"}],"statusChanges":[]},...,"assigneeType":"agent",...,"requestingAgentWork":false,"status":"Backlog",...,"template":"Basic",...}
```

**Falsification**
- **Row lock:** I removed `FOR UPDATE` from `lockTicketForMutation`, so readiness was checked on an unlocked read. The race test failed at once:

  ```text
  --- FAIL: TestAgentReadiness_ConcurrentClearAndReadinessNeverBothApply (0.07s)
      --- FAIL: TestAgentReadiness_ConcurrentClearAndReadinessNeverBothApply/clear_goal_vs_move_to_Ready (0.04s)
          agent_readiness_test.go:534: trial 1: clear 200 ({Error:{Code: Message: Missing:<nil>}}), enter 200 ({Error:{Code: Message: Missing:<nil>}}); want exactly one to apply
      --- FAIL: TestAgentReadiness_ConcurrentClearAndReadinessNeverBothApply/clear_goal_vs_assign_an_Agent_while_Ready (0.01s)
          agent_readiness_test.go:534: trial 0: clear 200 ({Error:{Code: Message: Missing:<nil>}}), enter 200 ({Error:{Code: Message: Missing:<nil>}}); want exactly one to apply
  FAIL
  ```

- **Advertised actions:** I made `allowedActionsForTicket` decide as if no Agent were assigned. The advertised-against-actual grid failed:

  ```text
  --- FAIL: TestTicketAllowedActions_MatchCommandsForEveryAssignee (0.75s)
          agent_readiness_test.go:448: Backlog -> Blocked advertised, command status 400 ({Error:{Code:agent_owned_transition Message:Execution sets Blocked on an Agent-assigned Ticket Missing:<nil>}})
          agent_readiness_test.go:451: Backlog -> Blocked advertised for an Agent-assigned Ticket
          agent_readiness_test.go:448: Ready -> InProgress advertised, command status 400 ({Error:{Code:agent_owned_transition Message:Execution sets In Progress on an Agent-assigned Ticket Missing:<nil>}})
          agent_readiness_test.go:451: Ready -> InProgress advertised for an Agent-assigned Ticket
  ```

- **Existing tests:** five existing Galley tests failed on the first run of the new rules, because they moved Agent-assigned Tickets by hand or into Ready without inputs. They were changed to supply inputs, or to assign the Owner before manual moves, and still assert what they asserted.

Both temporary changes were reverted, and the full suite above passed afterwards.

**Swiftlet: `npm test && npm run build`**

```text
 Test Files  15 passed (15)
      Tests  225 passed (225)
✓ built in 104ms
```

**Michelin: `npm run typecheck && npm test`** (regenerated types only)

```text
 Test Files  4 passed (4)
      Tests  30 passed (30)
```

**Browser suite: full `e2e/run.sh`, after merging `origin/main`**

It exited 0. All 30 registered spec invocations passed (77 Chromium tests), against migrations at schema version 10:

```text
migrations applied: schema version 10
  ✓  1 [chromium] › tests/agent-readiness.spec.ts:39:1 › Ready first, then a coding Agent: the assignment is refused beside the assignee control until the inputs are filled (479ms)
  ✓  2 [chromium] › tests/agent-readiness.spec.ts:84:1 › A research Agent first, then Ready: Galley's reason sits in the Status control, a stale Ready is refused, and filling the inputs queues the Ticket (640ms)
[run.sh] agent-readiness.spec.ts exit code: 0
[run.sh] SUITE PASSED
```

## Implementation limitations and follow-ups

- **Repository checkout (M8 #9):** a coding Agent's repository is checked only for being non-blank. Mapping the reference to a checkout the Runner can use, and rejecting one it cannot, belongs to M8 #9. A Ticket can therefore request coding work with a repository that later proves unusable.
- **Rework (M4.11 #137):** explicit rework (In Review → Ready for an Agent-assigned Ticket) is not in this slice. For now, an Agent-assigned In Review Ticket can be accepted, or reassigned to the Owner for manual rework.
- **Open Rounds (M4.7 / M5):** locking assignment and fields during an open Round needs the Round, which does not exist yet.
- **The claim (#132):** it must call `decideAgentWorkRequest` on the locked row. Nothing consumes `requestingAgentWork` yet.

## Outstanding checks and owning milestone

- **Runner claim path:** the claim consuming `requestingAgentWork` is #132 (M4).
- **Real checkout of the repository reference:** M8 #9.

## Decision impacts (open-decision IDs)

None resolved or changed. The slice implements D3 S1's readiness inputs and S2's execution-owned Statuses as settled in #128.
