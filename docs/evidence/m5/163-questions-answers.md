# Questions and answers resume the same Round

## Purpose

M5.5, [#163](https://github.com/cristoforows/ticketIt/issues/163).

The first **Waiting for Input** path. A new `ask` script step makes
Michelin report `question_raised`. The Round becomes
`waiting_for_input`, and the Ticket becomes Blocked but stays locked and
keeps the Owner's slot. The Owner answers on the receipt. Galley records
the answer and queues an `answer` command. Michelin pulls it, reports
`resumed`, and continues the **same Round** from the step after `ask`.
Questions and answers stay in the Round's history.

Touches `contracts/`, `apps/galley`, `apps/michelin`, `apps/swiftlet`,
`e2e/` and `CONTEXT.md` (Waiting for Input, new **Question** and
**Answer**).

## What already existed

- **M5.4 (#162)** was merged to `main` as a squash, and so were M5.1–M5.3
  (#159–#161). This branch was built on the M5.4 branch tip, whose tree
  is identical to `origin/main`.
- The command channel (`round_commands`, pull and ack) carried only
  `stop`. A Round's open states were `claimed` and `running`.
- `waitingReason` was `starting | working | stopping |
  runner_disconnected`.
- `endRound` worked out the Ticket's prior Status from `started_at`
  (Ready if claimed, In Progress if running).
- Michelin's script steps were `start, wait, progress, usage, deliver,
  hold, fail, interrupt`, and its command loop knew only `stop`.
- **Baseline** (from the M5.4 record):
  - Galley: 388 top-level tests (1366 with subtests).
  - Michelin: 316. Swiftlet: 522 (27 files).
  - Browser suite: 41 specs, 92 tests.

## What this slice added

**Contract** (`contracts/openapi.yaml`; `api.gen.go` and both
`schema.d.ts` regenerated):

- `RoundState` and `OpenRoundState` add `waiting_for_input`.
  `RoundEventType` adds `question_raised` (`QuestionRaisedData
  {questionId, text}`) and `resumed` (`ResumedData {questionId}`).
  `RoundEventResult.questionId` is set for both.
- `RoundQuestion {id, text, askedAt, answer, answeredAt}`.
  `TicketOpenRound.question` is required and nullable.
  `TicketRound.questions` is required.
  `TicketAllowedActions.answer` is required.
- `RoundWaitingReason` adds `waiting_for_answer` and `resuming`.
- `RunnerCommandType` adds `answer`, and `RunnerCommand.answer` is an
  optional `{questionId, text}`.
- `POST /api/tickets/{id}/rounds/{roundId}/questions/{questionId}/answer`
  (`answerRoundQuestion`), which takes `AnswerQuestionRequest {answer}`
  and returns the Ticket.
- New error codes: `question_already_answered`, `answer_not_available`,
  `answer_not_supplied`.

**Galley**

- Migration `000020_questions_and_answers.up.sql`:
  - the state, event and command type constraints are widened;
  - `rounds_timestamps_follow_state` covers `waiting_for_input`;
  - a new `round_questions` table;
  - `round_commands.question_id` is added, with
    `round_commands_one_answer_per_question`;
  - `round_questions_one_unanswered_per_round`.
- `round_questions.go`:
  - `validateQuestionRaisedData` / `validateResumedData`;
  - `raiseQuestion` / `resumeRound` (`moveRoundAndTicket`, guarded on
    the Ticket's expected Status);
  - `decideAnswer`, the one decision for the command and for
    `allowedActions.answer`;
  - `AnswerRoundQuestion` / `answerQuestionForOwner`, which lock the
    Ticket row, then the question row;
  - `roundQuestions` for the Round list.
- `round_events.go`: both events go through the existing ladder.
  - The Round lock query also reads the latest question.
  - `resumed` is accepted only on `waiting_for_input` and only for the
    latest question once it is answered (`409 answer_not_supplied`).
  - `question_raised` is accepted only on `running`.
  - While waiting, only `resumed` and `stop_confirmed` are accepted.
- `round_endings.go`: `ticketStatusHeldBy(state)` replaces the
  `started_at` inference, so `stop_confirmed` from `waiting_for_input`
  moves Blocked → Backlog.
- `round_waiting.go`: `waiting_for_answer` and `resuming` rank below
  `stopping`.
- `ticket.go`, `ticket_rounds.go`, `agent_readiness.go`,
  `ticket_lifecycle.go`: the open Round's question, `questions` per
  Round, and `allowedActions.answer`.
- `round_commands.go`: an `answer` command carries its question's id
  and text. A Stop is listed before any answer.
- `handler.go`: the 405 registration for the new path.
- `usage_observations.go`: `canonicalUUID` is renamed
  `canonicalRunnerUUID`, now shared by `questionId`.
- Tests:
  - `round_questions_test.go` (20 tests);
  - the waiting row in `round_blocked_endings_test.go`;
  - `question_raised` and `resumed` in the lock-order test in
    `round_events_test.go`;
  - the new reasons in `round_waiting_test.go`;
  - `round_questions` in `no_execution_side_effects_test.go`'s
    known-table list;
  - `TestQuestionsAndAnswers_ResponsesMatchContractAndMethod405` in
    `contract_test.go`.

**Michelin**

- `engineScript.ts`: the `ask` step with `question` (the progress
  note's limits), checked at start like every step.
- `engine.ts`:
  - `questionIdFor(roundId, stepIndex)`, a UUID v5;
  - the `ask` case: `question_raised` (key = `questionId`), wait for the
    answer, `resumed` (key `<roundId>:<stepIndex>`), ack, then a
    progress note `Owner's answer: …` (key
    `<roundId>:<stepIndex>:answer`);
  - the evidence for a Stop while waiting.
- `answerInbox.ts` (new): answers delivered by the command loop and
  awaited by the engine. The first answer per question is kept.
- `commandLoop.ts`: an `answer` for the claim's epoch is handed to
  `onAnswer`; another epoch is acked `ignored`.
- `galley/runner.ts`: the result is checked for the expected state and
  `questionId`. The command listing requires `answer.questionId` and
  `answer.text` on an `answer`.
- `claimLoop.ts`: one inbox per Round. The ack closure sends `applied`.
- Tests: an "the ask step" describe in `engine.test.ts`, an "answers"
  describe in `commandLoop.test.ts`, the `ask` rows in
  `engineScript.test.ts`, and `answerInbox.test.ts`.

**Swiftlet**

- `api/tickets.ts`:
  - `parseRoundQuestion`;
  - `waiting_for_input` is an open state;
  - `question` is required exactly when waiting;
  - `allowedActions.answer` is required;
  - `answerRoundQuestion`.
- `api/rounds.ts`: `questions` is required on every Round.
- `components/QuestionPanel.tsx` (new):
  - `QuestionPanel`: the question, the answer form or Galley's reason,
    and the rejection messages;
  - `QuestionHistory`: per-Round questions and answers.
- `RoundsSection.tsx`, `TicketDetail.tsx`, `TicketDetailPage.tsx`: the
  panel at the top of the Rounds section, the answer command, the Round
  list reload, and the refresh on `question_already_answered`.
- `ActiveOrder.tsx` and `styles.css`: the labels **Waiting for your
  answer** and **Resuming**, with the rider idle mid-road.
- Tests:
  - `TicketDetail.test.tsx` ("a question from the Agent", 10 tests);
  - `TicketDetailPage.test.tsx` (2);
  - `ActiveOrder.test.tsx` (2 × list and board);
  - `api/tickets.test.ts` and `api/rounds.test.ts` (parsing and the
    command);
  - existing fixtures updated for the new required fields.

**e2e**

- `tests/runner-ask.spec.ts` (two tests), registered in `run.sh` after
  `runner-interrupted.spec.ts` and before `active-order-slip.spec.ts`,
  with an exit check.
- `support/tickets.ts` carries the new fields and
  `answerQuestionDirect`. `support/runner.ts` carries the `ask` step
  and `RunnerCommand.answer`.
- Existing specs updated for the new fields: `runner-claims.spec.ts`
  (`allowedActions` equality) and `runner-engine.spec.ts` (Round list
  equality).

**Docs:** the Galley, Michelin, Swiftlet and e2e READMEs. In
`CONTEXT.md`: **Waiting for Input** is sharpened, **Question** and
**Answer** are added (grep found neither), and the **Waiting Reason**
list is extended.

### The resume event (Decision: "Record the chosen event")

**`resumed`, not `progress`.** It is a distinct fact with
`data.questionId`, so Galley moves Blocked → In Progress only on the
runner's own report that it is acting on that answer, never on a
progress note that could predate it. A `progress` note would have
needed Galley to infer the resume from an ordinary note. The answer's
text is then recorded in a separate `progress` note, as the Decision
asks.

### Engineering choices beyond the Decisions

- **`question_raised`'s idempotency key must equal `data.questionId`.**
  The replay check is keyed on the idempotency key. Tying it to the
  question means a replay can never record a second question, even
  from a runner that builds a new key.
- **Michelin's `questionId` is a UUID v5 of `ask:<stepIndex>` in the
  Round's id.** It is runner-generated, as the Decision says, and
  deterministic, so a restarted engine raises the same question under
  the same id.
- **One unanswered question per Round** (a partial unique index).
  `question_raised` is accepted only on `running`, so a second question
  while waiting is `event_out_of_order`. The index is the database
  backstop.
- **A duplicate answer is `400 question_already_answered`**, a
  transition rejection like the other Owner commands, with no effect.
  It is checked first, so an answered question reports that even after
  the Round ends.
- **An answer is refused while Stop is requested**
  (`stop_already_requested`). A Stop is delivered before an answer and
  ends the Round, so an answer then could never resume it.
  `allowedActions.answer` says so on the receipt.
- **A Stop is listed before an earlier answer** in the runner's command
  list. This meets "a queued Stop is delivered before an answer" even
  when the answer was queued first.
- **A new waiting reason, `resuming`,** for "answered, not yet
  resumed". Without it the slip would keep saying Waiting for your
  answer after the Owner answered. It ranks below `stopping` and
  `runner_disconnected`.
- **The answer command carries `{questionId, text}`** as an optional
  `RunnerCommand.answer`. Michelin then needs no second read to act on
  it.
- **Galley's clock times the question and the answer.** `answeredAt` is
  `GREATEST(now, askedAt)`, so the constraint
  `answered_after_asked` holds even under a skewed clock.
- **The Ticket's prior Status comes from the Round's state**
  (`ticketStatusHeldBy`), not from `started_at`. A waiting Round is
  started but holds Blocked, not In Progress.
- **`failed` and `interrupted` stay `running`-only.** A waiting engine
  is idle, so neither can happen while it waits; Stop is the way out.
- **Lock order for the answer: Ticket row, then question row.** Every
  runner event takes the Ticket row first, so the Round cannot end or
  resume while the answer is decided. A test pins the order, and a race
  test runs answers against Stop.
- **Answer limit 2000 characters**, the progress note's text rules.
  Galley stores the answer as typed. Swiftlet sends it untrimmed.
- **Michelin acks the answer only after `resumed` is recorded.** Until
  then the command stays listed. The command loop handles each command
  id once, so a re-listed answer is not delivered twice, and the ack is
  retried like a Stop's.
- **Stop wins over an answer delivered at the same time,** and that
  answer is never acknowledged. The Round has ended, so Galley no
  longer lists its commands.
- **A malformed `answer` listing fails the poll** (`invalid_body`),
  logged like any other bad body. It is not acked, so a fixed Galley
  would deliver it again.
- **With no answer channel, the engine waits until stopped.** This only
  matters to tests and embedders. `claimLoop` always wires the inbox.
- **The answer note is truncated to 2000 code points.** Galley's
  progress limit is on the whole note, and the prefix counts.
- **Swiftlet places the pending question at the top of the Rounds
  section,** above the Round entries, and the history inside each
  Round. An unanswered question reads **Awaiting your answer** while the
  Round waits and **Not answered** once it ended without one.
- **On `question_already_answered`, Swiftlet refreshes the receipt** and
  says the receipt shows the answer Galley recorded. The draft is kept.
- **The answer's `404` shows Galley's message.** It names the Ticket,
  Round and question together, as the Agent assignment `404` does.
- **Uppercase path UUIDs are accepted** on the answer path, as on every
  Owner path (`canonicalPublicID` normalises them). Runner-supplied
  `questionId`s must be lowercase canonical, as `observationId`s are.
- **The e2e spec runs before `active-order-slip.spec.ts`,** because it
  needs the slot and that spec leaves a Round open. Both of its tests
  end every Round they open.

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
GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test_m55?sslmode=disable' go test ./... -count=1
GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test_m55?sslmode=disable' go test -race ./... -count=1
bash scripts/check-contract-drift.sh

cd ../michelin && npm run typecheck && npx vitest run
cd ../swiftlet && npx tsc -p tsconfig.json --noEmit && npx vitest run && npm run build
cd ../../contracts && npm run check:swiftlet-drift && npm run check:michelin-drift

cd ../e2e && E2E_DATABASE_URL='postgres://localhost:5432/ticketit_e2e_m55?sslmode=disable' ./run.sh
```

The drift checks compare against staged files, so stage the generated
files first.

## Observed results

Run on the final tree, 2026-10-03, with everything staged.

- Galley: `gofmt -l .` printed nothing; `go vet ./...` and
  `go build ./...` clean. `go test ./... -count=1` exited 0. By
  `go test -json`, there were 409 top-level tests (baseline 388) and
  1465 with subtests (baseline 1366), 0 failed.
  `go test -race -count=1 ./...`:

  ```text
  ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/galley	4.438s
  ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/githubfake	3.134s
  ok  	github.com/cristoforows/ticketIt/apps/galley/internal/auth	2.694s
  ok  	github.com/cristoforows/ticketIt/apps/galley/internal/config	2.706s
  ok  	github.com/cristoforows/ticketIt/apps/galley/internal/githubfake	2.367s
  ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	98.935s
  ok  	github.com/cristoforows/ticketIt/apps/galley/internal/postgres	3.055s
  ```

  In an earlier targeted `-v` run, `TestAnswer_RacingStop…` logged
  `map[answered first:6 stopped first:2]`, so both orders were
  exercised and checked.

- Drift:

  ```text
  OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).
  OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
  OK: ../apps/michelin/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
  ```

- Michelin: typecheck clean. `Test Files 11 passed (11)`,
  `Tests 344 passed (344)` (baseline 316 in 10 files).
- Swiftlet: `tsc --noEmit` clean. `Test Files 27 passed (27)`,
  `Tests 555 passed (555)` (baseline 522). `npm run build`:
  `✓ built in 121ms`.
- Browser suite: `SUITE PASSED`, exit 0, twice in a row on the final
  code. The second run followed only a Michelin test addition and docs.
  All 42 specs exited 0, and 94 tests passed (baseline 41 specs and 92
  tests; the new spec adds two). The new spec:

  ```text
  Running 2 tests using 1 worker
  ✓  1 [chromium] › tests/runner-ask.spec.ts:52:1 › a real Michelin's questions block the Ticket, show on the slip and receipt, and the Owner's answers resume the same Round to delivery (7.3s)
  ✓  2 [chromium] › tests/runner-ask.spec.ts:147:1 › the Owner's Stop ends a Round waiting for an answer as Stopped, its question kept unanswered (4.4s)
  [run.sh] runner-ask.spec.ts exit code: 0
  [run.sh] SUITE PASSED
  ```

  An earlier run was stopped by hand after two failures.
  `runner-claims.spec.ts` and `runner-engine.spec.ts` asserted exact
  `allowedActions` and Round-list equality, which the new required
  fields (`answer`, `questions`) broke. Both were updated, and no
  flakiness was seen in the two full runs that followed.

## Falsification

Each row breaks the implementation in one place
(an uncommitted script making one exact-text replacement), runs the
named suite, then restores the file. `git diff --stat` was identical
before and after the pass (`55 files changed, 1846 insertions(+), 230
deletions(-)`, all staged).

| # | Break | Result | Failing test(s) |
| --- | --- | --- | --- |
| G1 | the `answered` check removed from `decideAnswer` | killed | `TestAnswer_TheFirstAnswerWins`, `TestAnswer_ConcurrentAnswersRecordExactlyOne`, `TestAnswer_RecordsTheAnswer…`, contract test |
| G2 | answer accepted while Stop is requested | killed | `TestAnswer_IsRefusedOnceStopIsRequestedAndAfterTheRoundEnds`, `TestQuestionRaised_IsAcceptedOnlyFromARunningRound`, contract test |
| G3 | answer accepted after the Round ended | killed | `TestAnswer_IsRefusedOnceStopIsRequested…`, contract test |
| G4 | `resumed` accepted without an answer | killed | `TestResumed_NeedsTheAnswerToTheQuestionTheRoundWaitsOn`, contract test |
| G5 | `question_raised` key need not equal `questionId` | killed | `TestQuestionRaised_KeyIsTheQuestionIdAndAReplayRaisesNoSecondQuestion` |
| G6 | a waiting Round holds In Progress, not Blocked | killed | `TestQuestionRaised_MovesTheRunningRoundToWaiting…KeepsTheSlot`, `TestAnswer_RecordsTheAnswer…` |
| G7 | `resuming` never reported | killed | `TestDecideWaitingReason`, `TestWaitingReason_FollowsTheQuestionStopAndRunnerContact`, `TestAnswer_RecordsTheAnswer…` |
| G8 | Stop not listed before an earlier answer | killed | `TestRoundCommands_AStopIsListedBeforeAnEarlierAnswer`, `TestAnswer_RacingStop…`, `TestStopConfirmed_FromWaitingForInput…` |
| G9 | a waiting Round accepts `progress` and the other running events | killed | `TestWaitingForInput_OnlyResumedAndStopConfirmedAreAccepted`, `TestQuestionRaised_KeyIsTheQuestionId…` |
| G10 | the answer skips the Ticket row lock | killed | `TestAnswer_TakesTheTicketRowThenTheQuestionRow`, `TestAnswer_IsRefusedOnceStopIsRequested…`, contract test |
| M1 | answer acked before `resumed` is sent | killed | 4 tests in `engine.test.ts` ("the ask step") and `commandLoop.test.ts` ("answers") |
| M2 | the inbox keeps the latest answer, not the first | killed | `answerInbox.test.ts` "hands an answer that arrived first to the later wait, once" |
| M3 | an answer for another claim epoch is applied | killed | `commandLoop.test.ts` "acknowledges an answer for another claim epoch as ignored…" |
| M4 | `questionId` not deterministic | killed | 12 tests, including "derives a stable version 5 questionId…" |
| M5 | an answer wins over a Stop that lands with it | **survived, then killed** | survived the first pass (343 passed). Added `engine.test.ts` "prefers a Stop that lands in the same tick as an answer already handed over", which kills it |
| S1 | the parser accepts a question on a running Round | killed | `tickets.test.ts` "rejects a Ticket with a running Round with a question", "…with no question field" |
| S2 | answer form shown whatever `allowedActions.answer` says | killed | `TicketDetail.test.tsx` "names why an answer cannot be sent…" |
| S3 | Send answer enabled while blank | killed | `TicketDetail.test.tsx` "shows the question with an answer form, sending nothing while the answer is blank" |
| S4 | no refresh on `question_already_answered` | killed | `TicketDetailPage.test.tsx` "refreshes the receipt when Galley already recorded another answer" |
| S5 | wrong slip label | killed | `ActiveOrder.test.tsx` "labels a Blocked Ticket whose Round waits for input…" (list and board) |
| S6 | Round history drops the answer | killed | `TicketDetail.test.tsx` "…lists each question with its answer under its Round", `TicketDetailPage.test.tsx` "posts the answer…" |

After the added test, no survivors remain. The e2e assertions themselves
were not falsified separately: each behaviour has a unit- or Go-level
kill above, and a full browser suite takes about ten minutes per run.

## Implementation limitations and follow-ups

- **A Michelin restarted while a Round waits does not pick it up.**
  Galley holds the slot, so the claim answers `204`, and the new
  Michelin has no Round to attach the answer to. The Round stays
  waiting until the Owner Stops it, and then no runner confirms the
  Stop. Recovery is reconciliation, M5.12/M5.13 (#6).
- **Waiting time is not yet reported apart from active work time.**
  `askedAt` and `answeredAt` are recorded, so it can be derived, but no
  usage figure or receipt line shows it. Owner: the M5 gate or a usage
  slice.
- **One question at a time.** A Round can ask several in turn, but
  never two at once. The contract carries one `openRound.question`.
- **Only the controlled engine asks.** It treats any non-blank answer as
  enough, per the Decision. Real engines are later milestones.
- **No notification.** The Owner sees the question on the slip and the
  receipt only. Messaging is outside this slice.

## Outstanding checks and owning milestone

- Visual review of the question panel and the two new slip labels by
  the Owner (M5 gate).
- A screen-reader pass on the question panel beyond the role, name and
  label assertions here (M5 gate).

## Decision impacts (open-decision IDs)

None resolved. The slice implements #163's settled Decisions and
touches none of D1, D2, D4, D6, D7 or D9.
