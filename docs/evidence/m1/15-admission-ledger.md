# M1.4 — Admission ledger and fake clock substitute

## Purpose

Prove, with deterministic fixtures, that the Permission and control-state
rules in `docs/v1-scope.md` ("Permissions and accounts"),
`docs/agent-execution.md` ("Permissions and connected accounts", "Local
first", "Autonomy") and `docs/contracts/execution-interface.md` (Stop,
reconciliation) can be encoded as a bounded local substitute for Galley's
authorization/control state, driven by `FakeClock` rather than wall time.
This is
[M1.4 — Admission ledger and fake clock substitute (#15)](https://github.com/cristoforows/ticketIt/issues/15),
the workspace-scaffolding-into-substance slice that
[docs/integration-feasibility.md](../../integration-feasibility.md)'s
S2 ("Live permission and disconnect admission") experiments will drive
in a later M1 slice: "Assert zero new supported admissions while
offline; already-dispatched work may finish. On reconnect, expired/
revoked grants or pending Stop must prevent stale continuation. A new
valid grant permits the same intact round to continue." This slice adds
the ledger those S2 tests need; it does not itself run an OpenCode
process or a real Galley/Michelin boundary.

Relevant open decisions per `docs/open-decisions.md` (read only, not
edited — see "Decision impacts" below): **D1** ("Enforceable OpenCode
action boundary and disconnect behavior" — this ledger is a concrete,
testable shape for the admission side of that boundary) and **D8**
("In-flight manual revocation and non-budget execution limits" — this
ledger's already-dispatched/`dispatch()`/`complete()` carve-out is a
concrete behavior for exactly the "already-dispatched handling" D8
asks to define).

## Exact versions

- Node: `v26.9.0` (matches `experiments/.nvmrc` and every package's
  `engines.node`)
- npm: `11.19.1`
- OS: macOS (Darwin 25.6.0), arm64
- `typescript`: `7.0.2` (devDependency, pinned exact, in `experiments/shared`,
  `experiments/_template`, `experiments/tracer-fake-clock`)
- `tsx`: `4.23.13` (devDependency, pinned exact, all three packages above)
- `@types/node`: `26.6.1` (devDependency, pinned exact, all three packages)
- Test runner: Node's built-in `node --test`, loaded via
  `node --import tsx --test`. No `vitest`, no other runtime dependency.
- `shared`'s runtime dependency graph is unchanged by this slice: it uses
  only `node:http`, `node:assert/strict`, and `node:test`
  (Node built-ins), plus the existing `FakeClock`. No new `dependencies`
  entry was added to `experiments/shared/package.json`.

## Reproducible commands

Run from a clean checkout:

```sh
cd experiments/shared
rm -rf node_modules
npm ci
npm test
npm run typecheck

cd ../_template
rm -rf node_modules
npm ci
npm test

cd ../tracer-fake-clock
rm -rf node_modules
npm ci
npm test
```

No environment variables, fixtures, or external services are required.
The HTTP facade test in `experiments/shared/test/ledger-server.test.ts`
binds to `127.0.0.1` on an OS-assigned ephemeral port (`startLedgerServer(ledger, 0)`)
and calls it with the global `fetch`; nothing leaves the loopback
interface and no port is hardcoded.

## Documentation research (unverified)

None beyond the required-reading docs listed in this issue's setup
(`docs/v1-scope.md`, `docs/agent-execution.md`,
`docs/contracts/execution-interface.md`,
`docs/integration-feasibility.md`). No external provider or library
documentation was consulted: the admission ledger and its HTTP facade
use only `node:http`, `node:test`, and `node:assert/strict`, which this
workspace already depends on and has previously exercised (see
`docs/evidence/m1/14-experiment-workspace.md`).

## Fixture/stub evidence (observed)

All commands above ran successfully on the versions in "Exact versions":

- `experiments/shared`: `npm ci` → `added 8 packages, and audited 9
  packages`, 0 vulnerabilities (unchanged from the M1.3 baseline — no
  new runtime dependency was introduced). `npm test` → **40/40** tests
  passed: the 11 pre-existing `FakeClock`/evidence-helper tests plus 27
  new tests in `test/admission-ledger.test.ts` and 2 new tests in
  `test/ledger-server.test.ts`. `npm run typecheck`
  (`tsc -p tsconfig.json --noEmit`) passed with no errors, including the
  `@ts-expect-error` assertion described below.
- `experiments/_template`: `npm ci` → `added 9 packages, and audited 11
  packages`, 0 vulnerabilities. `npm test` → 1/1 test passed (unchanged;
  confirms the `shared` package still resolves and type-strips cleanly
  through `file:../shared` after this slice's additions).
- `experiments/tracer-fake-clock`: `npm ci` → `added 9 packages, and
  audited 11 packages`, 0 vulnerabilities. `npm test` → 2/2 tests passed
  (unchanged).
- `git status --porcelain` after `npm ci` in all three packages shows no
  `package-lock.json` diff anywhere in `experiments/`: `shared` gained no
  runtime dependency, so its lockfile is untouched, and neither consumer
  package's lockfile changed either.

### Public API added (`experiments/shared/src/index.ts`)

- `AdmissionLedger` (class), constructed with a `FakeClock`:
  `grant(input)`, `revoke(grantId)`, `ticketDone(ticketId)`,
  `ticketReopened(ticketId)`, `setConnected(connected)`,
  `requestStop(roundId)`, `confirmStop(roundId)`, `admit(request)`,
  `dispatch(admissionId)`, `complete(admissionId)`, `decisions()`,
  `dispatches()`, `state()`.
- Types: `GrantKind` (`TicketGrantKind | TimeGrantKind` discriminated
  union), `GrantInput`, `Grant`, `AdmitRequest`, `AdmitDecision`
  (`"allow" | "deny" | "hold"`), `AdmitReason`, `AdmitResult`,
  `AdmissionRecord`, `DispatchRecord`, `LedgerState`.
- `assertGrantKind(kind)`: the runtime guard against combining
  `ticketId` and `expiresAt`, exported so it can be tested and reused
  independently of the ledger.
- `startLedgerServer(ledger, port)` / `LedgerServerHandle`: the minimal
  `node:http` facade exposing `GET /state`, `POST /admit`,
  `POST /dispatch`, `POST /complete` as JSON, for a process running the
  planned OpenCode admission bridge (issue #20) to call over loopback
  instead of importing this package directly.

### Decision semantics implemented in `admit()`

Evaluated in this order (see the doc comment on `AdmissionLedger.admit`
in `experiments/shared/src/admission-ledger.ts` for the full rationale):

1. A pending Stop for the request's `roundId` always denies with reason
   `"stop-pending"`, even over an otherwise-valid grant.
2. Otherwise, the best matching grant for
   `(agentId, account, action, resource[, ticketId])` is evaluated. A
   valid one allows; none valid denies with the most specific reason
   found, checked in this order: `"revoked"` > `"ticket-done"` >
   `"expired"` > `"no-grant"`. This ordering is a design choice this
   slice made (the issue does not enumerate a required deny-reason
   priority); it is recorded here rather than left implicit.
3. If the ledger is disconnected, an otherwise-`"allow"` outcome is
   downgraded to `"hold"` (reason `"disconnected"`); an otherwise-`"deny"`
   outcome stays `"deny"`. This directly implements the acceptance
   criterion's own wording: "every new admission is held **or** denied"
   — confirmed by the tests `"disconnected: an otherwise-valid admission
   is held, not allowed"` and `"disconnected: an admission that would be
   denied anyway is still denied, not held"`.

### Rule-to-spec mapping

Every row cites the exact sentence the corresponding test encodes.

| Rule | Test(s) | Spec sentence |
| --- | --- | --- |
| Disconnected: new admissions pause (hold), not deny, when they'd otherwise be allowed | `disconnected: an otherwise-valid admission is held, not allowed` | agent-execution.md, "Local first": "Pause new actions when the runner loses contact with ticketIt." / v1-scope.md, Lifecycle table: "Michelin loses contact with Galley \| Locked, Runner disconnected \| Pause new actions; intact state may continue on reconnect." |
| Disconnected: an admission that would be denied anyway (no grant) stays denied, not held | `disconnected: an admission that would be denied anyway is still denied, not held` | integration-feasibility.md, S2: "Assert zero new supported admissions while offline" (a denial is already zero new admission; disconnect does not turn a deny into a softer hold) |
| Disconnected: an already-dispatched action can still be completed | `disconnected: an already-dispatched action can still be marked completed` | integration-feasibility.md, S2: "already-dispatched work may finish" / v1-scope.md, "Permissions and accounts": "Already-dispatched actions may complete on expiry." (generalized here to disconnect, mirroring the same already-dispatched carve-out) |
| Expired time-based grant denies only its own scope; other valid scopes still allow | `time-based expiry denies that scope while other permitted scopes still allow` | v1-scope.md, "Permissions and accounts": "Expired authority does not stop otherwise permitted work" |
| A renewed grant after expiry lets the same Round continue | `a renewed time-based grant lets the same Round continue after expiry` | agent-execution.md, "Permissions and connected accounts": "Manual revocation takes effect for subsequent tool actions, as do newly approved grants." / integration-feasibility.md, S2: "A new valid grant permits the same intact round to continue." |
| Revocation denies subsequent admissions for that scope | `revocation denies subsequent admissions for that scope` | agent-execution.md, "Permissions and connected accounts": "Manual revocation takes effect for subsequent tool actions" |
| Already-dispatched work completes without a new admission after revocation | `already-dispatched work completes without a new admission after revocation` | v1-scope.md, "Permissions and accounts": "Already-dispatched actions may complete on expiry." (revocation reuses the same already-dispatched carve-out; "Handling already-dispatched actions during revocation remains to be specified" per agent-execution.md, so this experiment records its own chosen behavior rather than claiming the open point resolved) |
| Ticket-based grant is valid across multiple Rounds of the same Ticket | `ticket-based grant is valid across multiple Rounds of the same Ticket` | v1-scope.md, "Permissions and accounts" table: "Ticket-based \| Specified agent and ticket; survives review/rework, permanently ends at Done" |
| Ticket-based grant never matches a different Ticket | `ticket-based grant never matches a different Ticket` | v1-scope.md, "Permissions and accounts" table, "Ticket-based" row: scope is "Specified agent **and ticket**" |
| Ticket-based grant permanently ends at Ticket Done | `ticket-based grant permanently ends at Ticket Done` | v1-scope.md, "Permissions and accounts" table: "permanently ends at Done" |
| `ticketReopened` does not restore a Done-ended ticket grant | `ticketReopened does not restore a ticket-based grant ended by Done` | v1-scope.md, "Permissions and accounts" table: "reopening does not restore it" |
| Time-based grant survives Ticket Done | `time-based grant survives Ticket Done` | agent-execution.md, "Permissions and connected accounts": "Time-based: applies to the specified agent across tickets within its authorized scope until the configured expiry. Individual ticket completion does not revoke it." |
| Time-based grant applies across Tickets within scope | `time-based grant applies across Tickets within its authorized scope` | v1-scope.md, "Permissions and accounts" table: "Time-based \| Specified agent across tickets within authorized scope, until expiry regardless of individual completion" |
| Time-based grant ends at its configured expiry | `time-based grant ends at its configured expiry` | agent-execution.md, "Permissions and connected accounts": "Time-based: ... until the configured expiry" |
| Pending Stop denies with `stop-pending`, taking precedence over an otherwise-valid grant | `pending Stop denies with reason stop-pending, taking precedence over an otherwise-valid grant` | execution-interface.md, "Stop with evidence-bearing confirmation": "The owner's Stop request is an owner command to Galley, which records a pending 'Stop requested' command for the Round and keeps the Ticket locked with a Stopping indicator." |
| A pending Stop is cleared only by `confirmStop` | `a pending Stop is cleared only by confirmStop` | execution-interface.md, "Stop with evidence-bearing confirmation": "Only 'Stop confirmed' moves the Round to Stopped ... No other signal (disconnect, timeout, or an unacknowledged Stop command) is treated as confirmation." |
| Combining `ticketId` and `expiresAt` in one grant kind throws at runtime | `constructing a grant kind with both ticketId and expiresAt throws at runtime`, `assertGrantKind rejects a combined kind directly, independent of the ledger` | v1-scope.md, "Permissions and accounts": "Never combine ticket and time restrictions into a single grant." |
| Combining `ticketId` and `expiresAt` is rejected at the type level | `grant kind type-level exclusivity is pinned for npm run typecheck` (checked by `npm run typecheck`, not `npm test` — see below) | v1-scope.md, "Permissions and accounts": "Never combine ticket and time restrictions into a single grant." |
| `decisions()` exposes every admission with a fake-clock timestamp | `decisions() exposes every admit() call with its fake-clock timestamp` | integration-feasibility.md, "Planned feasibility experiments": "Use deterministic local model/API stubs, synthetic credentials, fake clocks, and dispatch ledgers first." |
| `dispatch()`/`complete()` build a dispatch ledger; dispatch requires `allow` | `dispatch() requires an allow decision and records a fake-clock timestamp`, `complete() requires the admission to have been dispatched first` | issue #15, "This slice adds ... a dispatch ledger so later experiments can assert 'zero new admissions while offline' and 'already dispatched may finish'." |
| No Skill/Recipe/instruction has a path to create a grant | `the ledger's public method surface has no path for a Skill, Recipe, or instruction to create a grant` | CONTEXT.md, **Skill**: "neither grants permission to act" (of Skills and Recipes) |
| HTTP facade exposes admit/dispatch/complete/state over loopback | `startLedgerServer exposes admit/dispatch/complete/state over loopback`, `a malformed dispatch request (unknown admissionId) returns a 400, not a crash` | issue #15: "add a minimal local HTTP facade ... exposing admit/dispatch/complete/state so a plugin running in another process (the OpenCode admission bridge, issue #20) can call it" |

Two tests are pinned type-level/API-surface assertions rather than a
distinct behavioral rule:
`assertGrantKind rejects an incomplete ticket kind (missing ticketId)`
and `assertGrantKind rejects an incomplete time kind (missing
expiresAt)` guard the discriminated union's own required fields, and
`admit() denies with no-grant when nothing matches the requested scope`
/ `grant() records a Permission and admit() allows within its scope` are
baseline sanity checks the other rows build on.

### Type-level enforcement is a separate command from `npm test`

`npm test` in this workspace runs `node --import tsx --test`, and `tsx`
only strips TypeScript syntax — it does not type-check (see
`experiments/README.md`, "Why this runner"). The "type-level (and
runtime)" requirement in issue #15 for rejecting a combined
`{ ticketId, expiresAt }` grant kind is therefore split across two
mechanisms in this repository's existing conventions:

- **Runtime**: `assertGrantKind()`, called from `grant()`, throws
  `TypeError` if both `ticketId` and `expiresAt` are present on the
  input object, regardless of how it was constructed (including a
  `JSON.parse`d HTTP body that bypasses TypeScript entirely). Covered by
  `npm test`.
- **Type-level**: `GrantKind` is a discriminated union
  (`TicketGrantKind | TimeGrantKind`), so a `GrantKind`-typed object
  literal carrying both fields is a `tsc` error (TS2353, excess
  property). `experiments/shared/test/admission-ledger.test.ts` pins
  this with a `// @ts-expect-error` line; `npm run typecheck`
  (`tsc -p tsconfig.json --noEmit`) fails if that invariant is ever
  relaxed (an unused `@ts-expect-error` is itself a `tsc` error). This
  was verified directly: temporarily removing the `expiresAt`-carrying
  excess property from the test object made `npm run typecheck` fail
  with "Unused '@ts-expect-error' directive" before the fix was
  reverted, confirming the pin is load-bearing rather than decorative.

## Real-provider evidence (observed, or "none executed")

None executed. This slice makes no call to OpenCode, OpenRouter,
GitHub, or any other real provider or network endpoint. The only
network activity is the HTTP facade test, which is a same-machine
loopback call (`127.0.0.1`, OS-assigned ephemeral port) to a server this
same test process started, per `experiments/README.md`'s "No calls to
real providers or real repositories" rule.

## Observed limitations

- **In-memory, no persistence.** `AdmissionLedger` state lives only in
  the process; there is no serialization/reload path. A real Galley
  would need to survive process restarts; this substitute does not
  attempt that (out of scope for M1's bounded adapter proof).
- **No concurrency control.** All mutations (`grant`, `revoke`,
  `ticketDone`, `requestStop`, `confirmStop`, `admit`, `dispatch`,
  `complete`) are synchronous and single-threaded; there is no locking
  or optimistic-concurrency check. `execution-interface.md`'s "Must
  match current claim epoch" idempotency-key concept for real
  Galley/Michelin events is not modeled here at all — this ledger has no
  concept of a claim epoch, only "connected or not" and "Stop pending or
  not". Concurrent/replayed HTTP calls to the facade would not be
  deduplicated.
- **`resource` and `account` are opaque strings.** The ledger does not
  interpret or validate their shape (e.g. it does not know a GitHub
  account identifier from a filesystem path). Matching is exact-string
  equality on `(agentId, account, action, resource)`; there is no
  wildcard or hierarchical scope matching. Real Permission presets
  (v1-scope.md, "Permissions and accounts": "Use scoped capabilities
  packaged into presets") likely need richer scope matching than this
  experiment models.
- **Deny-reason priority (`revoked` > `ticket-done` > `expired` >
  `no-grant`) is this slice's own design choice**, not dictated by the
  issue or the read docs, since a request could in principle match
  multiple grants in different invalid states simultaneously. Recorded
  explicitly above rather than left to be inferred from source.
- **In-flight handling during manual revocation remains genuinely open**
  per agent-execution.md itself ("Handling already-dispatched actions
  during revocation remains to be specified"). This ledger picked one
  behavior (already-dispatched work is never affected by a later
  revoke/expiry/disconnect — only `dispatch()`/`complete()` calls
  matter, not `admit()` outcomes) because the acceptance criteria
  require it operationally, but that is this experiment's chosen
  behavior for a point the docs mark open, not a resolution of it.
- **The HTTP facade has no authentication, no TLS, and no schema
  validation beyond what `AdmissionLedger`'s own runtime guards
  provide.** It is a same-machine loopback convenience for the planned
  OpenCode admission bridge (issue #20), not a hardened service
  boundary.
- **No admission is tied to a "claim epoch" or any per-connection
  identity.** `setConnected(bool)` is a single global flag; a real
  runner-disconnect model (execution-interface.md, "Runner registration
  and health") is per-runner and per-claim, which this substitute does
  not attempt to represent.

## Outstanding checks and owning milestone

- The actual S2 feasibility experiment ("Live permission and disconnect
  admission" against a real OpenCode process/tool surface, per
  `docs/integration-feasibility.md`) is a separate M1 slice that is
  expected to consume this ledger as its deterministic substitute for
  Galley; it is not run here.
- Persistence, concurrency/claim-epoch semantics, and richer scope
  matching are all explicitly deferred; M4–M6 ("Exercise the
  corresponding application behavior through controlled Rounds",
  `docs/integration-feasibility.md`, "Planned feasibility experiments")
  is expected to implement the real Galley authorization/control state
  this ledger substitutes for.
- The gate-report slice
  ([#29](https://github.com/cristoforows/ticketIt/issues/29)) owns
  reconciling `docs/evidence/m1/README.md`,
  `docs/integration-feasibility.md`, and `docs/open-decisions.md` with
  this record.

## Decision impacts (open-decision IDs)

- **D1**: this experiment gives a concrete, testable shape for the
  admission side of the execution boundary between ticket/round state
  and engine-specific execution (agent-execution.md, "Execution
  boundary": "Ticket management and round history must remain separate
  from engine-specific execution... Permission enforcement,
  human-input handling, cancellation, and available usage data must be
  verified for each integration rather than assumed equivalent."). It
  does not resolve D1; it demonstrates one deterministic way to test
  against it.
- **D5** ("Stranded runner and stop recovery", per
  `docs/contracts/execution-interface.md`, "Stranded claim"): this
  ledger's `setConnected`/pending-Stop model is a simplification that
  does not attempt claim-epoch or stranded-runner semantics; it is
  relevant background for D5 but does not inform a resolution.
- **D8** ("In-flight manual revocation and non-budget execution limits",
  per `docs/open-decisions.md`: "Subsequent actions must observe revoked
  authority. Define already-dispatched handling ... separately from
  deferred spending budgets."): this is the exact open point this
  ledger had to pick a concrete behavior for in order to make the
  acceptance criteria testable — `dispatch()`/`complete()` are
  deliberately independent of `admit()`'s live state (revocation,
  expiry, disconnect, and pending Stop only ever affect the *next*
  `admit()` call; an admission id, once dispatched, can always be
  completed). This experiment observes that this specific behavior is
  implementable and testable; it does not resolve D8 — D8 also
  scopes "reasonable technical loop/time limits", which this ledger does
  not model at all (no loop/time-limit concept exists here).
- Never selects object storage, hosting, native model, or OpenCode
  provider/model, per open decision **D7** and `experiments/README.md`.
