# Explicit full Connected Account access

## Purpose

M5.9, [#167](https://github.com/cristoforows/ticketIt/issues/167).

A Permission request can now be approved for **full access** to the
requested Connected Account:

- The Owner chooses the scope in the request panel before approving:
  **Only what was requested** (the default) or **Full access to the
  `<account>` account**. The approve body is `{form, scope?}`, where
  `scope` is `requested` (the default) or `full`. It applies with
  either form: for this Ticket, or for a time with expiry and renewal.
- A full grant lets its Agent use every capability (action and resource
  pattern) the account declares, without another request. Anything the
  account does not declare is refused, `400 capability_not_supported`,
  whatever the grants.
- Full access is never implied: not by granular grants, however many,
  and not by having the account.
- Every allow records the grant that allowed it, full or exact.

Touches `contracts/`, `apps/galley`, `apps/michelin` (the rename only),
`apps/swiftlet`, `e2e/` and `CONTEXT.md` (Connected Account, Permission,
Temporary Permission, Approval).

**"Proactively from the request panel"** is read as the choice the
Owner makes in the panel of a pending request, before approving it.
Full access is never created without a request: there is no endpoint
that creates a grant on its own, and the grant is bound to its request
by foreign keys.

## What already existed

- M5.1–M5.8 (#159–#166) were merged to `main`. This branch starts at
  `d9f6d18` (M5.8).
- M5.7 had the controlled Connected Account's static catalogue
  (`connectedAccountActions` in `connected_accounts.go`). It refused an
  out-of-catalogue scope with `400 unsupported_scope`, on both the check
  and `permission_requested`.
- M5.7 also had exact-scope grants, bound by composite foreign keys to
  their request's Ticket, Agent and scope. M5.8 added the time form,
  expiry, `expiredGrantId` and renewal.
- `000023_time_based_grants.up.sql` comments that "M5.9 adds full account
  access" next to the form CHECK. This slice adds full access as a
  scope, not a form, and leaves that forward-only migration untouched.
- **Baseline** (the M5.8 record): Galley 468 top-level tests; Michelin
  387; Swiftlet 659 (27 files); browser suite 45 specs, 99 tests.

## What this slice added

**The rename.** `unsupported_scope` is now `capability_not_supported`
everywhere: Galley, the contract, Michelin, the READMEs and the tests.
This is the code #167's Settled Decisions name. The condition is
unchanged: a scope outside the account's declared capabilities. The
Decision renames it because with full access, "scope" no longer names
what is refused. The refused thing is a capability the account does not
declare, even when a full grant exists. Michelin handles only the new
code. A Galley still answering `unsupported_scope` would abandon the
Round, as any other refusal does; a test covers this.

**Contract** (`contracts/openapi.yaml`; `api.gen.go` and both
`schema.d.ts` regenerated):

- New `PermissionGrantScope`: `requested | full`.
- `ApprovePermissionRequest` gains an optional `scope`.
- `PermissionGrant` requires `full`. `action` and `resource` are nullable,
  null exactly when `full`.
- The descriptions of the authority check, `expiredGrantId` and
  `renewsGrantId` state the matching and renewal rules below.
- The error lists say `capability_not_supported`.

**Galley**:

- Migration `000024_full_account_access.up.sql`:
  - `permission_grants.full_access`.
  - Nullable `action`/`resource`, with a CHECK that they are null
    exactly when `full_access`.
  - `permission_grants_request_account_fk` binds every grant to its
    request's Ticket, Agent and account. It is needed because the
    existing scope key skips a row with a NULL column (MATCH SIMPLE).
  - A partial index for the full-access read.
  - `permission_requests.renews_full_access`, with an account-level
    foreign key to the renewed grant. The existing scope-level renewal
    key is rebuilt on a generated `renews_scoped_grant_id`, so it still
    binds a renewal of a granular grant to the exact scope.
- `round_authority.go`: `checkAuthority` checks the capability against
  the catalogue before it opens the transaction. The allow and expired
  reads match `full_access OR (action, resource)`, on the same account
  and Agent, under the #166 form rules.
- `round_permissions.go`:
  - `decideGrantTerms` reads `scope`.
  - The grant insert writes `full_access` and nulls the scope.
  - `renewedGrant` accepts an expired full grant of the same account
    and returns whether it was full.
  - The grants view carries `full`.
- `connected_accounts.go`: `capabilityNotSupportedCode` and
  `undeclaredCapability`.

**Michelin**: the rename. Its log line is now "authority check refused
an undeclared capability", and its failure explanation is "the
Connected Account does not declare this capability". Full access
changes nothing in Michelin. It never caches an allow and checks live
before every `act`.

**Swiftlet**:

- `PermissionPanel` adds the **Access** radio group, the warning (the
  full radio's description), the wording of the forms, hint and button,
  and **Full access allowed …**.
- A full grant reads **has Full access to the `<account>` account**.
- An allow by a full grant reads **by full access**, and a renewal of
  an expired full grant says so.
- A `FullAccessTag` (ink on paper, inverted from the existing tags; no
  new colour).
- The parsers check `full` against null `action`/`resource`.

**e2e**:

- `tests/runner-full-access.spec.ts`, registered in `run.sh` after
  `runner-time-grant.spec.ts` with its own exit code.
- In `support/tickets.ts`, `PermissionGrant.full`, a nullable scope, and
  an optional `scope` on `GrantChoice`.

### The matching rule

An authority check `(account, action, resource)` by a Round answers as
follows:

1. If the account does not declare `action` with a resource pattern that
   `resource` matches, the answer is `400 capability_not_supported` and
   nothing is recorded. This happens before any grant is read, so no
   grant can widen what the account declares.
2. Otherwise it is `allow` when an `active` grant exists with the
   Round's Owner, the Round's Agent and the check's account, and:
   - either `full_access`, or the same action and resource byte for
     byte;
   - and either the ticket form on the Round's Ticket, or the time form
     with `expires_at > now` (Galley's clock).

   When an exact grant and a full grant both match, the exact one is
   recorded (`ORDER BY full_access, id`). A full grant is used only when
   nothing narrower allows the check.
3. Otherwise it is `deny`. The deny names the newest expired time grant
   that would have allowed it, exact or full, as `expiredGrantId`.

A renewal (`renewsGrantId`) is accepted when it names one of three
grants: an expired time grant of the Round's Agent for the same scope
(as in #166); an expired time grant of that Agent with full access to
the same account; or nothing. The Owner then approves it as the
requested scope or in full.

### Engineering choices beyond the Decisions

| Choice | Reason |
| --- | --- |
| `full_access` is a column with nullable `action`/`resource`, under a CHECK | A sentinel such as `*` would be a wildcard in the scope columns, and M5.7 forbids wildcards. NULL cannot match the exact-scope comparison. |
| An account-level foreign key alongside the scope-level one | Under MATCH SIMPLE the scope key does not check a full grant, which has a NULL action. The new key still binds it to its request's Ticket, Agent and account. |
| The renewal key is split with `renews_full_access` and a generated column | A renewal of a granular grant stays bound to the exact scope. A renewal of a full grant is bound to the account. |
| The capability check moved into `checkAuthority`, before `Begin` | With a full grant, the catalogue is the only bound. It is now enforced in the same function that reads grants, so no caller can skip it. Nothing is recorded for an undeclared scope, as before. |
| Exact before full when both allow | The record names the narrowest grant that allowed the act. |
| Approving in full grants the request's account only | The Owner approves what was asked about. A grant for another account would need a request on that account. |
| Swiftlet sends `scope` only for full | A requested approval sends the #166 body unchanged. Galley treats an absent `scope` as `requested`, and its tests cover every older body. |
| The warning is the full radio's `aria-describedby` and is shown only when full is chosen | A screen reader announces it on the choice itself. The default (requested) needs no warning. |
| The scope resets to requested for each new request | A full choice never carries over to a request the Owner has not read. |
| `000023`'s "M5.9 adds full account access" comment is left in place | Migrations are forward-only. Full access turned out to be a scope, not a form. |

## Exact versions and toolchain

- Go 1.27.1 (darwin/arm64), `go.mod` `go 1.27.1`; oapi-codegen via the
  `tool` directive in `go.mod`.
- PostgreSQL 17.11 (Homebrew), local.
- Node v26.9.0, npm 11.19.1.
- Swiftlet: React 19.3.0, Vite 8.3.0, Vitest 5.0.1, TypeScript 7.0.2.
- Michelin: Vitest 5.0.1, TypeScript 5.9.3.
- Contracts: openapi-typescript 7.13.0.
- e2e: @playwright/test 1.63.0 (chromium).

## Reproducible commands

```sh
cd apps/galley
gofmt -l . ; go vet ./... ; go build ./...
GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test_m59?sslmode=disable' go test ./... -count=1
GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test_m59?sslmode=disable' go test -race ./... -count=1
./scripts/check-contract-drift.sh

cd ../michelin && npm run typecheck && npx vitest run
cd ../swiftlet && npx tsc -p tsconfig.json --noEmit && npx vitest run && npm run build
cd ../../contracts && ./check-swiftlet-drift.sh && ./check-michelin-drift.sh

cd ../e2e && E2E_DATABASE_URL='postgres://localhost:5432/ticketit_e2e_m59?sslmode=disable' ./run.sh
```

The drift checks refuse a generated file with unstaged changes, so they
run with the generated files staged or committed.

## Observed results

Run 2026-10-05 on the final code. No code changed after these runs;
only this record and the commit followed.

- Drift: all three checks exited 0, with the generated files staged.

  ```text
  OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).
  OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
  OK: ../apps/michelin/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
  ```

- Galley: `gofmt -l .` printed nothing, and `go vet ./...` and
  `go build ./...` were clean.
  - `go test ./... -count=1` exited 0. `go test -json` counted 486
    top-level tests (baseline 468) and 1843 with subtests, 0 failed.
  - `go test -race -count=1 ./...`: every package `ok`
    (`internal/httpapi` 173 s).
  - A `-v` run of the concurrency tests: four trials of six concurrent
    approvals, mixing `full` and requested, each recorded exactly one
    grant, which followed the winning approval. The Stop race logged
    both orders:

    ```text
    --- PASS: TestApprove_ConcurrentFullAndRequestedApprovalsRecordExactlyOneGrant (0.86s)
    --- PASS: TestApprove_AFullApprovalRacingStopLeavesNoGrantOrBothCommands (1.20s)
        round_full_access_test.go:477: map[approved first:1 stopped first:5]
    ```

- Michelin: the typecheck was clean. `Test Files 11 passed (11)`,
  `Tests 389 passed (389)` (baseline 387).
- Swiftlet: `tsc --noEmit` was clean. `Test Files 27 passed (27)`,
  `Tests 676 passed (676)` (baseline 659). `npm run build` succeeded.
- Browser suite: `[run.sh] SUITE PASSED`, exit 0. All 46 specs exited 0
  and 100 tests passed (baseline 45 specs and 99 tests).

  ```text
  Running 1 test using 1 worker
    ✓  1 [chromium] › tests/runner-full-access.spec.ts:34:1 › one full-access approval covers every declared capability of the account without another request, and an undeclared one still fails the Round (2.2s)
    1 passed (2.5s)
  ```

  The new spec failed on its first run because of a bug in the spec
  itself. It waited for the Ticket to be Blocked, which a Round waiting
  on a request already is, so it read the Round before the Round
  failed. The spec's open Round then also failed
  `active-order-slip.spec.ts`. The spec now waits for the Round's
  `failed` state, and the whole suite passed on the rerun above.

  Among its assertions:
  - The Access group defaults to requested, and no warning is shown.
  - Choosing full shows the warning, and the button reads **Allow full
    access for this Ticket**.
  - The posted body is exactly `{"form": "ticket", "scope": "full"}`.
  - The one grant has `full: true`, `action: null` and `resource: null`.
  - The Round's checks are one deny, then four allows naming that grant,
    with exactly one Permission request.
  - Michelin's log has one "authority check refused an undeclared
    capability" with `400 capability_not_supported` for `delete_note`.
  - The Round is `failed` with Michelin's explanation, and the Ticket is
    Blocked with no open Round.
  - After a reload, the receipt shows the **Full access** tag and four
    *by full access* checks.

## Falsification

Each row breaks the implementation in one place with an uncommitted
script. The script makes one exact-text replacement, runs the named
suite and restores the file. Afterwards, every break site was checked in
`git diff` to be back to the committed text.

Galley rows ran `go test ./internal/httpapi -count=1 -run
'Full|Grant|Authority|Permission|Approve|Renew|Contract|Time|NoExecution|Ticket_'`.
Michelin and Swiftlet rows ran the app's whole `npx vitest run`.

| # | Break | Result | Failing test(s) |
| --- | --- | --- | --- |
| G1 | the capability check is skipped, so an undeclared scope reaches the grant read | killed | `TestAuthorityCheck_AFullGrantNeverAllowsAnUndeclaredScopeAndNothingIsRecorded`, `…_AFullGrantAppliesOnlyToItsOwnAccount`, the #165 `TestAuthorityCheck_MatchesTheGrantsAgentTicketAndScopeExactly`, both contract tests |
| G2 | a full grant allows on any account | killed | `TestAuthorityCheck_AFullGrantAppliesOnlyToItsOwnAccount` |
| G3 | a full grant allows any Agent | killed | `TestAuthorityCheck_ATicketFullGrantIsBoundToItsAgentTicketAndOwner`, `…_ATimeFullGrantCoversItsAgentOnEveryTicketUntilItsExpiry` |
| G4 | a ticket-form full grant allows on any Ticket | killed | `…_ATicketFullGrantIsBoundToItsAgentTicketAndOwner` |
| G5 | any grant on the account allows every scope (implied full access) | killed | `TestAuthorityCheck_AGranularGrantOrTheAccountAloneNeverImpliesFullAccess`, `TestApprove_ABodyWithoutTheFullScopeGrantsOnlyTheRequestedScope`, `…_AnExactGrantIsNamedBeforeAFullGrant`, and #165/#166 tests |
| G6 | a time-form full grant ignores its expiry | killed | `…_ATimeFullGrantCoversItsAgentOnEveryTicketUntilItsExpiry`, `TestRenewal_AnExpiredFullGrantIsRenewedForTheRequestedScopeOrAgainInFull`, contract test |
| G7 | a full grant is named before an exact one | killed | `TestAuthorityCheck_AnExactGrantIsNamedBeforeAFullGrant` |
| G8 | a full grant matches nothing | killed | `TestAuthorityCheck_AFullGrantAllowsEveryDeclaredScopeWithoutAnotherRequest` and five others |
| G9 | the expired lookup ignores full grants | killed | `…_ATimeFullGrantCovers…`, `TestRenewal_AnExpiredFullGrantIsRenewed…`, contract test |
| G10 | approve ignores `scope: full` | killed | `TestApprove_TheFullScopeRecordsAFullAccessGrantForTheRequestsAgentAndAccount`, `TestApprove_ConcurrentFullAndRequestedApprovalsRecordExactlyOneGrant`, and others |
| G11 | approve grants full access when `scope` is absent | killed | `TestApprove_ABodyWithoutTheFullScopeGrantsOnlyTheRequestedScope`, `…_AGranularGrantOrTheAccountAloneNeverImpliesFullAccess`, and #165/#166 approve tests |
| G12 | an unknown `scope` value is accepted | killed | `TestApprove_TheScopeIsDecodedStrictly`, `TestDecideGrantTerms_FullAccessOnlyWhenTheOwnerNamesIt`, contract test |
| G13 | a renewal cannot name an expired full grant | killed | `TestRenewal_AnExpiredFullGrantIsRenewed…`, contract test |
| G14 | a renewal may name a full grant of another account | survived, then killed | Survived the first pass: the renewal tests named only another Agent's grant. `TestRenewal_AnExpiredFullGrantOnAnotherAccountIsNeverNamedOrRenewed` was added, and the break was re-run: killed |
| G15 | the grants view reports every grant as granular | killed | `TestApprove_TheFullScopeRecords…` and five others, contract test |
| M1 | Michelin treats `capability_not_supported` as an ordinary refusal | killed | `engine.test.ts` "fails the Round on a capability the Connected Account does not declare…", "performs different declared actions under one full-access approval with one request, and fails on an undeclared one", "abandons the Round on M5.7's retired unsupported_scope code…" |
| S1 | the chooser's initial state is full | survived (equivalent) | The panel's per-request effect resets the choice to requested on mount, so the initial value never renders under test. S1b breaks the reset itself. |
| S1b | the chooser resets to full | killed | the #165/#166 approve tests (their bodies gain `scope`) and the full-access tests |
| S2 | approve drops the full scope | killed | `TicketDetail.test.tsx` "approves for this Ticket with the full scope…", "approves for a time with the full scope…" |
| S3 | approve always sends a scope | killed | "sends no scope once the Owner returns to only what was requested" and the #165/#166 approve tests |
| S4 | no warning when full is chosen | killed | "warns what full access allows once chosen…" |
| S5 | the choice carries over to the next request | killed | "goes back to only what was requested for the next request" |
| S6 | the parser accepts a full grant with an action or resource | killed | `tickets.test.ts` "rejects a Ticket with a full grant with an action", "… with a resource" |
| S7 | a full grant renders without the **Full access** tag | killed | "approves for this Ticket with the full scope and shows the full grant Galley returned" |
| S8 | an allow by a full grant omits **by full access** | killed | "marks checks allowed by full access…" |

No break survived the final pass, except S1, which is equivalent.

The migration's constraints were not falsified by editing the migration,
because the test database keeps applied versions. They are exercised
directly by `TestFullAccess_TheDatabaseKeepsAFullGrantScopelessAndBoundToItsRequest`,
which writes rows each constraint must refuse.

The e2e assertions were not falsified separately: each behaviour has a
unit-level or Go-level kill above.

## Implementation limitations and follow-ups

- **One account.** The controlled substitute is still the only
  Connected Account, so full access to it covers three actions and two
  resource patterns. The account-equality tests add a second catalogue
  account only for the length of the test. Real accounts are M8 (#9).
- **No revocation.** A full grant ends only by expiry (time form).
  Revocation and pushing authority changes to a running Round are M5.10
  (#168). Ticket grants still do not end at Done (M5.11, #169).
- **The catalogue is static configuration in code.** A change to an
  account's declared capabilities needs a deploy. A full grant follows
  the catalogue at each check, so a capability added later is covered
  by an existing full grant. This follows from "every declared pair"
  being judged live.
- **Full access is offered only on a pending request.** There is no
  way to grant it without a request, as interpreted above.
- **A Michelin restarted while a Round waits** does not pick the
  approval up, as for every approval (M5.12 #170, M5.13 #171).

## Outstanding checks and owning milestone

- Visual review of the scope chooser, the warning and the **Full
  access** tag by the Owner (M5 gate, #173).
- A screen-reader pass beyond the role, name and description assertions
  here (M5 gate).
- Concurrency between a full grant and revocation, once revocation
  exists (M5.10).

## Decision impacts (open-decision IDs)

None resolved. The slice implements #167's settled Decisions and
touches none of the open decisions.
