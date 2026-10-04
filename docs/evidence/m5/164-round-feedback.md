# Round feedback for the next Round, and the reopen route

## Purpose

M5.6, [#164](https://github.com/cristoforows/ticketIt/issues/164),
resolving [#154](https://github.com/cristoforows/ticketIt/issues/154).

The Owner adds **Round Feedback** on a delivered Round of an Agent
Ticket in In Review or Done. The next Round's claim carries every
comment no earlier Round received, once, whether that Round comes from
rework or from moving a Done Ticket back to Ready. Michelin's controlled
engine records what it received in one progress note, so the receipt
shows that delivery.

Touches `contracts/`, `apps/galley`, `apps/michelin`, `apps/swiftlet`,
`e2e/` and `CONTEXT.md` (new **Round Feedback**).

### The reopen route

**Done → Ready, through the existing status command
(`POST /api/tickets/{id}/status` with `{"status":"Ready"}`), is the
supported way to reopen an Agent Ticket.** It queues the Ticket for a
new Round at the bottom of Ready, exactly as before this slice
(`TestDelivered_ADoneTicketMovedBackToReadyIsQueuedForANewRound` still
passes). Feedback is optional on this route and on rework. No separate
reopen command was added. Moving this statement into `docs/v1-scope.md`
and D3 is the gate slice's job. The Permission effects of reopening are
M5.11.

## What already existed

- M5.1–M5.5 (#159–#163) were merged to `main`. This branch starts at
  `1fe521e` (M5.5).
- Delivery to In Review with a retained Report (M4.10). Bodyless
  explicit rework, In Review → Ready (M4.11). Done → Ready queueing a
  new Round (D3). Failed and Interrupted → Blocked → Ready (M5.3).
- `Ticket.delivery` was the latest Round when that Round delivered.
- A claim's `ticket` carried `id, title, goal, context,
  successCriteria, constraints, repository`.
- **Baseline** (the M5.5 record):
  - Galley: 409 top-level tests, 1465 with subtests.
  - Michelin: 344. Swiftlet: 555 (27 files).
  - Browser suite: 42 specs, 94 tests.

## What this slice added

**Contract** (`contracts/openapi.yaml`; `api.gen.go` and both
`schema.d.ts` regenerated):

- `POST /api/tickets/{id}/rounds/{roundId}/feedback`
  (`addRoundFeedback`). It takes `AddRoundFeedbackRequest {body}` (1 to
  10000 characters) and returns `201` with the Ticket.
- `RoundFeedback {id, body, createdAt, consumedBy}`, where `consumedBy`
  is `RoundFeedbackConsumer {roundId, sequence}` or `null`.
  `TicketRound.feedback` is required.
- `TicketAllowedActions.feedback` is required.
- `ClaimedTicket.feedback` is a required list of
  `ClaimedFeedback {roundId, roundSequence, body, createdAt}`.
- New error code: `feedback_not_available`.

**Galley**

- Migration `000021_round_feedback.up.sql`:
  - a new `round_feedback` table;
  - a unique `(owner_id, ticket_id, id)` on `rounds`, so both Round
    references are composite foreign keys within one Ticket;
  - checks for length, blankness, and a Round not consuming its own
    feedback;
  - a partial index on unconsumed feedback per Ticket.
- `round_feedback.go`:
  - `decideFeedback`, the one decision for the command and for
    `allowedActions.feedback`;
  - `AddRoundFeedback` / `addFeedbackForOwner`, under the Ticket row
    lock;
  - `consumeFeedback`, called by `insertClaimedRound` in the claim's
    transaction;
  - `roundFeedback`, for the Round list.
- `rounds.go`: the claim fills `ticket.feedback`.
  `ticket_rounds.go`: `feedback` per Round. `agent_readiness.go` /
  `ticket_lifecycle.go`: `allowedActions.feedback`. `handler.go`: the
  405 registration.
- Tests:
  - `round_feedback_test.go` (13 tests);
  - `TestRoundFeedback_ResponsesMatchContractAndMethod405` in
    `contract_test.go`;
  - `round_feedback` in `no_execution_side_effects_test.go`'s
    known-table list, and the feedback path in its manual-actions test;
  - the table in the snapshot helpers of `round_events_test.go` and
    `ticket_rework_test.go`;
  - the claim's empty `feedback` in `rounds_test.go`.

**Michelin**

- `galley/runner.ts`: `parseClaim` requires `ticket.feedback`, with
  each item checked.
- `engine.ts`: `feedbackNote`, and the note sent right after `start`
  when the list is not empty.
- `claimLoop.ts`: `round claimed` logs the feedback count.
- Tests: the "feedback from earlier Rounds" describe in
  `engine.test.ts` (4 tests), five invalid-feedback claims in
  `claimLoop.test.ts`, and fixtures updated.

**Swiftlet**

- `api/tickets.ts`: `allowedActions.feedback` is required;
  `addRoundFeedback`.
- `api/rounds.ts`: `feedback` is required on every Round.
- `components/FeedbackPanel.tsx` (new):
  - `FeedbackPanel`: the form and its rejection message;
  - `FeedbackHistory`: per-Round comments and whether a Round received
    them.
- `RoundsSection.tsx`, `TicketDetail.tsx`, `TicketDetailPage.tsx`: the
  panel, the command, the Round list reload, and the refresh on
  `feedback_not_available`.
- Tests:
  - `TicketDetail.test.tsx` ("feedback for the next Round", 9 tests);
  - `TicketDetailPage.test.tsx` (2);
  - `api/tickets.test.ts` and `api/rounds.test.ts`;
  - existing fixtures updated for the new required fields.

**e2e**

- `tests/runner-feedback.spec.ts` (two tests), registered in `run.sh`
  after `runner-ask.spec.ts` and before `active-order-slip.spec.ts`,
  with an exit check. No reset is needed: `runner-ask.spec.ts` leaves
  no Round open, and this spec leaves both its Tickets Done.
- `support/tickets.ts` carries the new fields and `addFeedbackDirect`.
- Two specs updated for the new required fields:
  `runner-claims.spec.ts` (`allowedActions` equality) and
  `runner-engine.spec.ts` (Round-list equality).

**Docs:** the Galley, Michelin, Swiftlet and e2e READMEs. In
`CONTEXT.md`: **Round Feedback** is added (grep found no entry).

### Engineering choices beyond the Decisions

- **Any delivered Round of the Ticket takes feedback, not only the
  latest.** The Decision says "a delivered Round", so that is what is
  implemented. My first version accepted only `delivery.roundId` (the
  latest Round, when delivered). I changed it before committing,
  because that was narrower than the Decision.
- **`allowedActions.feedback` answers for `delivery.roundId`.** It is
  `decideFeedback` with "the latest Round is delivered". It is a
  per-Ticket field, like the others, and it names the Round the
  receipt's form targets. When the latest Round is not delivered, it
  reads unavailable even if an earlier Round would take feedback.
- **Swiftlet's form targets `delivery.roundId` only.** An earlier
  delivered Round accepts feedback through the API, but the receipt
  offers one form, for the latest delivered result, and lists every
  Round's comments under that Round.
- **Check order:** archived, Agent-assigned, open Round (with its
  `roundId`), In Review or Done, Round delivered. A `404` comes first,
  for an unknown or malformed id, another Owner's, or a Round of
  another Ticket.
- **`201 Created` with the Ticket.** The command creates a record,
  unlike the answer's `200`. Errors use `400`, like every
  `transitionRejection`.
- **The body follows the progress note's text rules:** not blank (Go's
  `unicode.IsSpace`), and no control characters except tab and line
  feed. The 10000-character limit is in runes. Michelin copies the body
  into a progress note, which Galley validates with the same rules.
  The database keeps a length check and an ASCII-blank backstop.
- **Feedback is consumed in the claim's transaction under the Ticket
  row lock,** right after the Round is inserted. Feedback, rework,
  status changes and the claim all take that lock, so a comment is
  either in this claim or still waiting for the next one, never both
  and never lost. A race test runs comments, rework and claims
  concurrently, and a concurrency test runs simultaneous claims.
- **A claim is not replayed.** Each claim creates a new Round, so a
  claim response whose delivery is lost takes its feedback with it.
- **Feedback consumed by a Round that then fails, is interrupted or is
  stopped is not re-sent.** The issue says consumed feedback is fixed
  to its Round. The receipt shows it as "Sent to Round N" under the
  Round it was on.
- **Feedback is refused while a Round is open,** with that Round's
  `roundId`. The Decision requires "no open Round". The Ticket is then
  Ready, In Progress or Blocked, so the status check would refuse it
  anyway; the explicit check names the reason.
- **The Michelin note is automatic, not a new script step.** The
  convention is that new Michelin behaviour comes from new, validated
  script steps. Here the behaviour depends on what the claim carries,
  not on the script. A Michelin process runs one script for every
  Round, so a step would have to do nothing on Round 1 and the note on
  Round 2. The note is sent right after `start` when the list is not
  empty, with key `<roundId>:<stepIndex>:feedback`, and it is retried
  like any event.
- **Note wording:** `Owner's feedback received (<n> comment|comments):`
  then one `Round <sequence>: <body>` line per comment, in Galley's
  order (oldest first), truncated to 2000 code points.
- **The `round claimed` log gains a `feedback` count.** The text is
  never logged. The e2e spec uses the count to show that Round 3's
  claim carried nothing.
- **Composite foreign keys keep feedback and its consumer on the same
  Ticket.** This needed a new unique constraint on
  `rounds (owner_id, ticket_id, id)`.
- **The e2e spec runs before `active-order-slip.spec.ts`,** because it
  needs the Owner's slot and that spec leaves a Round open. It reuses
  one Michelin process per test, with one script that delivers every
  Round.

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
GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test_m56?sslmode=disable' go test ./... -count=1
GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test_m56?sslmode=disable' go test -race -count=1 ./...
./scripts/check-contract-drift.sh

cd ../michelin && npm run typecheck && npx vitest run
cd ../swiftlet && npx tsc -p tsconfig.json --noEmit && npx vitest run && npm run build
cd ../../contracts && ./check-swiftlet-drift.sh && ./check-michelin-drift.sh

cd ../e2e && E2E_DATABASE_URL='postgres://localhost:5432/ticketit_e2e_m56?sslmode=disable' ./run.sh
```

The drift checks compare against staged files, so stage the generated
files first.

## Observed results

Run on the final tree, 2026-10-03/04, with everything staged.

- Galley: `gofmt -l .` printed nothing; `go vet ./...` and
  `go build ./...` clean. `go test ./... -count=1` exited 0. By
  `go test -json`, there were 423 top-level tests (baseline 409) and
  1542 with subtests (baseline 1465), 0 failed.
  `go test -race -count=1 ./...`:

  ```text
  ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/galley	6.383s
  ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/githubfake	2.483s
  ok  	github.com/cristoforows/ticketIt/apps/galley/internal/auth	4.014s
  ok  	github.com/cristoforows/ticketIt/apps/galley/internal/config	3.878s
  ok  	github.com/cristoforows/ticketIt/apps/galley/internal/githubfake	2.103s
  ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	128.682s
  ok  	github.com/cristoforows/ticketIt/apps/galley/internal/postgres	3.880s
  ```

  The D3 test, and a `-v` run of the race test, which logs its
  interleavings:

  ```text
  --- PASS: TestDelivered_ADoneTicketMovedBackToReadyIsQueuedForANewRound (0.24s)
      round_feedback_test.go:599: trial 0: 3 of 6 comments accepted, 1 claims during the race
      round_feedback_test.go:599: trial 1: 4 of 6 comments accepted, 1 claims during the race
      round_feedback_test.go:599: trial 2: 6 of 6 comments accepted, 0 claims during the race
      round_feedback_test.go:599: trial 3: 6 of 6 comments accepted, 0 claims during the race
      round_feedback_test.go:599: trial 4: 6 of 6 comments accepted, 1 claims during the race
      round_feedback_test.go:599: trial 5: 5 of 6 comments accepted, 1 claims during the race
  --- PASS: TestFeedback_RacingReworkAndClaimsNeitherLosesNorRepeatsFeedback (1.36s)
  ```

- Drift:

  ```text
  OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).
  OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
  OK: ../apps/michelin/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
  ```

- Michelin: typecheck clean. `Test Files 11 passed (11)`,
  `Tests 353 passed (353)` (baseline 344).
- Swiftlet: `tsc --noEmit` clean. `Test Files 27 passed (27)`,
  `Tests 576 passed (576)` (baseline 555). `npm run build`:
  `✓ built in 138ms`.
- Browser suite: `SUITE PASSED`, exit 0. All 43 specs exited 0, and 96
  tests passed (baseline 42 specs and 94 tests). The new spec:

  ```text
  Running 2 tests using 1 worker
    ✓  1 [chromium] › tests/runner-feedback.spec.ts:57:1 › feedback on a delivered Round reaches a real Michelin's next Round through rework, once (5.0s)
    ✓  2 [chromium] › tests/runner-feedback.spec.ts:126:1 › Done → Ready is the reopen route: feedback added on a Done Ticket reaches the reopened Ticket's next Round (4.4s)
    2 passed (9.8s)
  [run.sh] runner-feedback.spec.ts exit code: 0
  [run.sh] SUITE PASSED
  ```

  In both tests, Round 2's activity on the receipt and in
  `GET /rounds` opens with the note `Owner's feedback received (…):`.
  Round 3, claimed with no new feedback, has no such note, and
  Michelin's `round claimed` logged `feedback` 0, 2, 0.

  The first full run failed in two older specs.
  `runner-claims.spec.ts` and `runner-engine.spec.ts` asserted exact
  `allowedActions` and Round-list equality, which the new required
  fields broke. In that run the new spec passed. Both specs were
  updated. The code then changed from "latest delivered Round" to "any
  delivered Round" (see the choices above), and the whole tree was
  verified again. The results above are from that second run.

## Falsification

Each row breaks the implementation with one exact-text replacement
(an uncommitted script), runs the named suite (Galley:
`go test ./internal/httpapi -run 'Feedback|Claim_|Manual|Delivered_ADone'`;
Michelin and Swiftlet: the full `vitest run`), then restores the file.
The staged diff stat was `52 files changed, 2424 insertions(+), 73
deletions(-)` before and after, and `git diff` (unstaged) was empty
afterwards.

| # | Break | Result | Failing test(s) |
| --- | --- | --- | --- |
| G1 | consumed feedback re-sent (the `consumed_by_round_id IS NULL` filter dropped) | killed | `…TheReworkClaimCarriesAllUnconsumedFeedbackAndLaterClaimsDoNot`, `…IsNotResentToTheRecoveryClaimAfterTheConsumingRoundFails`, contract test |
| G2 | the claim carries no feedback | killed | the rework and reopen tests, contract test |
| G3 | allowed with an open Round | killed | `TestDecideFeedback_AnswersEachCase` only (see below) |
| G4 | allowed on an archived Ticket | killed | `TestDecideFeedback_…`, `TestFeedback_IsRejectedWithoutADeliveredRoundUnderReview` |
| G5 | allowed on a human-assigned Ticket | killed | `TestDecideFeedback_…`, `…IsRejectedWithoutADeliveredRoundUnderReview` |
| G6 | allowed on a non-delivered Round | killed | `TestDecideFeedback_…`, `…IsRejectedWithoutADeliveredRoundUnderReview` |
| G7 | allowed outside In Review and Done | killed | `TestDecideFeedback_…`, `…IsRejected…`, the reopen test, contract test |
| G8 | `allowedActions.feedback` diverges from the command | killed | `…IsRejectedWithoutADeliveredRoundUnderReview` (it checks `allowedActions.feedback` in each case) |
| G9 | the command skips the Ticket row lock | killed | `TestFeedback_TakesTheTicketRowLock` |
| G10 | a Round of another Ticket accepted | killed | `TestFeedback_UnknownForeignAndMismatchedIdsAreTheSameNotFound` |
| G11 | an empty claim list encoded as `null` | killed | `TestClaim_ResponsesMatchContractAndMethod405`, `TestRoundFeedback_…`, `TestClaim_CreatesOneRoundAndLeavesTheTicketReady` |
| G12 | claim feedback newest first | killed | `…TheReworkClaimCarriesAllUnconsumedFeedbackAndLaterClaimsDoNot` |
| M1 | Michelin skips the feedback note | killed | 2 tests in `engine.test.ts` ("feedback from earlier Rounds") |
| M2 | the note is not truncated | killed | `engine.test.ts` "writes one deterministic note and truncates it…" |
| M3 | the claim parser accepts a missing or bad `feedback` | killed | 5 tests in `claimLoop.test.ts` |
| S1 | `parseRound` drops the `feedback` requirement | killed | 4 tests in `api/rounds.test.ts` |
| S2 | the form ignores `allowedActions.feedback` | killed | `TicketDetailPage.test.tsx` "refreshes the receipt when Galley no longer takes feedback, and hides the form" |
| S3 | no refresh on `feedback_not_available` | killed | the same test |
| S4 | Add feedback enabled while blank | killed | `TicketDetail.test.tsx` "offers a labelled feedback form…" (In Review and Done) |
| S5 | consumed state not shown | killed | `TicketDetail.test.tsx` "lists each Round's feedback under that Round…" |

There were no survivors. Two kills are thin:

- **G3 is killed only by the unit test.** With an open Round, the
  Ticket is never In Review or Done, so the status check refuses it
  through the API anyway. The open-Round check adds only the
  `roundId` in the reason.
- **S2 is killed by one test.** The break removed only the form's
  guard. The panel's early return for "unavailable, no error" still
  hid it, so "shows no feedback form when Galley does not offer
  feedback" passed. Only the case with an error on screen reached the
  broken guard.

Not falsified: consuming outside the claim's transaction. The function
takes the claim's `pgx.Tx`, so it has no single-replacement break. The
race and concurrency tests are the cover. The e2e assertions were not
falsified separately, because a full browser run takes about ten
minutes and each behaviour above has a unit- or Go-level kill.

## Implementation limitations and follow-ups

- **Feedback consumed by a Round that fails, is interrupted or is
  stopped is not re-sent.** The Owner can add it again once the Ticket
  is back in In Review or Done after a later delivery. Whether a failed
  Round should give its feedback back is a product question for the M5
  gate.
- **A lost claim response loses its feedback to that Round.** Claims are
  not replayable today. A Round recovered by reconciliation (M5.12 and
  M5.13, #6) does not get it again.
- **The receipt offers one form,** on the latest delivered Round. Feedback
  on an earlier delivered Round is API-only.
- **Feedback is not editable or deletable,** per the Decision.
- **Only the controlled engine reads feedback,** as a note. Real engines
  are later milestones.

## Outstanding checks and owning milestone

- Visual review of the feedback panel and history by the Owner (M5
  gate).
- A screen-reader pass on the panel beyond the role, label and
  description assertions here (M5 gate).
- Moving the reopen-route statement into `docs/v1-scope.md` and D3 (the
  M5 gate slice). Permission effects of reopening (M5.11).

## Decision impacts (open-decision IDs)

None resolved. #154's Owner decision ("Feedback on both routes") is
implemented, and D3's Done → Ready behaviour is unchanged. D1, D2, D4,
D6, D7 and D9 are untouched.
