# Active order slip: greyed card, delivery animation and waiting reasons

## Purpose

M5.4, [#162](https://github.com/cristoforows/ticketIt/issues/162).

While a Ticket has an open Round, its Board slip and its Backlog row
become the **active order slip**. It is greyed and locked, shows a
decorative delivery animation, and labels the Round's **Waiting
Reason**. It offers View and, when Galley advertises it, Stop. Galley
publishes the reason as one enum on `openRound`; Swiftlet never derives
it.

The slice also lands three receipt follow-ups from the M4 gate:

- every timestamp in local time, through one formatter;
- **Load earlier** paging past the latest 50 activity notes;
- the header pill and the receipt's Runner disconnected notice reading
  one health value.

Touches `contracts/`, `apps/galley`, `apps/swiftlet`, `e2e/`, the
regenerated `apps/michelin` schema, and `CONTEXT.md` (new term
**Waiting Reason**).

## What already existed

- **M5.3 (#161, PR #176, branch `m5/161-failed-interrupted`)**, which
  this branch is based on (itself on M5.2 #160 and M5.1 #159). None is
  merged.
- `openRound` had `state`, `startedAt` and `stopRequestedAt`. The slip
  showed `ClaimedTag` / `StoppingTag`, and the phone slip kept its status
  toggle, which covered the slip.
- `GET /api/tickets/{id}/rounds` embedded each Round's latest 50 notes
  (`activityWindow`), with no way to read earlier ones.
- Timestamps rendered as raw ISO UTC strings. The slip's `shortDate`
  used UTC.
- `useRunnerHealth` started one poll per caller, so the header and the
  receipt each fetched on their own 10 s cadence and could disagree
  (M4 gate finding).
- **Baseline** (per the M5.3 record):
  - Galley: 375 top-level tests (1342 with subtests).
  - Michelin: 316. Swiftlet: 467 (25 files).
  - Browser suite: 40 specs, 90 tests.

## What this slice added

**Contract** (`contracts/openapi.yaml`; `api.gen.go` and both
`schema.d.ts` regenerated):

- `RoundWaitingReason` enum `starting | working | stopping |
  runner_disconnected`. `TicketOpenRound.waitingReason` is required.
- `TicketRound.earlierActivityCursor` (`EarlierActivityCursor`, an
  opaque string or null).
- `GET /api/tickets/{id}/rounds/{roundId}/activity?before=`
  (`listRoundActivity`) returns `RoundActivityPage`
  `{activity, earlierActivityCursor}`. A malformed cursor is
  `400 invalid_cursor`.

**Galley**

- `round_waiting.go`: `decideWaitingReason(state, stopRequested,
  runnerConnected)`, the one function. Precedence: `runner_disconnected`
  > `stopping` > `starting` > `working`.
- `ticket.go`: the Ticket read selects the Owner's runner `last_seen_at`
  and passes it through the existing `runnerConnected(now, lastSeenAt)`
  (the same 30 s window and clock as `GET /api/runner-health`). No
  runner row means disconnected. The clock reaches every Ticket read as
  a `now` parameter. The reason is computed on read and never stored.
- `round_activity.go`:
  - `latestActivity` reads 51 rows per Round, and `activityPage` cuts
    them to 50 plus the cursor;
  - `parseActivityCursor` accepts only a canonical decimal ≥ 1;
  - `ListRoundActivity` / `activityBefore` look up the Round by Owner,
    Ticket and Round id (else the shared Round 404), then read
    `seq < before ORDER BY seq DESC LIMIT 51`.
- `ticket_rounds.go` sets `earlierActivityCursor`. `handler.go` adds the
  405 registration for the new path.
- Tests:
  - `round_waiting_test.go`: the decision table, the lifecycle, the 30 s
    boundary, revoke and re-pair, no paired runner, Owner scoping, and
    no stored writes;
  - `round_activity_paging_test.go`: 0/1/50/51/100/101 notes, appends
    while paging (concurrent goroutine), malformed cursors, and every
    404 case including a foreign Owner;
  - `contract_test.go`:
    `TestWaitingReasonAndActivityPaging_ResponsesMatchContractAndMethod405`.

**Swiftlet**

- `api/tickets.ts`: `parseOpenRound` requires a known `waitingReason`.
  `api/rounds.ts`: `parseRound` requires `earlierActivityCursor`, and
  `fetchRoundActivity(ticketId, roundId, before)`.
- `components/ActiveOrder.tsx`:
  - `waitingReasonLabels`;
  - `DeliveryIndicator` (`aria-hidden`);
  - `ActiveOrder` with the reason label, View (a `TicketModalLink`
    named "View <title>") and Stop (named "Stop <title>", only while
    `allowedActions.stop.available`).
- `TicketSlip.tsx`, `TicketList.tsx`, `TicketBoard.tsx`,
  `ui/SlipCard.tsx`: the `active` cva variant (`bg-rule`), ink text, no
  drag, no phone toggle, and `replaceTicket` for Stop's response.
- `styles.css`: per-reason keyframes. A `prefers-reduced-motion` rule
  sets `animation: none`, which leaves each reason's static position.
- `components/ui/time.tsx`: `localTimestamp` / `LocalTime`, and
  `shortDate` moved here and made local. Used by the receipt, the
  Ticket times, the Runner page, the health pill title and the status
  page. The unit suite runs with `TZ=Asia/Kolkata` (`vite.config.ts`).
- `RoundsSection.tsx`: `useRoundActivity` and **Load earlier**.
- `RunnerHealthPill.tsx`: one module-level health store read through
  `useSyncExternalStore`.

**e2e**

- `tests/active-order-slip.spec.ts` (two tests), registered in `run.sh`
  after `runner-interrupted.spec.ts` with an exit check.
- `support/tickets.ts` carries the new fields and
  `listRoundActivity`.
- Existing specs updated for the new fields and local time:
  - exact `openRound` equality after a runner loss now expects
    `runner_disconnected` (runner-claims, runner-engine);
  - the Round list equality includes `earlierActivityCursor: null`;
  - raw-ISO text assertions now check the `<time datetime>` (status,
    ticket-detail, runner-engine, runner-failed, runner-interrupted);
  - the slip's Claimed and Stopping tags became the waiting-reason label
    (runner-claims, runner-engine, runner-stop).

**Docs:** the Galley, Swiftlet and e2e READMEs; `CONTEXT.md` adds
**Waiting Reason** (grep found no existing entry).

### Engineering choices beyond the Decisions

- **No runner row is `runner_disconnected`.** `GET /api/runner-health`
  already reports not-paired as not connected. The receipt notice shows
  for anything but Connected, so the slip agrees with it.
- **Lost contact outranks Stopping.** Galley cannot see a Stop confirmed
  while out of contact, and the Owner needs to know why it is not
  ending. Pinned by `TestDecideWaitingReason`.
- **The cursor is the decimal `seq` of the page's oldest note**, opaque
  in the contract. `seq` is gap-free and notes are never removed, so a
  `seq <` page is stable under appends. A non-canonical form (`02`,
  `+2`, ` 2`) is refused, so one page has one cursor. A cursor past the
  newest note returns the latest page; `1` returns an empty last page.
- **The Round lookup comes before the activity read.** An empty page
  then never hides an unknown, foreign or mismatched Round: those get
  the shared Round 404.
- **The default activity page equals the Round list's embedded window**
  (asserted in the boundary test), so the receipt never needs a second
  first-page fetch.
- **Swiftlet keeps shown notes across refreshes.** It merges by `seq`.
  When a refresh's latest window has moved past the newest shown note,
  Swiftlet back-fills the gap through that window's cursor, so the
  receipt never shows a hole.
- **One module-level health store**, not a React context. The header,
  the receipt and the Runner page are separate trees, and a store needs
  no provider. The first subscriber starts the poll and the last one
  stops it. A receipt opened between polls shows the header's value at
  once (the test fails against the old per-caller poll).
- **The unit suite runs in `Asia/Kolkata`.** A half-hour offset east of
  UTC makes both a UTC rendering and a dropped-minutes offset fail.
  `time.test.ts` also sets other zones explicitly (`Pacific/Chatham`,
  and zones west of UTC). The e2e browser context sets `timezoneId`
  `Asia/Kolkata` for the receipt-time assertions.
- **Existing e2e specs check `<time datetime>`, not the rendered text.**
  The host zone varies, and the rendered format is pinned by the unit
  suite and by `active-order-slip.spec.ts` under a fixed zone.
- **Muted becomes ink on greyed surfaces.** Muted on rule is 3.47:1,
  below AA; ink on rule is 10.18:1. The reason uses the existing #114
  tokens only (no new palette or font). `tokens.test.ts` pins ink on
  rule ≥ 4.5, the indicator ≥ 3:1 (WCAG 1.4.11), and muted on rule
  < 4.5, which keeps the rule from silently loosening.
- **View is always offered; Stop only when advertised.** Reading the
  receipt needs no `allowedActions` entry. Stop follows
  `allowedActions.stop`.
- **An unknown `waitingReason` is rejected by the parser,** like an
  unknown Round state, so Swiftlet never renders a reason Galley did not
  name. Later slices add values in the contract and the parser together.
- **`ClaimedTag` / `StoppingTag` left the slip** (the reason label
  replaces them) and stay on the receipt.
- **The phone status toggle is hidden on an active slip.** It covered
  View and Stop, and a locked Ticket has no status change to offer.
- **The new spec runs last among the runner specs.** Its second test
  leaves a claimed Round open with Stop requested. No later spec needs
  the Owner's slot, so no reset is added.
- **Starting and Stopping use a direct runner claim, Working a real
  Michelin.** Michelin starts a Round within milliseconds and confirms a
  Stop within one poll, so neither state would hold still.

## Exact versions and toolchain

- Go 1.27.1 (darwin/arm64), `go.mod` `go 1.27.1`; oapi-codegen via the
  `tool` directive in `go.mod`.
- PostgreSQL 17.11 (Homebrew), local.
- Node v26.9.0, npm 11.19.1.
- Swiftlet: React 19.3.0, Vite 8.3.0, Vitest 5.0.1, TypeScript 7.0.2,
  Tailwind CSS 4.3.3, class-variance-authority 0.7.1, tailwind-merge
  3.7.0.
- Contracts: openapi-typescript 7.13.0.
- e2e: @playwright/test 1.63.0 (chromium).

## Reproducible commands

```sh
cd apps/galley
gofmt -l . ; go vet ./... ; go build ./...
GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test_m54?sslmode=disable' go test ./... -count=1
GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test_m54?sslmode=disable' go test -race ./... -count=1
bash scripts/check-contract-drift.sh

cd ../michelin && npm run typecheck && npx vitest run
cd ../swiftlet && npx tsc -p tsconfig.json --noEmit && npx vitest run && npm run build
cd ../../contracts && npm run check:swiftlet-drift && npm run check:michelin-drift

cd ../e2e && E2E_DATABASE_URL='postgres://localhost:5432/ticketit_e2e_m54?sslmode=disable' ./run.sh
```

The drift checks compare against staged files, so stage the generated
files first.

## Observed results

Run on the final tree, 2026-10-03.

- Galley: `gofmt -l .` printed nothing; `go vet ./...` and
  `go build ./...` clean. `go test ./... -count=1` exit 0. By
  `go test -json`, 388 top-level tests (baseline 375) and 1366 with
  subtests (baseline 1342), 0 failed. `go test -race ./... -count=1`
  exit 0:

  ```text
  ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/galley	5.383s
  ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/githubfake	1.884s
  ok  	github.com/cristoforows/ticketIt/apps/galley/internal/auth	3.502s
  ok  	github.com/cristoforows/ticketIt/apps/galley/internal/config	2.266s
  ok  	github.com/cristoforows/ticketIt/apps/galley/internal/githubfake	1.480s
  ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	98.364s
  ok  	github.com/cristoforows/ticketIt/apps/galley/internal/postgres	3.617s
  ```

- Drift:

  ```text
  OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).
  OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
  OK: ../apps/michelin/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
  ```

- Michelin: typecheck clean. `Test Files 10 passed (10)`,
  `Tests 316 passed (316)` (unchanged; only its generated schema
  changed).
- Swiftlet: `tsc --noEmit` clean. `Test Files 27 passed (27)`,
  `Tests 522 passed (522)` (baseline 467 in 25 files). `npm run build`:
  `✓ built in 118ms`.
- Browser suite: `SUITE PASSED`, `exit 0`. All 41 specs exited 0, and
  92 tests passed (baseline 40 specs and 90 tests; the new spec adds
  two). The new spec:

  ```text
  ✓  1 [chromium] › tests/active-order-slip.spec.ts:54:1 › a real Michelin's Working Round shows the active slip on list and board, keeps its meaning under reduced motion, pages past 50 notes in local time, and stops from the slip (4.7s)
  ✓  2 [chromium] › tests/active-order-slip.spec.ts:148:1 › a directly claimed Round shows Starting, Runner disconnected on the slip and the receipt with the header, and Stopping once stopped from the slip, on desktop and phone (11.1s)
  2 passed (16.1s)
  [run.sh] active-order-slip.spec.ts exit code: 0
  [run.sh] SUITE PASSED
  ```

  Two earlier runs failed, and both failures were fixed before this
  one:
  - Run 1: existing specs asserted raw ISO text and exact `openRound` /
    Round equality, which the new fields and local time broke. The new
    spec read the header through `getByRole("banner")`, which Radix
    hides while the dialog is open.
  - Run 2: only `status.spec.ts` failed, because the status page
    rendered a bare string with no `<time datetime>`. It now uses
    `LocalTime`.

## Falsification

Each row breaks the implementation in one place, runs the named tests,
then restores the file with `git checkout`. After the pass, `git diff`
against the staged tree was empty.

| # | Break | Result | Failing test(s) |
| --- | --- | --- | --- |
| F1 | `stopping` checked before lost contact | killed | `TestDecideWaitingReason`, `TestWaitingReason_RunnerDisconnectedFollowsRunnerHealthExactly` |
| F2 | lost contact never reported | killed | `TestDecideWaitingReason` and three `TestWaitingReason_*` (health window, claimed Round losing its runner, no paired runner) |
| F3 | cursor accepts non-canonical decimals | killed | `TestRoundActivity_AMalformedCursorIsInvalidCursor` |
| F4 | cursor accepts `0` | killed | `TestRoundActivity_AMalformedCursorIsInvalidCursor` |
| F5 | window `>=` instead of `>` | killed | `TestRoundActivity_PagesAtTheWindowBoundaries/50_notes`, `/100_notes` |
| F6 | page reads `seq <=` cursor | killed | `TestRoundActivity_PagesAtTheWindowBoundaries/51_notes`, `/100_notes`, `/101_notes` |
| F7 | Round lookup not Owner-scoped | killed | `TestRoundActivity_UnknownMismatchedAndForeignRoundsAreTheSameNotFound` |
| F8 | Round lookup ignores the Ticket id | killed | same |
| F9 | Stop shown regardless of `allowedActions` | killed | `ActiveOrder.test.tsx` "offers Stop only while…", "requests Stop…" (list and board) |
| F10 | Swiftlet derives the reason from state and `stopRequestedAt` | killed | `ActiveOrder.test.tsx` "labels the Galley reason…" (starting, stopping, runner_disconnected), `TicketBoard.test.tsx` |
| F11 | reason label in `text-muted` | killed | `ActiveOrder.test.tsx` "is greyed and locked… AA contrast" (list and board) |
| F12 | reduced-motion rule for the rider removed | killed | `slip.test.ts` "stops the rider under reduced motion" |
| F13 | active slip draggable | killed | `ActiveOrder.test.tsx` "offers View and Stop…", three `TicketBoard.test.tsx` lock tests |
| F14 | `localTimestamp` returns ISO UTC | killed | `TicketDetail.test.tsx` timestamps and Round times, and others |
| F15 | offset drops its minutes | killed | `time.test.ts` Asia/Kolkata and Pacific/Chatham |
| F16 | Load earlier replaces shown notes | killed | `TicketDetailPage.test.tsx` "pages back past the latest 50…", "keeps earlier notes when a refresh moves…" |
| F17 | no back-fill after the window moves | killed | `TicketDetailPage.test.tsx` "back-fills the notes a refresh skipped…" |
| F18 | parser accepts any `waitingReason` | killed | `tickets.test.ts` "rejects … without waitingReason", "rejects … unknown waitingReason" |
| F19 | `RunnerHealthPill.tsx` reverted to the per-caller poll | killed | `TicketDetailPage.test.tsx` "shows Runner disconnected on the same check as the header…" (1 failed, 87 passed) |
| F20 | `--color-rule` darkened to `#78716c` | killed | `tokens.test.ts` "ink on rule is at least 4.5:1" |

No unit-level survivors. Not falsified: the e2e assertions themselves
(reduced motion, local time in the browser, paging past 50). Each has a
unit-level kill above, but the e2e specs were not separately broken and
re-run, because a full suite takes about ten minutes.

## Implementation limitations and follow-ups

- **The slip and the header can briefly disagree.** The slip's reason
  comes from the 3 s Ticket refresh. The header pill comes from the
  10 s health poll. For up to one health poll the slip can say Runner
  disconnected while the pill still says Connected, or the reverse. The
  receipt notice and the header share one value, which is what the M4
  gate finding asked for. Making the pill read Galley's reason would
  couple two endpoints; it is not done here.
- **The receipt's notice uses runner health, not `waitingReason`.** Both
  come from Galley's `runnerConnected`, but through different reads.
- No M5.5 / M5.6 / M5.7 reasons or behaviour; the enum is ready to grow.

## Outstanding checks and owning milestone

- Visual review of the animation and greyed slip by the Owner (M5 gate).
- Screen-reader pass on the active slip beyond the role and name
  assertions here (M5 gate).

## Decision impacts (open-decision IDs)

None resolved. The waiting reason is computed from existing Galley
state, so no open decision is affected.
