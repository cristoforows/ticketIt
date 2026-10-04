# Manual revocation and the authority-changed command

## Purpose

M5.10, [#168](https://github.com/cristoforows/ticketIt/issues/168).

The Owner can now revoke a live grant of either form, full or granular:

- `POST /api/grants/{grantId}/revoke` ends the grant at once. No later
  authority check is allowed by it.
- Under D8 ("Revoke also requests Stop"), each open Round the grant
  covers gets the Owner's Stop through M5.1's path. One Stop is shared
  with any Stop the Owner already requested. An action already allowed
  may complete and stays recorded.
- A grant covering no open Round requests no Stop.
- A repeat returns the revoked grant and records nothing. Revoked grants
  stay listed.
- Approval and revocation record an informational `authority_changed`
  command for each covered open Round. Michelin acknowledges it at any
  claim epoch.
- Swiftlet's grants view has **Revoke** with an accessible confirmation
  that names the Rounds Galley says it will stop.

Touches `contracts/`, `apps/galley`, `apps/michelin`, `apps/swiftlet`,
`e2e/` and `CONTEXT.md` (new: Revocation, Authority Changed; Temporary
Permission now points to Revocation).

## What already existed

- M5.1–M5.9 (#159–#167) were merged to `main`. This branch starts at
  `aead160` (M5.9).
- M5.1 had the Owner's Stop. `requestStopForOwner` locks the Ticket row,
  decides with `decideStop`, and inserts one `stop` command. The
  partial unique index `round_commands_one_stop_per_round` keeps it to
  one per Round. M5.2 ends a Round as Stopped only on `stop_confirmed`.
- M5.7–M5.9 had live checks (`checkAuthority`), ticket and time grants,
  expiry judged at each check, renewal, and full access.
  `permission_grants.state` allowed only `active`. "Expired" was derived
  when read.
- Claims and runner events take the Owner's priority advisory lock
  (`lockOwnerPriority`) before Ticket and Round rows.
- **Baseline** (the M5.9 record): Galley 486 top-level tests; Michelin
  389; Swiftlet 676 (27 files); browser suite 46 specs, 100 tests.

## What this slice added

**Contract** (`contracts/openapi.yaml`; `api.gen.go` and both
`schema.d.ts` regenerated):

- `POST /api/grants/{grantId}/revoke` (`revokePermissionGrant`), with
  no body. It answers `200 PermissionGrant`, or the shared `ErrorBody`
  with `grant_expired`.
- `PermissionGrantState` gains `revoked`.
- `PermissionGrant` requires three new fields:
  - `revokedAt`;
  - `allowedActions.revoke`, a `TicketCommandAvailability`;
  - `coveredOpenRounds`, a list of `{roundId, sequence, ticketId,
    ticketTitle}`.
- `RunnerCommandType` gains `authority_changed`.
- Descriptions of the claim epoch, `remainingSeconds`,
  `expiredGrantId`, renewal and approve now cover revocation.

**Galley**:

- Migration `000025_revoke_grants.up.sql`:
  - `state IN ('active', 'revoked')`;
  - `revoked_at`, set exactly when revoked, and never before
    `approved_at`;
  - `round_commands.type` gains `authority_changed`.
- `grant_revocation.go`:
  - the handler, `revokeGrantForOwner` and `decideRevoke`;
  - the covering rule, `grantCoversOpenRoundSQL`;
  - `coveredOpenRounds` and `issueAuthorityChanged`.
- `round_commands.go`:
  - `requestStop` is the M5.1 insert, shared by the Owner's Stop and the
    revoke. It now uses `ON CONFLICT (round_id) WHERE type = 'stop' DO
    NOTHING` in place of a rollback-and-reread on a unique violation.
  - Commands are delivered Stop first, then `authority_changed`, then
    the rest by `issued_at`, `id`.
- `round_authority.go`:
  - the allowing grant row is read `FOR SHARE`;
  - the expired-grant lookup names only `active` rows.
- `round_permissions.go`:
  - the grant JSON adds `revokedAt` and `coveredOpenRounds`;
  - `normalisePermissionGrant` derives `allowedActions.revoke` from
    `decideRevoke`, the decision the command uses;
  - renewal requires an `active` grant;
  - approve records `authority_changed` for the Rounds the new grant
    covers.

**Michelin** (`commandLoop.ts`): `authority_changed` is logged and
acknowledged `applied` at any epoch. Michelin keeps no authority
between actions: each `act` already asks Galley first. So "re-checks
before its next action" holds without a cache to clear.

**Swiftlet**:

- `api/tickets.ts` parses the new fields strictly and adds
  `revokePermissionGrant`, with `GrantNotFoundError` for the shared 404.
- `PermissionPanel.tsx`:
  - **Revoke** is shown on grants whose `allowedActions.revoke` is
    available.
  - The Radix dialog *Revoke this grant?* is labelled and described by
    its text, traps focus, closes on Escape and opens on **Cancel**.
  - It names each Round in `coveredOpenRounds` and says completed
    actions are not undone.
  - A revoked grant shows **Revoked** and its time.
- `TicketDetailPage.tsx`: after a revoke, the page reloads the Ticket
  and its Rounds. After a refusal or a 404 it reloads the receipt.

**e2e**:

- New `tests/runner-revoke.spec.ts`, registered in `run.sh` with its own
  exit code.
- `runner-permission.spec.ts` expects the approval's extra
  `authority_changed` ack.
- `support/tickets.ts` has the new grant fields.

### The covering rule

A grant `g` covers a Round `cr` when:

- both belong to the same Owner and the same Agent;
- `cr` is open (`claimed`, `running` or `waiting_for_input`);
- and, for the ticket form only, `cr` is on the grant's Ticket.

A time grant covers its Agent's open Rounds on any Ticket. Full access
follows its form. The account is not part of the rule, because a Round
has no account: any open Round of the Agent could act on it.

The rule is one SQL fragment. The revoke uses it to choose the Rounds
it stops, and the read model uses it for `coveredOpenRounds`, so the
dialog names exactly what the command stops. Swiftlet never evaluates
it. `TestGrantCoversOpenRound_IsItsAgentsOpenRoundsOnItsTicketForTheTicketForm`
runs it over synthetic rows: each form; another Agent, Ticket or
Owner; each open and each ended state.

### Lock order

A revoke takes, in order:

1. the Owner's priority advisory lock;
2. each covered Ticket row (`lockTicketForMutation`, by Ticket id);
3. the grant row, `FOR NO KEY UPDATE`.

Then it decides, updates, inserts the Stops and `authority_changed`, and
commits. The reasons:

- **The priority lock first.** Claims and runner events take it, so
  under it the covered set cannot change before the commit. No Round
  can be claimed or end between reading the covered set and stopping
  it. A covered Ticket whose open Round differs under its lock is an
  error: `503`, and nothing is recorded.
- **Ticket rows next.** They are the M5.1 Stop's lock, so a revoke and
  the Owner's Stop serialise. Approve also locks the Ticket before the
  request, which keeps approve and revoke in one order.
- **The grant row last.** An authority check holds its Round row `FOR
  SHARE` while it reads the grant row `FOR SHARE`. The event path holds
  the priority lock while it waits for a Round row. Taking the grant row
  last means a revoke never holds the grant while waiting on something
  a check holds.

The effect on checks:

- A check that already holds the grant finishes first. Its allow
  commits before the revocation.
- A check queued behind the revoke re-reads the row after the revoke
  commits. With `LIMIT 1 … FOR SHARE`, PostgreSQL re-checks
  `state = 'active'` and skips the revoked row, so the check denies.
- No allow commits after its grant's revocation.

Tests:

- `TestAuthorityCheck_QueuedBehindARevokeDenies`
- `TestRevoke_WaitsForACheckThatHoldsTheGrant`
- `TestRevoke_RacingChecksNeverDeadlocksAndEveryLaterCheckDenies`
- `TestRevoke_TakesThePriorityLockAndTheTicketRowBeforeTheGrantRow`: an
  outside transaction holds the grant row, and the test proves the
  waiting revoke already holds both earlier locks.

### No command on expiry

The issue's "What to build" lists expiries among the events that issue
`authority_changed`. Its Decisions section does not. Expiry issues none
here, for these reasons:

- Every check compares `expires_at` with Galley's clock in the check's
  own transaction. An expired grant is refused at the instant it
  expires, whether or not anything is delivered.
- Michelin holds no authority to invalidate.
- An expiry command would need a job that watches the clock: a new
  scheduler, or a sweep on some request path. That adds a moving part
  whose only effect is a log line in Michelin.
- Its delivery time would also be later than the expiry itself, so it
  would imply a guarantee it cannot keep.

`TestAuthorityChanged_ExpiryIssuesNoCommandBecauseEveryCheckReadsTheClock`
pins this: past the expiry the next check denies, and no command
exists. If the Owner wants the command on expiry too, it is a
follow-up, listed below.

### Engineering choices beyond the Decisions

| Choice | Reason |
| --- | --- |
| `authority_changed` is informational and not epoch-fenced | It asks for nothing. Every action re-checks with Galley, so a stale delivery is harmless. Michelin acks `applied` at any epoch, and a replay is a no-op. |
| Approve also records `authority_changed` for the Rounds its grant covers | The issue names approvals. A covered Round that is not the waiting one, such as another Ticket under a time grant, learns of the new authority too. |
| Command order: Stop, then `authority_changed`, then the rest by `issued_at` | Stop must win. `authority_changed` before `approval` lets a runner see the change before the resume it explains. |
| Expired grants are refused `400 grant_expired` | An expired grant already authorizes nothing, so there is nothing to end. A revoked state would also misreport how it ended. Owner rejections in this API are `400` (`writeTransitionRejection`). |
| A repeat on a revoked grant is `200` with the stored grant | Required by the Decision. It takes the same locks and records nothing. |
| `revoked_at = GREATEST(clock, approved_at)` | The dev clock can be set behind an approval. The constraint that a revocation is never before its approval would otherwise turn a revoke into a `503`. |
| A revoked time grant reads `remainingSeconds: 0`, state `revoked`, never `expired` | The state says how it ended. A revoked grant is never named as `expiredGrantId` or renewed, because renewal restores what expired, not what the Owner withdrew. |
| `coveredOpenRounds` is empty unless revoke is available | The dialog names only what a revoke would stop. The parser refuses a list on a grant revoke cannot reach. |
| The shared Stop insert uses `ON CONFLICT … DO NOTHING` | A revoke stops several Rounds in one transaction. A unique violation would abort the whole transaction, so the M5.1 rollback-and-reread cannot be reused inside it. |
| An unexpected Stop rejection inside a revoke is a `503` | Under the locks it cannot happen. If it did, Galley refuses to commit a revocation without its Stop (fail closed). |
| Swiftlet reloads the Ticket after a revoke, not only the grant | The response is the grant. Stopping is the Ticket's state. |
| A failed revoke closes the dialog and shows an alert under the grants | After a 404 or refusal the receipt reloads, and the grant (and its dialog) may leave the list. The message must outlive it. |
| The e2e pauses Michelin with `SIGSTOP` across the Stopping check | With a 1 s command poll, Michelin could confirm the Stop before the reloaded receipt shows Stopping. Pausing it makes the check deterministic without changing what is tested. |

## Exact versions and toolchain

- Go 1.27.1 (darwin/arm64), `go.mod` `go 1.27.1`; oapi-codegen via the
  `tool` directive in `go.mod`.
- PostgreSQL 17.11 (Homebrew), local.
- Node v26.9.0, npm 11.19.1.
- Swiftlet: React 19.3.0, Vite 8.3.0, Vitest 5.0.1, TypeScript 7.0.2,
  @radix-ui/react-dialog 1.1.23.
- Michelin: Vitest 5.0.1, TypeScript 5.9.3.
- Contracts: openapi-typescript 7.13.0.
- e2e: @playwright/test 1.63.0 (chromium).

## Reproducible commands

```sh
cd apps/galley
gofmt -l . ; go vet ./... ; go build ./...
GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test_m510?sslmode=disable' go test ./... -count=1
GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test_m510?sslmode=disable' go test -race -count=1 ./...
./scripts/check-contract-drift.sh

cd ../michelin && npm run typecheck && npx vitest run
cd ../swiftlet && npx tsc -p tsconfig.json --noEmit && npx vitest run && npm run build
cd ../../contracts && ./check-swiftlet-drift.sh && ./check-michelin-drift.sh

cd ../e2e && E2E_DATABASE_URL='postgres://localhost:5432/ticketit_e2e_m510?sslmode=disable' ./run.sh
```

The drift checks refuse a generated file with unstaged changes, so they
run with the generated files staged.

## Observed results

Run 2026-10-05 on the final code. No code changed after these runs.
Only this record and the commit followed.

- Drift: all three checks exited 0, with the generated files staged.

  ```text
  OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).
  OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
  OK: ../apps/michelin/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
  ```

- Galley:
  - `gofmt -l .` printed nothing. `go vet ./...` and `go build ./...`
    were clean.
  - `go test ./... -count=1` exited 0. `go test -json` counted 508
    top-level tests (baseline 486) and 1894 with subtests, 0 failed.
  - `go test -race -count=1 ./...`: every package `ok`
    (`internal/httpapi` 175 s).
  - A `-v` run of the concurrency tests. Six revoke/approve races
    logged both orders. The other tests passed as below:

    ```text
    --- PASS: TestRevoke_ConcurrentRevokesRecordOneRevocationOneStopAndOneAuthorityChange (0.83s)
    --- PASS: TestRevoke_RacingTheOwnersStopRecordsOneStop (1.17s)
        grant_revocation_test.go:480: map[approved first:4 revoked first:2]
    --- PASS: TestRevoke_RacingAnApprovalOnTheCoveredRoundLeavesTheStopFirstOrRefusesTheApproval (1.15s)
    --- PASS: TestAuthorityCheck_QueuedBehindARevokeDenies (0.14s)
    --- PASS: TestRevoke_WaitsForACheckThatHoldsTheGrant (0.15s)
    --- PASS: TestRevoke_RacingChecksNeverDeadlocksAndEveryLaterCheckDenies (0.73s)
    ```

- Michelin: the typecheck was clean. `Test Files 11 passed (11)`,
  `Tests 394 passed (394)` (baseline 389).
- Swiftlet: `tsc --noEmit` was clean. `Test Files 27 passed (27)`,
  `Tests 702 passed (702)` (baseline 676). `npm run build` succeeded.
- Browser suite: `[run.sh] SUITE PASSED`, exit 0. All 47 specs exited 0
  and 101 tests passed (baseline 46 specs and 100 tests).

  ```text
  ✓  1 [chromium] › tests/runner-revoke.spec.ts:20:1 › revoking a grant mid-Round in the browser stops the Round it covers: Stopping, then Backlog with the Stopped Badge, and the receipt keeps the allowed check and the action performed (5.4s)
  ```

  The first full run had one failure, in `runner-permission.spec.ts`.
  It expected one command acknowledgement, and the approval's new
  `authority_changed` added a second. The failure was deterministic,
  not a flake. The spec now expects the `authority_changed` ack and
  the approval's ack, and checks that `resumed` comes before the
  approval's ack. In the same first run, `runner-revoke.spec.ts` passed
  (5.4 s). Both passed in the final run above.

  `runner-revoke.spec.ts` asserts the following:
  - Before the revoke, the grant's `coveredOpenRounds` names Round 1 of
    the Ticket.
  - The dialog opens with focus on Cancel. It names Round 1 and the
    Ticket title, and says completed actions are not undone.
  - Escape closes the dialog and leaves the grant active.
  - Confirming posts the revoke and answers `200`, `revoked`. The grant
    shows **Revoked** with Galley's `revokedAt`, has no **Revoke**
    button, and the header shows Stopping. The open Round has
    `stopRequestedAt`.
  - Once Michelin resumes, the Ticket is Backlog with the Stopped Badge
    and no open Round, and the grant is still listed as revoked.
  - The stopped Round lists the deny and the allow naming the grant, and
    one *Performed write_note on notes/weekly-report* note.
  - Michelin logged one `action performed`, one `engine stopped` and
    one `stop confirmation reported` (`201`).

## Falsification

Each row breaks the implementation in one place with an uncommitted
script. The script makes one exact-text replacement, runs the named
suite and restores the file. Afterwards, every break site was checked
with `git diff` to be back to the intended text.

- Galley rows ran `go test ./internal/httpapi -count=1 -run
  'Revoke|Grant|Authority|Permission|Approve|Renew|Contract|Time|Full|RoundCommands|NoExecution|Stop'`.
- Michelin and Swiftlet rows ran the app's whole `npx vitest run`.

| # | Break | Result | Failing test(s) |
| --- | --- | --- | --- |
| G1 | the revoke changes no state | killed | `TestRevoke_EndsAGrantOfEitherFormAtOnceAndTheNextCheckDenies`, `…_AnActionAllowedBeforeItCompletes…`, `…_ARepeatReturns…`, `…_ConcurrentRevokes…`, the contract test, and others |
| G2 | the check allows a revoked grant | killed | `TestRevoke_EndsAGrant…`, `TestAuthorityCheck_QueuedBehindARevokeDenies`, `TestRevoke_WaitsForACheckThatHoldsTheGrant`, `…_RacingChecksNeverDeadlocks…`, `…_AnActionAllowedBefore…` |
| G3 | the check does not share-lock the grant row | killed | `TestAuthorityCheck_QueuedBehindARevokeDenies` |
| G4 | the revoke skips the Owner's priority lock | killed | `TestRevoke_TakesThePriorityLockAndTheTicketRowBeforeTheGrantRow` |
| G5 | the revoke locks the grant row before the Tickets | killed, after a test fix | The first pass hung the package until the 10-minute timeout. The test's probe transaction leaked on `t.Fatal`, and the revoke waited on it. The probe is now rolled back before the assertion. The rerun fails `TestRevoke_TakesThePriorityLock…` cleanly |
| G6 | a ticket grant covers its Agent's Rounds on every Ticket | killed | `TestGrantCoversOpenRound_…`, `TestRevoke_StopsOnlyTheOpenRoundsTheGrantCovers` |
| G7 | a time grant covers only its own Ticket | killed | the same two |
| G8 | a grant covers every Agent's Rounds | killed | the same two |
| G9 | a grant covers ended Rounds | killed | the same two, `…_ARepeatReturns…`, the contract test |
| G10 | the revoke requests no Stop | killed | `TestRevoke_ACoveredOpenRoundGetsTheOwnersStopAndEndsOnlyOnStopConfirmed`, `…_ConcurrentRevokes…`, `…_RacingTheOwnersStopRecordsOneStop`, the contract test, and others |
| G11 | the revoke records no `authority_changed` | killed | `TestRevoke_ACoveredOpenRound…`, `TestAuthorityChanged_IsDeliveredAndAcknowledgedWhateverTheClaimEpoch`, `TestRoundCommands_DeliverStopThenAuthorityChanges…`, and others |
| G12 | approve records no `authority_changed` | killed | `TestApprove_RecordsTheGrantAndQueuesAnApprovalCommandWithoutMovingTheRound`, the #166/#167 approve tests, `TestRevoke_RacingAnApproval…` |
| G13 | a repeat revoke is refused | killed | `TestRevoke_ARepeatReturnsTheRevokedGrantAndRecordsNothing`, `…_ConcurrentRevokes…`, the contract test |
| G14 | an expired grant can be revoked | killed | `TestRevoke_AnExpiredGrantIsRefusedChangingNothingAndAdvertisedSo`, the contract test |
| G15 | the expired lookup names a revoked grant | killed | `TestRevoke_ARevokedTimeGrantIsNeverExpiredNamedForRenewalOrRenewed` |
| G16 | a revoked time grant can be renewed | killed | the same |
| G17 | a revoked time grant reads as expired | killed | the same, `…_EndsAGrant…`, `…_ARepeatReturns…` |
| G18 | `coveredOpenRounds` is kept when revoke is unavailable | killed | `…_EndsAGrant…`, `…_ARepeatReturns…`, `…_AnExpiredGrantIsRefused…` |
| G19 | `authority_changed` is not ordered before the rest | killed | `TestRoundCommands_DeliverStopThenAuthorityChanges…`, the approve tests |
| G20 | another Owner's grant is found | killed | `TestRevoke_UnknownMalformedAndForeignGrantsAreTheSameNotFoundAndUnauthenticatedIs401` |
| G21 | `revoked_at` is the clock even before the approval | survived, then killed | It survived the first pass: no test set the clock behind an approval. `TestRevoke_AClockBehindTheApprovalRecordsTheRevocationAtTheApproval` was added, and the rerun killed it |
| G22 | the revoke tolerates any Stop rejection | survived (unreachable) | Under the priority and Ticket locks, each covered Ticket's open Round is verified, so `decideStop` can only answer `stop_already_requested`. The check is fail-closed defence and cannot be reached by a test without faking the lock |
| M1 | Michelin leaves `authority_changed` unacknowledged | killed | all five "authority changed" tests in `commandLoop.test.ts` |
| M2 | Michelin acknowledges it `ignored` | killed | the same five |
| S1 | **Revoke** on every grant | killed | "offers Revoke only on a grant Galley says can be revoked…", "revokes, then shows the grant Revoked…" |
| S2 | the dialog does not focus Cancel | killed | "confirms in a labelled, described dialog … and focuses Cancel" |
| S3 | the dialog omits the covered Rounds | killed | the same, "says nothing is stopped when no open Round uses the grant…" |
| S4 | the dialog omits "not undone" | killed | "confirms in a labelled, described dialog…" |
| S5 | the page keeps its stale Ticket after a revoke | killed | `TicketDetailPage.test.tsx` "posts the revoke, then reloads the Ticket…" |
| S6 | a 404 does not reload the receipt | killed | "refreshes the receipt when Galley has no such grant" |
| S7 | a revoked grant does not say Revoked | killed | "revokes, then shows the grant Revoked with its time and the Round Stopping" |
| S8 | the parser accepts a revoked grant without its time | killed | three `tickets.test.ts` rows |
| S9 | the parser accepts covered Rounds on an unrevocable grant | killed | "rejects a Ticket with a revoked grant still covering a Round" |
| S10 | a revoke failure is not shown | killed | the four "closes the dialog and explains …" rows, the 404 page test |
| S11 | the revoke posts to the wrong path | killed | three API and page tests |

After the final pass, every row is killed except G22, which is
unreachable.

The migration's constraints were not falsified by editing the
migration, because the test database keeps applied versions.
`TestRevoke_TheDatabaseKeepsRevokedAtWithTheRevokedStateAndTheNewCommandType`
exercises them directly by writing rows each constraint must refuse.

The e2e assertions were not falsified separately: each behaviour has a
unit-level or Go-level kill above.

## Implementation limitations and follow-ups

- **No command on expiry** (above). The issue's "What to build" lists
  expiry; this slice does not, for the reasons given. Adding a sweep
  would be a follow-up for the Owner to request.
- **No Owner-wide grants list.** Revoke is offered from each Ticket's
  receipt, which the issue allows. A time grant appears on the Tickets
  of its Agent, so it can be revoked from any of them.
- **The dialog's list is as of the last read.** If a covered Round
  starts or ends between the read and the click, Galley stops what is
  covered at commit time, not what the dialog named. The receipt
  reloads right after.
- **Stopping is short in practice.** Michelin polls commands every
  second, so the Stopping state usually lasts about one poll.
- **Ticket grants still do not end at Done** (M5.11, #169). A Michelin
  restarted while a Round waits does not pick up commands it had not
  seen (M5.12 #170, M5.13 #171).

## Outstanding checks and owning milestone

- Visual review of **Revoke**, the dialog and the **Revoked** tag by
  the Owner (M5 gate, #173).
- A screen-reader pass beyond the role, name, description and focus
  assertions here (M5 gate).
- Whether expiry should also issue `authority_changed`, for the Owner
  (see limitations).

## Decision impacts (open-decision IDs)

None resolved. The slice implements D8 ("Revoke also requests Stop") as
settled for M5 in #168, and touches no open decision.
