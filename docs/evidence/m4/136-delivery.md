# Delivery to In Review, with a retained result

## Purpose

M4.10, [#136](https://github.com/cristoforows/ticketIt/issues/136): a
running Round now ends. Michelin's controlled engine sends a `delivered`
event with a Markdown body, a change summary and a Success Criteria
assessment. In one transaction, Galley:

1. stores the result as the Round's deliverable, in PostgreSQL;
2. closes the Round with the explicit outcome `delivered`;
3. moves the Ticket from In Progress to In Review.

Closing the Round also frees the sequential slot and lifts the open-Round
lock. Delivery is not acceptance:

- A Basic Ticket (`humanAcceptance`) waits for the Owner's Accept.
- A Coding Ticket (`reviewedPrMerge`) cannot be accepted, as before.
- Michelin claims the next eligible Ticket in priority order.

Swiftlet's receipt renders the result and shows "Delivered by" the Agent,
on the slip and on the receipt.

Touches `contracts/`, `apps/galley`, `apps/michelin`, `apps/swiftlet` and
`e2e/`.

## What already existed

- **M4.8** ([#134](https://github.com/cristoforows/ticketIt/issues/134))
  and **M4.9** ([#135](https://github.com/cristoforows/ticketIt/issues/135)):
  - `POST /api/runner/rounds/{roundId}/events`, with
    `execution_started`, `progress` and `usage_observed`;
  - the decision ladder, idempotency by `(round_id, idempotency_key)` and
    the payload hash, and epoch fencing;
  - `GET /api/tickets/{id}/rounds`, with activity and usage.
- **Rounds never ended.**
  - `RoundState` on the wire was `[claimed, running]`, so an ended Round
    was outside the schema.
  - Galley tests closed Rounds with SQL (`deliverRoundDirect`).
  - The browser suite reset the database between Round-holding specs.
- **Michelin's script** had `start`, `progress`, `usage`, `wait` and
  `hold`. `deliver` was rejected as "M4.10 (#136) adds it", and the
  default script ended in `hold`.
- **Accept already existed:** `decideAccept` and the Accept command
  (`humanAcceptance` → Done; `reviewedPrMerge` refused with
  `reviewed_pr_merge_not_implemented`). This slice leaves both unchanged,
  as the Decisions require.
- **The open-Round lock (M4.7):** "accepted once closed" was proven only
  with SQL-closed Rounds, and the browser could not yet show a Ticket
  unlocking.
- **Swiftlet** showed only the open Round, refreshed every 3 s.
- Migrations up to `000015`. Baseline on `main` at `51124d6`:
  - Galley: 286 top-level tests, 976 with subtests.
  - Michelin: 194 tests.
  - Swiftlet: 373 tests.
  - Browser suite: 35 specs, 83 tests.

## What this slice added

**Contract** (`contracts/openapi.yaml`, regenerated into `api.gen.go`
and both `schema.d.ts`):

- **`RoundEventType`** gains `delivered`.
  - Its `data` is `DeliveredData {bodyMarkdown, summary,
    criteriaAssessment}`, all three required.
  - `RoundEventResult` gains `endedAt`, set on the delivered result.
- **The enums split.**
  - `RoundState` is `[claimed, running, delivered]`.
  - A new `OpenRoundState`, `[claimed, running]`, types
    `Ticket.openRound.state`.
  - An open Round can never be `delivered`, and the list of Rounds can
    show an ended one.
- **`Ticket.delivery`** is `{roundId, sequence, agent, deliveredAt}` or
  `null`. It is set when the Ticket's latest Round is delivered, and
  goes back to `null` once a later Round is claimed.
- **`TicketRound.deliverable`** is `RoundDeliverable` or `null`. It is
  set exactly when `state` is `delivered`.

**Galley** (`internal/httpapi`)

- **Migration `000016_create_round_deliverables.up.sql`:**
  - `round_events_type_m4` gains `delivered`.
  - New table `round_deliverables (id, owner_id, round_id,
    body_markdown, summary, criteria_assessment)`, with:
    - `UNIQUE (round_id)`;
    - a composite foreign key to `rounds (owner_id, id)`;
    - `octet_length(body_markdown) BETWEEN 1 AND 1048576`;
    - `char_length` bounds of 2000 on `summary` and 10000 on
      `criteria_assessment`;
    - an ASCII-whitespace not-blank CHECK on each column.
- **`round_deliverables.go`:** `validateDeliveredData`, the limits,
  `deliverRound` and the body cap's constants.
- **`round_events.go`:** the body cap, the `delivered` validation and
  state rule, and the apply step.
- **`round_activity.go`:** the shared `validMultilineText`.
- **`ticket.go`:** the `delivery` subquery.
- **`ticket_rounds.go`:** the deliverable `LEFT JOIN`, in the list's
  existing snapshot transaction.
- **Guardrails:**
  - `round_deliverables` joins `knownPublicTables` in
    `no_execution_side_effects_test.go`, which asserts that no Owner
    action creates a row in it.
  - `TestNoTemplateToCapabilityMapping` is untouched and passes.

**Michelin**

- **`engineScript.ts`:**
  - A `deliver {bodyMarkdown, summary, criteriaAssessment}` step, parsed
    against Galley's limits.
  - `deliver` and `hold` may only be the last step, and are mutually
    exclusive.
  - The default script now ends in `deliver`, with a "# Result" body.
- **`engine.ts`:** reports the delivery, logs `delivery reported` (with
  `endedAt`) and `engine delivered`, and returns the outcome
  `"delivered"`. The claim loop then claims again.
- **`galley/runner.ts`:**
  - A delivered result must carry `state: delivered` and `endedAt`.
  - Every other result must be `claimed` or `running`.

**Swiftlet**

- **`react-markdown` 10.1.0**, pinned exactly.
- **`components/ui/Markdown.tsx`** is the container: order-rail
  typography through `cn()`, plus a `Suspense` fallback ("Loading…")
  around a `React.lazy` import of the renderer.
- **`components/ui/MarkdownRenderer.tsx`** is the renderer:
  - `skipHtml`, no plugins, and react-markdown's default URL filter;
  - every link has `target="_blank"` and `rel="noopener noreferrer
    nofollow"`, and a link whose URL the filter blanked renders as its
    text;
  - an image is never rendered as `<img>`: it shows its alt text (or
    "Image"), plus its source as a link when the filter passes it.
- **`DeliveredTag`:** a `delivered` variant of the shared tag, in the
  In Review deep colour. It reads "Delivered by <Agent>" on the slip
  (`board-delivered`) and the receipt (`ticket-detail-delivered`).
- **`RoundsSection`** shows each delivered Round. It renders:
  - the summary, the assessment and the Report;
  - the Agent and the delivery time;
  - activity and usage.
- **`TicketDetailPage`** loads Rounds when the Ticket has an open Round
  or a delivery. It reuses the existing refresh tick, so the tick that
  sees In Review also fetches the deliverable, and refreshing then
  stops.
- **Parsers** (`api/tickets.ts`, `api/rounds.ts`) refuse:
  - a delivered Round without a complete deliverable;
  - an open Round with one;
  - an unknown state.

**e2e**

- **New `tests/runner-delivery.spec.ts`**, three tests against a real
  Michelin process:
  - **Basic:** Ready → claimed → running → In Review on the open receipt
    without a reload → Accept → Done.
  - **Coding:** stops at In Review. Accept is refused by both the
    command and the receipt.
  - **Sequencing:** a second queued Ticket is claimed only after the
    first delivers.
- **`support/`** gains the `deliverable`, `delivery` and `deliver` step
  types.
- **`run.sh`** registers the spec and its exit-code check.

### The decision ladder

M4.8's ladder, with one new rung (3) and the `delivered` cases:

| # | Check | Outcome |
| --- | --- | --- |
| 1 | Runner credential | `401` |
| 2 | Canonical Round id | shared `404` |
| 3 | **Body at most 8 MiB** (`io.LimitReader(r.Body, 8 MiB + 1)`) | **`413 request_too_large`** |
| 4 | Strict decode. `delivered` needs `data` to be exactly `{bodyMarkdown, summary, criteriaAssessment}` within the limits below | `400 invalid_request` |
| 5 | Lock the Owner's priority advisory lock, the Ticket row, then the Round row `FOR UPDATE`. An unknown or foreign Round is the shared `404` | `404` |
| 6 | Idempotency: same key and same hash → the stored result; same key, different hash | `200` / `409 idempotency_key_conflict` |
| 7 | Claim epoch | `409 stale_claim_epoch` |
| 8 | Round open | `409 round_not_open` |
| 9 | `delivered` needs a `running` Round. A `claimed` Round gives "delivered cannot be reported while the Round is claimed" | `409 event_out_of_order` |
| 10 | Apply | `201` |

The cap sits after the credential and Round-id checks, so an
unauthenticated or malformed request is refused before Galley reads up
to 8 MiB.

### Limits

| Field | Limit | Measured as | Galley | Database |
| --- | --- | --- | --- | --- |
| request body | ≤ 8 MiB (8388608 bytes) | raw bytes read | `413` | — |
| `bodyMarkdown` | 1–1048576 | UTF-8 bytes after JSON decoding | `400` | `octet_length` CHECK |
| `summary` | 1–2000 | code points | `400` | `char_length` CHECK |
| `criteriaAssessment` | 1–10000 | code points | `400` | `char_length` CHECK |

All three fields have two more rules:

- They may not be blank, meaning every character is `unicode.IsSpace`.
  The DB CHECK trims ASCII whitespace only, as a backstop.
- They may not contain a control character other than tab and line
  feed.

Why the cap is 8 MiB: `\u`-escaping every byte of a maximal 1 MiB body
gives 6 MiB of JSON, and the envelope and the other two fields fit in
the rest. So any valid delivery fits under the cap, however it is
spelled. `TestRoundEvent_RequestBodyIsCappedAt8MiB` checks three
bodies:

- a fully `\u`-escaped maximal deliverable → `201`;
- a body of exactly 8 MiB → reaches validation;
- 8 MiB + 1 byte → `413` with nothing stored.

`RoundDeliverable.bodyMarkdown` in the contract has only `minLength: 1`.
JSON Schema's `maxLength` counts characters, not bytes, so it cannot
state the byte limit.

### The transaction

`deliverRound` runs inside the event's transaction, after rungs 5–9. It
is one transaction with the event's record:

1. `INSERT INTO round_deliverables …`.
2. `UPDATE rounds SET state = 'delivered', ended_at =
   GREATEST(now, started_at)`. `ended_at` comes from Galley's clock and
   is never before `started_at`
   (`TestDelivered_EndedAtNeverPrecedesStartedAt`).
3. `UPDATE tickets SET status = 'InReview' … AND status = 'InProgress'`.
   - A running Round's Ticket is In Progress by invariant.
   - If no row matches, that is `errDeliveredTicketNotInProgress`.
     Galley logs it with the Round id, answers `500`, and records
     nothing.
4. `INSERT INTO round_events …`, storing the result `{roundId, type,
   state: delivered, startedAt, endedAt}`.

Nothing else is written. The slot frees and the open-Round lock lifts
because both are derived from the open states:

- `openRoundStatesSQL` drives claim eligibility and `lockMutableTicket`.
- `rounds_one_open_per_owner` is a partial unique index over
  `state IN ('claimed', 'running')`.

A failure at any write rolls everything back.
`TestDelivered_AFailureAtTheLastWriteRollsBackEveryChange` makes the
last write fail with a trigger. Galley answers `503`, and a full
snapshot of the tables is unchanged.

### Locks and deadlock

The lock order is M4.8's, for every event type:

1. the Owner's priority advisory lock;
2. the Ticket row (`FOR UPDATE`);
3. the Round row (`FOR UPDATE`).

Delivery takes no new kind of lock and none in a new order. Its writes
touch only rows the transaction already holds, or rows it creates:

- The deliverable insert's foreign key takes `FOR KEY SHARE` on the
  Round row, which is already held.
- The Round update hits the held Round row. Leaving the partial unique
  index waits on nothing.
- The Ticket update hits the held Ticket row.
- The `round_events` insert is new.

No cycle is possible:

- Claim and every priority-ordered Owner command take the priority lock
  before any Ticket row.
- Field edits, assignment, Badges and archive take only a Ticket row.
- Accept and status changes (`applyTicketTransition`) are among those
  priority-ordered commands. They then lock the Ticket row and read its
  open Round, so each one runs wholly before or after a delivery.

Tests:

- `TestDelivered_RacingAnOwnerCommandIsSerialisedEitherWay` queues a
  delivery and an Accept behind a held Ticket row lock, in both orders.
  - Accept first: refused, because the Round is open, and the Ticket
    ends In Review.
  - Delivery first: Accept completes the Ticket to Done.
- `TestDelivered_RacingTheOwnersCommandsNeitherDeadlocksNorLeavesInconsistentState`
  runs six trials. Each fires a delivery, an Accept, a rename, a second
  claim and a reorder at once. In every trial:
  - nothing hung past the 20 s deadlock bound;
  - the delivery got `201`;
  - the other answers and the final Ticket were consistent with one
    serial order.
- `TestRoundEvent_TakesTheOwnersPriorityLockThenTheTicketRowThenTheRoundRow`
  now includes a delivered case.
- These tests also pass under `-race`.

### After delivery

- **Status.** The Ticket is In Review with no open Round and
  `requestingAgentWork: false`. For an Agent-assigned Ticket, In Review
  offers no status change: In Progress is `agent_owned_transition`, and
  every other target is `invalid_transition`.
- **Accept.** `decideAccept` is unchanged.
  - `humanAcceptance` (Basic) → available, and Accept moves the Ticket
    to Done.
  - `reviewedPrMerge` (Coding) → `reviewed_pr_merge_not_implemented`.
  - `TestDelivered_AcceptFollowsTheRetainedCompletionCondition` checks
    that `allowedActions` matches the command's answer in both cases.
- **Next work.** The next claim follows priority order
  (`TestDelivered_FreesTheSlotAndTheNextClaimFollowsPriority`). A Done
  Ticket moved back to Ready is queued for a new Round with the next
  sequence (`TestDelivered_ADoneTicketMovedBackToReadyIsQueuedForANewRound`).
- **Rework.** Rework from In Review is M4.11
  ([#137](https://github.com/cristoforows/ticketIt/issues/137)).

### Engineering choices inside the Decisions

- **One body cap, on this endpoint only.** Before this slice, the events
  endpoint read its whole body, and a 1 MiB field makes that matter. The
  cap is per endpoint and sized from the largest valid request. Other
  endpoints are uncapped (see limitations).
- **The result never echoes the body.** The stored result is what a
  replay returns, and it carries the outcome and times only. The
  deliverable is read through `GET /api/tickets/{id}/rounds`. This keeps
  `round_events.result` small and stores the Report once.
- **`Ticket.delivery` exists for the slip.** The board's slip needs "Delivered
  by <Agent>" without fetching every Ticket's Rounds. The field comes
  from the latest Round, so it disappears when a later Round is claimed
  and reappears on its delivery.
- **Tests close Rounds through the API.** `deliverRoundDirect` (SQL) is
  replaced by `f.deliverThroughAPI`, which starts the Round if needed and
  delivers through the endpoint, so tests exercise the real transaction.
  `closeRoundDirect` remains only in `ticket_open_round_lock_test.go`.
  Those tests first move the Ticket out of In Progress by SQL, and real
  delivery rightly refuses that.
- **The browser suite keeps its resets.** `runner-activity.spec.ts`
  still holds its Round open on purpose, and `runner-claims.spec.ts`
  claims with no engine. Both leave an open Round, so the resets stay
  before the Round-holding specs, including the new one.
- **Michelin mirrors Go's whitespace.** "Blank" in Michelin uses a
  character class equal to Go's `unicode.IsSpace` (`NOT_GO_SPACE`).
  JavaScript's `\s` includes U+FEFF and Go's does not, so with `\s` a
  script that Galley would accept could be refused locally.
- **Michelin's deliver key** is `<roundId>:<step index>`, like `start`
  and `progress`. The body is serialised once, so every retry sends the
  same bytes under the same key, and a lost `201` is answered by a
  replay `200`.
- **The receipt renders the Report safely.** react-markdown's defaults
  are kept, with `skipHtml`:
  - no raw HTML, inline or block;
  - `javascript:`, `vbscript:` and `data:` links are neutralised,
    including upper-case, entity-encoded and reference-style ones.

  Three choices go beyond those defaults.
  - **Images are never fetched.** Report Markdown is runner output, and
    later slices will put model output there. An
    `![](https://tracker/x.png)` would make the Owner's browser fetch a
    third-party URL on opening the receipt. That leaks the Owner's IP
    and the fact that they opened the Report. So an image renders as its
    alt text, plus its source as a plain link if the URL filter passes
    it.
  - **Links open apart from Swiftlet.** `target="_blank"` keeps a click
    from navigating Swiftlet away. `rel="noopener noreferrer nofollow"`
    gives the opened page no `window.opener` and no `Referer`. A link
    the filter blanked renders as its text, since an empty `href` would
    point back at Swiftlet.
  - **The renderer loads lazily.** react-markdown and its unified,
    remark and micromark dependencies are a separate chunk, fetched
    only when a deliverable is shown. Before the split, the main chunk
    was 503.11 kB (151.67 kB gzipped), over Vite's 500 kB warning.
    After it, the main chunk is 387.94 kB (116.95 kB gzipped) and the
    renderer chunk 116.65 kB (35.45 kB gzipped), with no warning. The
    main chunk contains no micromark, mdast, hast-util or unified code.
    Tests await the lazy component: `Markdown.test.tsx` waits for the
    fallback to go, and the page test awaits the renderer module inside
    `act` under fake timers.

### Earlier limitations this slice closes

- **M4.8, "`RoundState` on the wire is `[claimed, running]`."** It is
  now `[claimed, running, delivered]`, and the open Round has its own
  `OpenRoundState`.
- **M4.8 and M4.9, "A Round never ends in M4."** Closed for `delivered`.
  Stop, Failed and Interrupted remain M5
  ([#6](https://github.com/cristoforows/ticketIt/issues/6)).
- **M4.7, "accepted once closed" proven only with
  `deliverRoundDirect`.** Galley tests now close Rounds through the
  API. The browser now shows the unlock: the Basic spec sees
  `ticket-detail-locked` disappear when the Round delivers.
- **M4.9, "Swiftlet shows activity and usage only for the open
  Round."** Partly closed: delivered Rounds now stay on the receipt with
  their activity, usage and deliverable. A full Round history is M4.11
  and M5.

## Exact versions and toolchain

- Go 1.27.1 (darwin/arm64), pgx v5.11.0, golang-migrate v4.20.1,
  oapi-codegen v2.8.0, kin-openapi v0.149.0 (`apps/galley/go.mod`).
- PostgreSQL 17.11 (Homebrew, local, trust auth).
- Node v26.9.0.
- Swiftlet: Vitest 5.0.1, TypeScript 7.0.2, react-markdown 10.1.0
  (pinned in `package.json`, confirmed in `package-lock.json`).
- Michelin: Vitest 5.0.1, TypeScript 5.9.3.
- e2e: `@playwright/test` 1.63.0.

## Reproducible commands

```sh
cd apps/galley
export GALLEY_TEST_DATABASE_URL='postgres://localhost:5432/ticketit_test_m410?sslmode=disable'
gofmt -l . && go vet ./... && go build ./...
go test ./... -count=1
go test -race -count=1 -run 'Delivered|RoundDeliverables|RoundEvent|Round|OpenRoundLock|AllowedActions' ./internal/httpapi
./scripts/check-contract-drift.sh      # with the regenerated api.gen.go staged
cd ../../contracts && npm ci && npm run check:swiftlet-drift && npm run check:michelin-drift
cd ../apps/michelin && npm ci && npm run typecheck && npm test
cd ../swiftlet && npm ci && npm test && npm run build
cd ../../e2e && env -u FORCE_COLOR E2E_DATABASE_URL='postgres://localhost:5432/ticketit_e2e_m410?sslmode=disable' ./run.sh
```

## Observed results

**Checks**

- `gofmt -l .` printed nothing. `go vet ./...` and `go build ./...` were
  clean.
- Galley `go test ./... -count=1`: every package `ok`. 302 top-level
  tests, 1021 with subtests (was 286 and 976). 0 failed, 0 skipped.
- `go test -race` over the delivery, event, Round, lock and
  allowed-actions tests: `ok`, with no race report.
- Drift checks, with the regenerated files staged:
  - `OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).`
  - `OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).`
  - `OK: ../apps/michelin/src/api/generated/schema.d.ts matches openapi.yaml (no drift).`
- Michelin: typecheck clean; 235 tests passed (was 194).
- Swiftlet: 22 files, 397 tests passed (was 373), stable across three
  consecutive runs. `npm run build` succeeded with no chunk-size
  warning. The chunks were:
  - `index` 387.94 kB (116.95 kB gzipped);
  - `MarkdownRenderer` 116.65 kB (35.45 kB gzipped);
  - CSS 37.87 kB.
- Browser suite: `SUITE PASSED`. 36 specs exited 0, and 86 tests passed
  (was 35 and 83). `runner-delivery.spec.ts` passed in 22.7 s:
  - Basic: 8.5 s.
  - Coding: 3.5 s.
  - Sequencing: 10.3 s.

**New Galley tests** (`round_delivery_test.go`, plus additions to
`round_events_test.go`, `ticket_rounds_test.go`, `contract_test.go` and
`no_execution_side_effects_test.go`):

| Test | What it pins |
| --- | --- |
| `TestDelivered_MovesTheTicketToInReviewAndRetainsTheDeliverable` | `201` result; Round `delivered` with `ended_at`; Ticket In Review; one deliverable row; `Ticket.delivery` and the rounds list |
| `TestDelivered_EndedAtNeverPrecedesStartedAt` | `GREATEST(now, started_at)` |
| `TestDelivered_AFailureAtTheLastWriteRollsBackEveryChange` | a trigger fails the event insert → `503`, full snapshot unchanged |
| `TestDelivered_ABrokenTicketInvariantRecordsNothingAndAnswers500` | Ticket not In Progress → `500`, nothing recorded |
| `TestDelivered_ReplayReturnsTheOriginalResultAndRetainsOneDeliverable` | same bytes → `200`, identical body, one row, also after the slot is reused |
| `TestDelivered_ConcurrentDeliveriesApplyExactlyOnce` | concurrent identical deliveries → one `201`, the rest `200`, one row |
| `TestDelivered_RejectionsChangeNothing` | claimed, stale epoch, already delivered, unknown, foreign, malformed, unauthenticated and revoked credentials; snapshot unchanged |
| `TestDelivered_DataLimitsAtTheAPI` | each limit at and past its bound, including multibyte text, blanks and control characters |
| `TestRoundEvent_RequestBodyIsCappedAt8MiB` | the three bodies above |
| `TestRoundDeliverables_TheDatabaseEnforcesItsInvariants` | each CHECK, the unique key and the foreign key, named by `ConstraintName` |
| `TestDelivered_AcceptFollowsTheRetainedCompletionCondition` | Basic available → Done; Coding refused; `allowedActions` equals the command's answer |
| `TestDelivered_ReleasesTheOpenRoundLock` | each mutation refused while the Round is open succeeds after delivery: title, goal, Success Criteria, assignment, Badges, Accept, archive. A move to Ready gets `invalid_transition` rather than the lock |
| `TestDelivered_FreesTheSlotAndTheNextClaimFollowsPriority` | the next claim is the next Ticket in priority order |
| `TestDelivered_ADoneTicketMovedBackToReadyIsQueuedForANewRound` | Accept → Done → Ready, then a claim of sequence 2; `delivery` is `null` while Round 2 is open and names Round 2 once it delivers; each Round keeps its own deliverable |
| `TestDelivered_RacingAnOwnerCommandIsSerialisedEitherWay`, `TestDelivered_RacingTheOwnersCommandsNeitherDeadlocksNorLeavesInconsistentState` | the lock argument above |
| `TestRoundEvents_ResponsesMatchContractAndMethod405` | delivered `400`, `413`, `201`, `200`, `409`, `409`; the rounds list, `GET` Ticket and the Ticket list after a real delivery, all validated against the contract |

**Browser suite.** `tests/runner-delivery.spec.ts` drives a real
Michelin process through Swiftlet → Galley → Michelin on PostgreSQL.

- **Basic.** The script is `start`, a note, a 6 s wait, then `deliver`.
  1. The receipt opens while the Round is running. It shows In Progress
     and locked, and a marker is set on `window`.
  2. Without a reload, the receipt turns to In Review. It shows
     "Delivered by <Agent>", the summary, the assessment and the
     rendered Report (heading, emphasis, list), and the lock goes.
  3. The Report's `<script>` is absent and its `javascript:` link is
     neutralised. The marker survives, so it is the same document, and
     the script never ran.
  4. The Report's `https:` link has `target="_blank"` and `rel="noopener
     noreferrer nofollow"`. Its image is not an `<img>`: the alt text
     and the source show as a link. The page never requests the
     image's host, checked through Playwright's request log for the
     whole test, including after the reload.
  5. The API shows the Ticket In Review, `allowedActions.statusChanges:
     []` and Accept available. The Round is delivered with the
     deliverable byte for byte, and `endedAt` equals
     `delivery.deliveredAt`.
  6. Accept → Done, which survives a reload with the Report still
     shown.
- **Coding.** The default script delivers.
  - The Ticket stops at In Review.
  - The Accept command answers `400 reviewed_pr_merge_not_implemented`,
    with the same message as `allowedActions`.
  - The receipt has no Accept button, shows that message and renders
    the "Result" heading.
- **Sequencing.** Two Tickets are queued, the first reordered ahead.
  - While the first is not In Review, the second is polled every 250 ms
    and stays Ready, with no open Round.
  - The second Round's `claimedAt` ≥ the first's `endedAt`.
  - Michelin's log reads, in order: claimed 1, delivered 1, claimed 2,
    delivered 2.
  - Both slips sit in In Review with "Delivered by".

**Falsification.** Each change was applied, the suite was run, and the
file was restored with `git checkout` (Galley: `go test ./internal/...`;
Michelin and Swiftlet: the whole Vitest suite).

| # | Change | Result |
| --- | --- | --- |
| 1 | Skip the deliverable insert (replaced by a `SELECT` of the same parameters) | 8 failed: `TestDelivered_MovesTheTicket…`, `…ReplayReturns…`, `…ConcurrentDeliveries…`, `…DataLimitsAtTheAPI`, `…ADoneTicketMovedBackToReady…`, `…RacingTheOwnersCommands…`, `TestRoundEvent_RequestBodyIsCappedAt8MiB`, the contract test. (The first attempt, wrapping the insert in `if false`, did not compile and was redone) |
| 2 | Drop the Ticket status guard (`AND status = 'InProgress'`) | `TestDelivered_ABrokenTicketInvariantRecordsNothingAndAnswers500` |
| 3 | Accept `delivered` on a claimed Round | 2 failed: `TestDecideRoundEvent`, `TestDelivered_RejectionsChangeNothing` |
| 4 | Remove the 8 MiB body cap | 2 failed: `TestRoundEvent_RequestBodyIsCappedAt8MiB`, the contract test |
| 5 | Body limit off by one (1 MiB + 1) | `TestDelivered_DataLimitsAtTheAPI` |
| 6 | Drop the `octet_length` CHECK (migration) | `TestRoundDeliverables_TheDatabaseEnforcesItsInvariants` |
| 7 | Skip the replay lookup | 11 failed, including `TestDelivered_ReplayReturns…`, `TestDelivered_ConcurrentDeliveries…`, the contract test and M4.8/M4.9's replay tests |
| M1 | Michelin sends a new idempotency key on each retry | 11 failed in `engine.test.ts`, including "resends the identical bytes under the same key on every retry, and accepts a replay" |
| M2 | Michelin changes the deliverable's body on each retry | 1 failed: "resends the identical bytes under the same key on every retry, and accepts a replay" |
| M3 | Michelin allows `deliver` before the last step | 5 failed: four ordering tests and "reports every problem at once" |
| S1 | Swiftlet fetches Rounds only for an open Round | 6 failed: the same-tick delivery test, the delivered-load test and four parse-refusal page tests |
| S2 | Remove `skipHtml` | "never renders raw HTML, inline or as a block" |
| S3 | Disable the URL filter (`urlTransform={(url) => url}`) | 7 failed: the six unsafe-link cases and "shows an image with an unsafe source as its alt text alone" |
| S4 | Render a safe image as `<img>` | 2 failed: "never fetches an image…", "opens every link in a new browsing context…" |
| S5 | Drop `target` and `rel` from links | "opens every link in a new browsing context with no opener, Referer or endorsement" |
| S6 | Import the renderer statically | "shows a fallback until the renderer loads…" failed, and `npm run build` warned again (main chunk 503.62 kB) |

## Implementation limitations and follow-ups

- **Reports live in PostgreSQL**, as the Decisions specify, because
  object storage (D7: Cloudflare R2 or Supabase Storage) is not
  selected. Moving Reports to storage is M7
  ([#8](https://github.com/cristoforows/ticketIt/issues/8)).
- **No rework from In Review.** An Agent-assigned In Review Ticket has
  no status change. Accept (Basic) or the Coding refusal are the only
  actions. Rework is M4.11
  ([#137](https://github.com/cristoforows/ticketIt/issues/137)).
- **`delivered` is the only way a Round ends.** Stop, Failed,
  Interrupted, questions, Permissions and stranded-runner recovery (D5)
  are M5 ([#6](https://github.com/cristoforows/ticketIt/issues/6)). A
  Round whose runner dies still stays open, and the browser suite still
  resets before its Round-holding specs.
- **Only the events endpoint caps its body.** Other endpoints still read
  unbounded bodies. They take small JSON and need an Owner session or a
  runner credential. A general cap is not owned by any milestone yet;
  the gate report should assign it.
- **Times on the receipt are raw RFC 3339**, as in M4.8 and M4.9. Local
  formatting is M5's visual work.
- **A replay never returns the deliverable.** It returns the stored
  outcome. The deliverable is read from the rounds list.
- **The DB not-blank CHECK covers ASCII whitespace only.** Galley's
  validation rejects every Unicode-blank value. The CHECK is the
  backstop, as for M4.9's notes.

## Outstanding checks and owning milestone

- Stop, Failed, Interrupted and reconciliation of a Round whose runner
  is gone, including a delivery that arrives after recovery: M5 (#6,
  D5).
- Reviewed-PR-merge evidence for Coding Tickets: D2 and M8. The refusal
  is unchanged here.
- Reports produced by a real engine (OpenCode, LangGraph) and stored in
  object storage: M6 and M7 (#8). M4 makes no provider or storage call.
- Rework and the Round history on the receipt: M4.11 (#137).
- The milestone gate reconciles `docs/evidence/m4/README.md`,
  `docs/open-decisions.md` and the plan documents. This slice does not
  edit them.

## Decision impacts (open-decision IDs)

- **D7** (object storage): Reports are kept in PostgreSQL with a 1 MiB
  bound, which is enough for M4's scripted output. The table has one
  row per Round, so a later move to storage is per row. This record does
  not select a store.
- **D2** (reviewed-PR-merge evidence): a delivered Coding Ticket stays
  In Review with Accept refused. Delivery does not count as merge
  evidence.
- **D5** (stranded-runner recovery): a replayed delivery is answered
  from the stored result and changes nothing. A late delivery on an
  ended Round is refused with no change. Recovery is not decided here.
- None of D1, D3, D4, D6, D8 or D9. D3's guardrail
  (`TestNoTemplateToCapabilityMapping`) is unchanged and passes.
