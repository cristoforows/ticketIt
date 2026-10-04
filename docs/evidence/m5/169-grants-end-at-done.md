# Ticket grants end at Done and stay expired on reopen

## Purpose

M5.11, [#169](https://github.com/cristoforows/ticketIt/issues/169), grant
side of [#154](https://github.com/cristoforows/ticketIt/issues/154).

- Reaching Done ends every active ticket-based grant bound to the Ticket,
  in the transaction that sets the Status. The grant is recorded as
  `ended_at_done` with `ended_at`; nothing is deleted.
- Done → Ready does not revive them. The next Round's checks deny and
  Michelin raises a fresh request; a grant approved then works normally.
  No Ticket flag stores "may not receive grants".
- Time-based grants are unaffected by Done. Rework from In Review ends
  nothing.
- Swiftlet's grants view shows **Ended at Done** with Galley's time.

Touches `contracts/`, `apps/galley`, `apps/swiftlet`, `e2e/`,
`CONTEXT.md` (Temporary Permission) and the READMEs of Galley, Swiftlet
and the browser suite. Michelin only gets its regenerated
`schema.d.ts`.

## What already existed

- M5.1–M5.10 merged; this branch starts at `1fdfdf6` (M5.10).
- `permission_grants.state` allowed `active | revoked` (migration 000025).
  Checks read `state = 'active'`; renewal and expired lookups read
  `form = 'time'` and `state = 'active'`; `decideRevoke` rejected revoked
  and expired grants.
- Accept was the only command that set Done, through
  `transitionLockedTicket` (priority lock, Ticket row, decide, UPDATE).
  Done → Ready was the existing status command (M5.6 feedback spec).
- Counts after this slice, for the next record's baseline: Galley 524
  top-level tests (`go test -list '.*' ./...`), Michelin 394, Swiftlet
  710 (27 files), 48 browser spec files.

## What this slice added

**Contract.** `PermissionGrantState` gains `ended_at_done`;
`PermissionGrant` requires `endedAt` (set exactly when ended);
`allowedActions.revoke` can carry `grant_ended`; the revoke and accept
descriptions say what happens. `api.gen.go` and both `schema.d.ts`
regenerated.

**Migration `000026_end_grants_at_done.up.sql`** (forward-only): state
CHECK widened; `ended_at`; CHECKs `ended_at_follows_state`,
`ended_after_approval`, `only_ticket_form_ends_at_done`. No new table, so
`no_execution_side_effects_test.go` needed no change (its table list and
row-count assertions pass unchanged).

**Galley.**

- `grant_ending.go`: `endTicketGrantsAtDone` ends `active`, `form =
  'ticket'` grants of the Ticket, whatever Agent, scope or full access.
  `ended_at = GREATEST(now, approved_at)`, as revoke does.
- `transitionLockedTicket` calls it when the chosen Status is Done,
  inside its transaction, before the Ticket UPDATE so the `RETURNING`
  read model already shows ended grants.
- `decideRevoke` rejects an ended grant with `400 grant_ended`;
  `normalisePermissionGrant` therefore gives `revoke` unavailable and
  empty `coveredOpenRounds`.
- `round_permissions.go` reads `ended_at` into `endedAt`.

**Swiftlet.** Strict parser accepts `ended_at_done` for the ticket form,
requires `endedAt` exactly then; `PermissionPanel` shows the existing
`ExpiredTag` as **Ended at Done** with the time; `grant_ended` message.
No new palette. `e2e/support/tickets.ts` updated.

**Browser suite.** `e2e/tests/runner-grant-done.spec.ts`, registered in
`run.sh` with its exit-code check, after `runner-revoke.spec.ts`. No
reset: it leaves its Round delivered and runs before
`active-order-slip.spec.ts`, which leaves a Round open. It does not
depend on the dev clock.

### Paths that can set a Ticket to Done

Every `UPDATE tickets SET status` in non-test code:

| Site | Can produce Done? |
|------|-------------------|
| `ticket_lifecycle.go` `transitionLockedTicket` (Accept and the plain status command) | Accept only. The plain command rejects `Done` (`invalid_transition`); a test shows status and grants unchanged. Calls the ending. |
| `ticket_archive.go` restore | Keeps the current Status (Ready becomes Backlog). A Done Ticket stays Done, grants stay ended (tested through archive and restore). |
| `round_endings.go` | Sets Backlog, Ready or Blocked from an open Round. |
| `round_events.go` `startRound` / `moveRoundAndTicket` | In Progress, Blocked. |
| `round_deliverables.go` | In Review. |
| `round_questions.go` | Blocked, In Progress. |

`TestEveryTicketStatusWriteIsAccountedFor` fails if a Status write
appears in a new file or a second one in a listed file, so a future path
to Done cannot skip the ending silently. Merged-PR completion
(`reviewedPrMerge`) is rejected by Accept and is M8's; no transition is
added. Archived and non-In-Review Tickets cannot be accepted (tested:
grants stay active).

### Engineering choices beyond the Decisions

1. **State value `ended_at_done` plus `ended_at`**, not `ended` plus a
   reason column. One reason exists; the state name is what the
   contract, tests and UI read, and the CHECKs stay one-to-one.
2. **Ticket-form only, by CHECK.** A time grant cannot be ended at Done
   even by a buggy writer.
3. **End before the Ticket UPDATE** in the same transaction, so the
   returned Ticket is consistent; both orders roll back together
   (tested with failures injected on each table).
4. **A trigger was not used.** One function called from the one
   function that can write Done, guarded by the status-write inventory
   test, matches how the code base keeps rules in Go. Limitation below.
5. **Revoking an ended grant is `400 grant_ended`**, a new code beside
   `grant_expired`, not the 200 no-op repeat of `grant_already_revoked`:
   an ended grant authorized something once and was not ended by the
   Owner; the Owner learns it is already over.
6. **Lock order unchanged**: priority lock, Ticket row, then grant rows,
   as revoke (priority, Ticket rows, grant row) and approve (Ticket row).
   Checks take Round then grant `FOR SHARE`; a Round of a Ticket in
   In Review cannot be running, so no check shares a row with the
   accept's grants.
7. **Ended grants stay in `permissionGrants`** (the applicable-grants
   query is unchanged); history already links checks to them.
8. **CONTEXT.md**: Temporary Permission now says the ended grant stays
   ended on reopen and a later approval is a new grant.

## Exact versions and toolchain

Go 1.27.1 (darwin/arm64), Node 26.9.0, npm 11.19.1, PostgreSQL 17.11
(local), Playwright and Vitest as locked in each `package-lock.json`;
no dependency changed.

## Reproducible commands

```
createdb ticketit_test_m511; createdb ticketit_e2e_m511
export GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test_m511?sslmode=disable'
cd apps/galley && gofmt -l . && go vet ./... && go build ./... && go test ./... -count=1 && go test -race -count=1 ./...
cd apps/michelin && npm ci && npm run typecheck && npx vitest run
cd apps/swiftlet && npm ci && npx tsc -p tsconfig.json --noEmit && npx vitest run && npm run build
cd apps/galley && ./scripts/check-contract-drift.sh
cd contracts && npm ci && ./check-swiftlet-drift.sh && ./check-michelin-drift.sh
cd e2e && E2E_DATABASE_URL='postgres://localhost:5432/ticketit_e2e_m511?sslmode=disable' ./run.sh
```

## Observed results

Final tree, run from the worktree (generated files staged first, as the
drift scripts require):

```
gofmt -l .            (no output)
go vet ./...          ok
go build ./...        ok
go test ./... -count=1
ok  .../apps/galley/cmd/galley           4.178s
ok  .../apps/galley/cmd/githubfake       1.227s
ok  .../apps/galley/internal/auth        2.659s
ok  .../apps/galley/internal/config      0.812s
ok  .../apps/galley/internal/githubfake  0.452s
ok  .../apps/galley/internal/httpapi     138.158s
ok  .../apps/galley/internal/postgres    3.709s
go test -race -count=1 ./...
ok  .../apps/galley/internal/httpapi     199.373s   (all other packages ok)
Michelin: tsc ok; Test Files 11 passed (11), Tests 394 passed (394)
Swiftlet: tsc ok; Test Files 27 passed (27), Tests 710 passed (710); build ok
OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).
OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
OK: ../apps/michelin/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
```

Browser suite, `./run.sh`: `runner-grant-done.spec.ts` 1 passed (11.4s),
`active-order-slip.spec.ts` after it passed, every spec's exit code 0,
`SUITE PASSED`, exit 0. The first run after adding the spec failed in the
spec itself (a strict-mode locator matching both Rounds' state labels;
active-order-slip then failed because the failed spec left Round 2
open). The locator was fixed with `.first()`; the whole suite was then
re-run from a fresh schema and passed as above. No other flake seen.

Behaviours, each a Galley test through the HTTP handler on real
PostgreSQL (`grant_ending_test.go`):

- Accept ends every ticket grant (scoped, second scope, full ticket) of
  the Ticket at the clock time; a time grant stays active; a revoked
  grant stays revoked with no `endedAt`; another Ticket's ticket and
  time grants stay active and keep allowing; the delivered Round's late
  check is `409`.
- Two Agents on one Ticket: both grants end.
- For each of ticket, time, full ticket, full time: reopen, next Round
  denies (ticket forms, any scope for full) or allows (time forms).
- grant, Done, reopen, deny, request again, approve fresh, allow; old
  grant stays ended and covers no open Round; revoke of it is
  `grant_ended`; renewal naming it is `invalid_renewal`, nothing
  recorded.
- Rework: the grant allows in Rounds 2 and 3.
- A time grant allows on this and another Ticket after Done and reopen.
- Paths to Done: plain command, archived accept, accept from a running
  Ticket (all leave grants active), archive and restore of a Done
  Ticket (stays ended), inventory test.
- Atomicity: a trigger failing on `permission_grants` or on `tickets`
  gives `503`, the Ticket stays In Review, the grants stay active; the
  retry succeeds.
- Concurrency: 6 concurrent accepts, one 200 and five 400; 8 rounds of
  accept against revoke end either revoked (revoke 200) or ended (revoke
  `grant_ended`); another Ticket's checks in a loop keep allowing during
  an accept. No deadlock, under `-race` too.
- Constraints: a time grant cannot be `ended_at_done`; state and
  `ended_at` go together; ending cannot precede approval; unknown state.
- A clock behind the approval records `ended_at = approved_at`.
- Contract: `TestEndedGrants_ResponsesMatchContract` validates accept,
  read, list and the `grant_ended` revoke against the schema.

### Falsification

Each mutation applied alone, the Galley tests listed run, then restored
with `git checkout` (`git diff` empty after each).

| Mutation | Result |
|----------|--------|
| Ending call never runs on Accept | killed (several `TestDone_*`) |
| Ending committed after the Accept transaction, in its own | killed (`EndsEvery…`, `EndsTheGrantsOfEveryAgent…`, `EndingAndTheStatusChangeCommitTogether`, contract) |
| Only the first grant ended | killed |
| Other Tickets' grants ended | killed |
| Time grants ended (CHECK dropped as well for the SQL-only variant) | killed |
| Rework (In Review to Ready) ends grants | killed (incl. pre-existing authority tests) |
| Ended grant still allows | killed |
| Ended grant read as `expired` | killed |
| Ended grant revocable (rejection removed) | killed |
| Ended grant renewable (state filter widened) | **survived**: equivalent, the renewal query also requires `form = 'time'` and no ended grant has it; the CHECK enforces that |
| Ticket-level block on fresh grants | killed (`AFreshGrantAfterReopening…`) |
| Revoked grants also ended | killed |
| Ending not clamped to the approval time | killed (clock-behind test) |
| CHECK `only_ticket_form_ends_at_done` removed | killed (constraint test) |
| CHECK `ended_at_follows_state` removed | killed |
| Plain status command accepts Done (first guard removed) | **survived**: equivalent, the transition table has no Done target so the command still answers `invalid_transition` (defence in depth) |
| A new `UPDATE tickets SET status` in an extra file | killed (inventory test) |
| Swiftlet parser drops `ended_at_done` | killed (`tickets.test.ts`) |
| Swiftlet labels the tag **Revoked** | killed (`TicketDetail.test.tsx`) |
| Swiftlet parser drops `endedAt` | killed (6 tests) |

Not mutated: the e2e spec (one mutation run of the whole suite was not
repeated); the Galley behaviours it shows are the same as above.

## Implementation limitations and follow-ups

- The ending is a function call, not a database trigger. A future Status
  write to Done that skips it is caught by the inventory test, not by the
  database. Raise it if M8's merged-PR path adds a second route.
- The check-versus-accept race cannot be exercised on one Ticket: a
  Ticket in In Review has no running Round, so a check after the accept
  is refused as `round_not_running`/`round_not_open` before any grant is
  read. The concurrent test covers the neighbours instead (another
  Ticket's checks, revoke, repeated accepts).
- Done → Ready via a reviewed PR merge (D4) stays M8. Reconcile on
  reconnect is M5.12, recovery M5.13, limits M5.14: not touched.

## Outstanding checks and owning milestone

Reviewed-PR completion and its grants: M8 (#9). Gate-report reconciliation
of the evidence index: the M5 gate-report slice.

## Decision impacts (open-decision IDs)

None resolved. D4 (merged-PR reopening) stays open under M8: this slice
adds no transition.
