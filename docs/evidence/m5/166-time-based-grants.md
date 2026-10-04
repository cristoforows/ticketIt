# Time-based grants, expiry and renewal

## Purpose

M5.8, [#166](https://github.com/cristoforows/ticketIt/issues/166).

The second form of **Temporary Permission**:

- The Owner approves a Permission request either **for this Ticket**
  (`{"form": "ticket"}`, as in M5.7) or **for a time**
  (`{"form": "time", "expiresAt"}`), never both.
- A time grant authorizes its Agent and its exact scope on any of that
  Agent's Tickets until `expiresAt`, by Galley's clock. Any Ticket
  reaching Done does not end it.
- Expiry is judged at each authority check. Nothing runs at the expiry
  instant and no stored state changes. After expiry the next check for
  that scope denies, and other scopes keep working.
- A deny that finds the Agent's expired time grant for the scope names
  it (`expiredGrantId`). Michelin's request then carries it as
  `renewsGrantId`: a renewal. Approving a renewal creates a new grant,
  and the expired grant stays recorded as expired.
- The receipt lists the grants that apply to the Ticket with their form,
  scope and expiry.

Touches `contracts/`, `apps/galley`, `apps/michelin`, `apps/swiftlet`,
`e2e/` and `CONTEXT.md` (Temporary Permission, Permission Request,
Approval).

## What already existed

- M5.1–M5.7 (#159–#165) were merged to `main`. This branch starts at
  `270864d` (M5.7).
- M5.7 had the live authority check, Permission requests, the Owner's
  decision and `permission_grants` with one form (`ticket`) and one
  state (`active`), both fixed by CHECK constraints. `form` was already
  an enum in the contract so this slice could widen it.
- The development clock (`POST /api/dev/clock/advance`, #130) and
  `fakeClock` in Galley's tests already existed.
- **Baseline** (the M5.7 record): Galley 450 top-level tests; Michelin
  380; Swiftlet 621 (27 files); browser suite 44 specs, 98 tests.

## What this slice added

**Contract** (`contracts/openapi.yaml`; `api.gen.go` and both
`schema.d.ts` regenerated):

- `PermissionGrantForm` is `ticket | time`; `PermissionGrantState` is
  `active | expired`.
- `ApprovePermissionRequest` takes an optional `expiresAt`.
- `PermissionGrant` requires `expiresAt` and `remainingSeconds` (both
  null on the ticket form).
- `PermissionRequest` requires `renewsGrantId`;
  `PermissionRequestedData` takes an optional `renewsGrantId`.
- `RoundAuthorityCheck` requires `expiredGrantId`;
  `AuthorityCheckResult` takes an optional one on deny.
- `Ticket.permissionGrants` has `maxItems: 50`, and `Ticket` requires
  `permissionGrantCount`.
- New error codes: `grant_form_conflict`, `invalid_grant_expiry`
  (approve) and `invalid_renewal` (`permission_requested`).

**Galley**:

- Migration `000023_time_based_grants.up.sql`: `form` CHECK widened;
  `permission_grants.expires_at`, set exactly on the time form and
  within `(approved_at, approved_at + 30 days]`;
  `permission_requests.renews_grant_id` with a composite foreign key to
  a grant of the same Owner, Agent and scope;
  `round_authority_checks.expired_grant_id`, deny only; a partial index
  for the time-form authority read.
- `round_permissions.go`: `decideGrantForm`, `decideGrantExpiry`,
  `timeGrantLive`, `renewedGrant`, `normalisePermissionGrants`; the
  approve handler's strict decode of `expiresAt`; the grant insert with
  `expires_at`; the grants view and count.
- `round_authority.go`: the allow read with both forms, the expired
  lookup on deny, and `expired_grant_id` in the record and the history.
- `round_events.go`: `permission_requested` validates `renewsGrantId`
  in the event's transaction.
- `ticket.go`: reads `permissionGrantCount` and derives `state` and
  `remainingSeconds` from Galley's clock.

**Michelin**: `checkAuthority` accepts `expiredGrantId` only on deny;
the `act` step forwards it as `renewsGrantId`, and both are logged.

**Swiftlet**: the form chooser and duration in `PermissionPanel`, the
renewal line, the expired-check text, the grant terms (until, time left,
**Expired** tag), the truncated-grants note, and the parsers.

**e2e**: `tests/runner-time-grant.spec.ts`, registered in `run.sh`
after `runner-permission.spec.ts`; `support/tickets.ts` types and
`decidePermissionDirect`'s optional grant.

### The expiry rule

- **Maximum: 30 days.** `expiresAt` must be after the approval time and
  at most 30 days after it; exactly 30 days is accepted. Both bounds
  are enforced in Go (`decideGrantExpiry`) and by the
  `permission_grants_expiry_window` CHECK.
- **Approval time** is Galley's clock at the approval, truncated to
  microseconds (PostgreSQL's precision), raised to the request's
  `requested_at` when that is later, so `decided_at` never precedes the
  request. It is computed inside the approval transaction, after the
  #165 checks, so the expiry is judged against the instant recorded.
- **Boundary.** A time grant allows a check iff `expires_at >
  checked_at`; at exactly `expires_at` it denies. `checked_at` is the
  same Galley clock reading used in the query. The approve rule
  (`expiresAt` after the approval time) is the same predicate
  (`timeGrantLive`), so a grant is never created already expired.
- **No job.** Nothing runs at expiry. A step whose check passed before
  expiry keeps that step; the next check denies.

### Engineering choices beyond the Decisions

| Choice | Reason |
| --- | --- |
| A time grant keeps `ticket_id`, the Ticket it was approved on | The grant row's composite foreign keys tie it to the approved request (Agent, Ticket, scope); dropping the Ticket would have meant weakening those keys. The allow read ignores `ticket_id` for the time form. |
| `state` is never written at expiry; `expired` is derived when read | The Decision says no background job flips state. Deriving from Galley's clock at read time keeps the receipt and the check on one clock. |
| `remainingSeconds` is rounded up | A live grant never shows 0 seconds left; 0 means expired. |
| The deny names only the **newest** expired time grant for the Agent and scope | One request renews one grant. Older expired grants stay recorded and listed. |
| `renewsGrantId` is validated by Galley (expired, time form, the Round's Agent, the same scope, this Owner) and by a composite foreign key | Michelin's claim is not trusted. A bad reference is `400 invalid_renewal` and records nothing, like `unsupported_scope`. |
| Renewal is checked after `event_out_of_order`, so a replay of an accepted renewal still answers 200 | A replay must not be refused because the time moved on. |
| The Ticket's grants view: every grant approved on this Ticket, plus every time grant of its assigned Agent, newest 50, with a count | A time grant applies to every Ticket of its Agent, so it belongs on each receipt. The cap mirrors `authorityChecks` (#165) and keeps the Ticket body bounded now that grants accumulate across Tickets. |
| `expiresAt` is decoded as RFC3339 with a zone; anything else, including `null`, is `invalid_request` | The shared strict decoder already refuses every `null` property, so `{"form": "ticket", "expiresAt": null}` cannot pass as the ticket form. A date or a time without a zone is ambiguous about the instant. |
| Swiftlet offers presets (1 hour, 8 hours, 1 day, 7 days) computed from the browser clock | No free-form date entry to validate in the browser. Galley stays the authority; a refused expiry is explained and the receipt refreshes. |
| The e2e moves time with the dev clock (two hours, while the Round waits on a question) | The Round must be paused between the allowed and the expired check; a question is the existing pause point. |

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
GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test_m58?sslmode=disable' go test ./... -count=1
GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test_m58?sslmode=disable' go test -race ./... -count=1
./scripts/check-contract-drift.sh

cd ../michelin && npm run typecheck && npx vitest run
cd ../swiftlet && npx tsc -p tsconfig.json --noEmit && npx vitest run && npm run build
cd ../../contracts && ./check-swiftlet-drift.sh && ./check-michelin-drift.sh

cd ../e2e && E2E_DATABASE_URL='postgres://localhost:5432/ticketit_e2e_m58?sslmode=disable' ./run.sh
```

The drift checks refuse a generated file with uncommitted changes, so
they run on the committed tree.

## Observed results

Run 2026-10-05 on the committed tree, after the last code change. This
record's text was then finished and every suite below was run again;
the counts were identical.

- Drift: all three checks exited 0.

  ```text
  OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).
  OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
  OK: ../apps/michelin/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
  ```

  The first run of the TypeScript checks found real drift: both
  `schema.d.ts` files predated the last rewording of the approve
  endpoint's description. They were regenerated and committed, and the
  checks then passed.

- Galley: `gofmt -l .` printed nothing, and `go vet ./...` and
  `go build ./...` were clean.
  - `go test ./... -count=1` exited 0. `go test -json` counted 468
    top-level tests (baseline 450) and 1777 with subtests, 0 failed.
  - `go test -race -count=1 ./...`: every package `ok`, no `FAIL` line
    (`internal/httpapi` about 160 s).
  - A targeted `-v` run of the race test logged both orders:

    ```text
    --- PASS: TestApprove_ConcurrentTimeApprovalsRecordExactlyOneGrant (1.07s)
        round_time_grants_test.go:602: map[approved first:1 stopped first:5]
    --- PASS: TestApprove_ATimeApprovalRacingStopLeavesNoGrantOrBothCommands (1.28s)
    ```

- Michelin: the typecheck was clean. `Test Files 11 passed (11)`,
  `Tests 387 passed (387)` (baseline 380).
- Swiftlet: `tsc --noEmit` was clean. `Test Files 27 passed (27)`,
  `Tests 659 passed (659)` (baseline 621). `npm run build` succeeded.
- Browser suite: `[run.sh] SUITE PASSED`, exit 0. All 45 specs exited 0
  and 99 tests passed (baseline 44 specs and 98 tests). The new spec
  also passed on its first run, before any later change:

  ```text
  Running 1 test using 1 worker
    ✓  1 [chromium] › tests/runner-time-grant.spec.ts:55:1 › a time grant allows its Agent across Tickets until Galley's clock passes its expiry, then only that scope asks for a renewal (6.1s)
    1 passed (6.4s)
  [run.sh] runner-time-grant.spec.ts exit code: 0
  ```

  Among its assertions: the time grant's `expiresAt` equals the posted
  one; after the two-hour advance the grant reads `expired` with
  `remainingSeconds` 0 and its `expiresAt` and `approvedAt` unchanged;
  the team-digest check is still `allow` under the ticket grant; the
  weekly-report deny names the expired grant and Michelin's request
  carries it as `renewsGrantId`; an hour from the browser's clock is
  `400 invalid_grant_expiry` and leaves the request undecided; the
  renewal lists three grants (ticket active, time expired, time
  active); the Round delivers with eight checks; and after Done, the
  second Ticket's only check is `allow` under the renewed grant, with
  no request.

## Falsification

Each row breaks the implementation in one place with an uncommitted
script that makes one exact-text replacement, runs the named suite and
restores the file. `git diff | shasum` and the untracked files' hashes
were identical before and after the pass.

Galley rows ran `go test ./internal/httpapi -count=1 -run
'Time|Renew|Grant|Authority|Permission|Approve|Contract|NoExecution|Ticket_'`.
Michelin and Swiftlet rows ran the app's whole `npx vitest run`.

| # | Break | Result | Failing test(s) |
| --- | --- | --- | --- |
| G1 | a time grant allows past its expiry | killed | `TestAuthorityCheck_ATimeGrantAuthorizesItsAgentAndScopeOnEveryTicketUntilExpiry`, `…_ATimeGrantExpiresAtItsInstantByGalleysClockBetweenTwoChecks`, `TestRenewal_NamesTheExpiredGrant…`, contract test |
| G2 | a time grant allows at exactly `expiresAt` (`>=`) | killed | `…UntilExpiry`, `…ExpiresAtItsInstant…`, contract test |
| G3 | a time grant is bound to its originating Ticket | killed | `…UntilExpiry`, `TestAuthorityCheck_ATimeGrantSurvivesItsOriginatingTicketReachingDone` |
| G4 | a ticket grant allows on any Ticket | killed | the #166 authority tests and the #165 `TestAuthorityCheck_MatchesTheGrantsAgentTicketAndScopeExactly`, among nine |
| G5 | a deny names no expired grant | killed | `…UntilExpiry`, `…ExpiresAtItsInstant…`, `TestRenewal_NamesTheExpiredGrant…`, contract test |
| G6 | the ticket form with `expiresAt` is accepted | killed | `TestApprove_RefusesBothFormsAndAnExpiryOutsideTheWindowChangingNothing`, `TestDecideGrantForm_IsTicketOrTimeNeverBoth`, contract test |
| G7 | no 30-day maximum | killed | `TestApprove_RefusesBothForms…`, `TestDecideGrantExpiry_IsAfterTheApprovalAndAtMostThirtyDaysLater` |
| G8 | an expiry equal to the approval time is accepted | killed | `TestApprove_RefusesBothForms…`, `TestDecideGrantExpiry_…`, contract test |
| G9 | renewal of an unexpired grant is accepted | killed | `TestRenewal_OnlyAnExpiredTimeGrantOfTheRoundsAgentForTheSameScopeCanBeNamed` |
| G10 | renewal ignores the Agent (the foreign key still guards) | killed | `TestRenewal_OnlyAnExpiredTimeGrant…` |
| G11 | renewal of a ticket grant is accepted | killed | `TestRenewal_OnlyAnExpiredTimeGrant…` |
| G12 | `expired` is not derived on read | killed | `…ExpiresAtItsInstant…`, `TestNormalisePermissionGrants_DerivesExpiryAndRemainingTimeFromGalleysClock`, `TestRenewal_NamesTheExpiredGrant…` |
| G13 | `remainingSeconds` is rounded down | killed | `TestNormalisePermissionGrants_…` |
| G14 | the grants view omits the Agent's time grants | killed | `…UntilExpiry`, `TestTicket_ListsTheGrantsThatApplyToItNewestFiftyWithTheirCount` |
| G15 | the grants view lists other Agents' time grants | killed | `…UntilExpiry`, `TestTicket_ListsTheGrants…` |
| G16 | the approval time is not raised to `requested_at` | survived, then killed | Survived the first pass. `TestApprove_AClockBehindTheRequestJudgesTheExpiryFromTheRequestTime` was added and the break re-run: killed |
| M1 | the renewal is not forwarded | killed | `engine.test.ts` "raises a renewal naming the expired grant only at the act step that needs it, while other act steps keep running" |
| M2 | an allow naming an expired grant is accepted | killed | `engine.test.ts` "retries a check whose result is an allow naming an expired grant" |
| M3 | a deny with a non-string `expiredGrantId` is accepted | killed | 2 tests in "the act step" |
| S1 | the time form sends the ticket form | killed | `TicketDetail.test.tsx` "approves with the expiry the chosen duration names from now", `TicketDetailPage.test.tsx` "approves for a time…" |
| S2 | the expiry ignores the duration | killed | the same two tests |
| S3 | the page drops the chosen grant | killed | `TicketDetailPage.test.tsx` "approves for a time with the expiry the chosen duration names" |
| S4 | the parser accepts an expired grant with time left | killed | `tickets.test.ts` "rejects a Ticket with an expired time grant with time left" |
| S5 | the parser accepts a missing `permissionGrantCount` | killed | 2 tests in `tickets.test.ts` |
| S6 | the parser accepts an allow naming an expired grant | killed | `rounds.test.ts` "refuses an allow that names an expired grant" |
| S7 | no renewal line | killed | `TicketDetail.test.tsx` "marks a renewal request and the deny that named the expired grant" |
| S8 | no **Expired** tag | killed | `TicketDetail.test.tsx` "lists live and expired time grants…" |
| S9 | no truncated-grants note | killed | the same test |
| S10 | the remaining-time wording is off by a minute | killed | `TicketDetail.test.tsx` "words 3599 seconds left as 59 min left" |

One more break was dropped rather than recorded as a kill: removing the
handler's own check for `"expiresAt": null` survived because the shared
strict decoder already refuses every `null` property. The redundant
check was deleted, and `TestApprove_TheBodyIsDecodedStrictly` covers
both null cases through the shared decoder.

No break survived the final pass. The e2e assertions were not
falsified separately: each behaviour has a unit-level or Go-level kill
above, and a full browser suite takes about twenty minutes.

## Implementation limitations and follow-ups

- **The maximum is fixed at 30 days** in code and in a CHECK. Changing
  it needs a migration.
- **Expiry is a read-time fact.** No command tells a running Michelin
  that a grant expired; the next check denies. Pushing authority
  changes to a running Round is M5.10 (#168).
- **No revocation.** A time grant can only expire. Manual revocation is
  M5.10 (#168). Full account access is M5.9 (#167).
- **Ticket grants still do not end at Done** (M5.11, #169). This slice
  only proves a time grant is unaffected by Done.
- **The receipt's remaining time is as of the last read.** It does not
  count down between refreshes; the receipt refreshes only while a
  Round is open or queued.
- **The browser computes the expiry from its own clock.** When it
  differs from Galley's, Galley refuses an expiry it judges past or too
  far, and the Owner picks another duration. The e2e exercises this
  (an hour is refused after the dev clock moved two hours).
- **The Connected Account is still the substitute `controlled`.** Real
  accounts are M8 (#9).
- **A Michelin restarted while a Round waits for a renewal** does not
  pick it up, as for every approval (M5.12 #170, M5.13 #171).

## Outstanding checks and owning milestone

- Visual review of the form chooser, the grant terms and the **Expired**
  tag by the Owner (M5 gate, #173).
- A screen-reader pass beyond the role, name and label assertions here
  (M5 gate).
- Concurrency between an expiry and revocation, once revocation exists
  (M5.10).

## Decision impacts (open-decision IDs)

None resolved. The slice implements #166's settled Decisions and
touches none of the open decisions.
