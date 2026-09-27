# Galley-published Ticket actions and D3 reconciliation

## Purpose

[M3.1, #87](https://github.com/cristoforows/ticketIt/issues/87): publish Galley's current Ticket actions to Swiftlet (`apps/galley`, `apps/swiftlet`, `contracts/`, `e2e/`), reconcile D3 §2's Backlog → Blocked omission, and establish M3's evidence scaffold.

## What already existed

Galley enforced D3 transitions and Accept via `decidePlainStatusChange` and `decideAccept`. The HTTP API returned Tickets without available actions. Swiftlet's detail held a display-only transition table and a copied reviewed-PR-merge rejection. Galley's D3 grid and Swiftlet offered Backlog → Blocked; D3 §2 omitted it. Four command responses lacked OpenAPI response validation. The browser runner already used Galley's API for fixtures and covered lifecycle and stale-page rejections.

## What this slice added

- `Ticket.allowedActions.statusChanges` is an ordered array of plain status-command targets; `accept` has `available` and, when false, `reason` with the same `code` and `message` as the command. Chosen over endpoint-specific metadata so create, list, detail, edits, and commands all return one contract shape. No migration: these values are computed when `scanTicketRow` materializes each persisted Ticket.
- `allowedActionsForTicket` enumerates the known Status values and calls the same two decision functions as the commands. Enumeration is only a candidate list, not an alternative permission table. The exhaustive HTTP test compares GET's advertised targets against each real status command for six Statuses × both retained completion conditions, and compares Accept success or exact rejection code/message. The existing independent D3 grid still checks the intended ten pairs. The four formerly uncovered command endpoints now have response-vs-schema tests, including success and error responses. The existing Template guardrail explicitly allows the new completion-condition reader; the no-execution-table guardrail remains unchanged.
- The contract describes `reason` as present iff Accept is unavailable. `contract_test.go` validates this additional invariant for single-Ticket and list responses after kin-openapi response-schema validation, with both valid and both invalid combinations tested on a real response. With this contract's references, kin-openapi 0.149.0 parsed `if/then/else` but `ValidateResponse` and direct `VisitJSON` returned nil for both invalid combinations. The generator output remained valid; the conditional keywords were removed because neither response validation path enforced them. The explicit test check closes that local enforcement gap; schema-only consumers receive the documented rule, not a machine-enforced conditional.
- Swiftlet's `parseTicket` requires the new shape and rejects unavailable Accept without a reason. `TicketDetail` renders only the supplied actions and message; stale-page command errors still display Galley's live response. A browser spec compares full-page controls with live GET results for Backlog, human In Review, and Coding In Review; it compares unavailable reasons against direct Accept responses. `e2e/run.sh` registers and checks the spec.
- D3 §2 and Galley's README record the Owner-approved Backlog → Blocked pair; behavior stays the same. Both app READMEs document the new behavior. `docs/evidence/m3/TEMPLATE.md` follows the M2 template.

Future open-Round facts belong in Galley's existing `decidePlainStatusChange` and `decideAccept` decision seams, shared by advertisement and commands. M4/M5 must extend their inputs with persisted Round state when those rules arrive; no execution state is modeled here.

## Exact versions and toolchain

`go.mod`: Go 1.27.1, `oapi-codegen/v2` 2.8.0, `kin-openapi` 0.149.0. `contracts/package-lock.json`: `openapi-typescript` 7.13.0, TypeScript 5.9.3. `apps/swiftlet/package-lock.json`: React 19.3.0, TypeScript 7.0.2, Vite 8.3.0, Vitest 5.0.1. `e2e/package-lock.json`: Playwright 1.63.0. Database used: PostgreSQL 18.1 (Docker). Actual local commands used Go 1.27.1, Node 22.13.1, npm 10.9.2; `apps/swiftlet` and `e2e` pin Node 26.9.0. Node 22 emitted `EBADENGINE` on install but the executed builds and suite passed. Anonymous public npm registry (`NPM_CONFIG_USERCONFIG=/dev/null`) bypassed a local stale npm credential; no auth files were changed.

## Reproducible commands

Run each line independently from repo root, against local PostgreSQL on port 5432 with `ticketit_test` and `ticketit_e2e` available and `createdb`/`psql` on PATH:

```sh
(cd apps/galley && go generate ./... && go test ./... && go build ./... && ./scripts/check-contract-drift.sh)
(cd contracts && NPM_CONFIG_USERCONFIG=/dev/null npm ci && npm run generate:swiftlet && npm run check:swiftlet-drift)
(cd apps/swiftlet && NPM_CONFIG_USERCONFIG=/dev/null npm ci && npm test && npm run build)
(cd e2e && NPM_CONFIG_USERCONFIG=/dev/null ./run.sh)
```

Run drift checks after staging regenerated files (or on a clean checkout): both scripts compare regenerated output against the git index. For the local browser run, host PostgreSQL CLI tools were unavailable, so the actual command prepended `PATH="/var/folders/5q/00sd8m8x1ydbzf8zsvq9np440000gp/T/opencode/pgshim:$PATH"` before `NPM_CONFIG_USERCONFIG`: this pre-existing shim calls `createdb`/`psql` inside `ticketit-postgres`. Use normal installed CLI tools on a clean machine. The runner drops and recreates only `ticketit_e2e`'s schema.

## Observed results

Before the allowed-actions implementation, the grid failed with `Backlog -> Ready: advertised false, command status 200 ({Error:{Code: Message:}})`; `TestTicketCommands_ResponseMatchesContract` rejected `allowedActions.statusChanges: null`. Before the follow-up invariant check, both malformed Accept combinations passed kin-openapi response validation (`error=<nil>, want invalid=true` in the two failing subtests).

Observed after the follow-up in each app directory; shown below as equivalent root-relative subshell commands (short exact output excerpts; exit status 0 for each command):

```text
$ (cd apps/galley && go generate ./... && go test ./... && go build ./...)
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/galley	4.451s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	5.980s
$ (cd apps/galley && go test ./internal/httpapi -run 'TestTicketAcceptAvailability_ResponseContractRejectsInvalidCombinations|TestTicketCommands_ResponseMatchesContract|TestGetTicket_ResponseMatchesContract|TestTickets_ResponseMatchesContract|TestTicketAllowedActions_MatchCommands' -count=1 -v)
--- PASS: TestTicketAcceptAvailability_ResponseContractRejectsInvalidCombinations (0.04s)
    --- PASS: TestTicketAcceptAvailability_ResponseContractRejectsInvalidCombinations/unavailable_without_reason (0.00s)
    --- PASS: TestTicketAcceptAvailability_ResponseContractRejectsInvalidCombinations/available_with_reason (0.00s)
--- PASS: TestTicketAllowedActions_MatchCommands (0.32s)
$ (cd apps/swiftlet && npm test && npm run build)
 Test Files  8 passed (8)
      Tests  81 passed (81)
✓ built in 90ms
$ (cd apps/galley && ./scripts/check-contract-drift.sh)
OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).
$ (cd contracts && npm run check:swiftlet-drift)
OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
$ (cd e2e && PATH="/var/folders/5q/00sd8m8x1ydbzf8zsvq9np440000gp/T/opencode/pgshim:$PATH" NPM_CONFIG_USERCONFIG=/dev/null ./run.sh)
  1 passed (1.3s)
[run.sh] ticket-allowed-actions.spec.ts exit code: 0
[run.sh] SUITE PASSED
```

The browser runner reported exit code 0 for all 17 registered spec files. Its `1 passed (1.3s)` excerpt above is from `tests/ticket-allowed-actions.spec.ts`.

The targeted real HTTP test printed this response:

```text
GET /api/tickets/e64f53d9-37c8-4ab2-98a7-e473f3ccbc27: 200 {"allowedActions":{"accept":{"available":false,"reason":{"code":"invalid_transition","message":"Accept requires the ticket to be In Review (current status Backlog)"}},"statusChanges":["Ready","Blocked"]},"assigneeType":"","completionCondition":"humanAcceptance","constraints":"","context":"","createdAt":"2026-09-27T03:32:54Z","goal":"","id":"e64f53d9-37c8-4ab2-98a7-e473f3ccbc27","repository":"","status":"Backlog","successCriteria":"","template":"Basic","title":"ticket_test-TestTicketAllowedActions_MatchCommands/Basic_Backlog-44b23502741acb0a","updatedAt":"2026-09-27T03:32:54Z"}
```

The response body and HTTP status were emitted by `go test ./internal/httpapi -run 'TestTicketAllowedActions_MatchCommands/Basic_Backlog$|TestTicketCommands_ResponseMatchesContract' -count=1 -v`.

## Implementation limitations and follow-ups

Reviewed-PR-merge Accept remains rejected with `reviewed_pr_merge_not_implemented`; D2 is unresolved and M8 owns shared review/merge evidence. D4's already-merged-PR reopening caveat remains M8's. No required M3.1 behavior was left unimplemented.

## Outstanding checks and owning milestone

Open-Round restrictions and their advertisement are M4/M5 work. M3's gate report owns the evidence index. No independent `e2e` TypeScript typecheck script exists: a manual invocation with Swiftlet's TypeScript binary reported missing `@types/node` under `e2e/`; Playwright's registered browser suite passed. Node 26.9.0 (the pinned runtime) was not installed locally, so verification used Node 22.13.1.

## Decision impacts (open-decision IDs)

D3 §2 now records #87's Owner-approved Backlog → Blocked correction. D2 and D4 remain open; their M8 behaviors are neither selected nor emulated by this slice. D5's recovery decision remains open for M5.
