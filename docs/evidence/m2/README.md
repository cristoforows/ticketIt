# M2 evidence index

Evidence records for [M2 — Application foundations and persistent owner
workflow (#3)](https://github.com/cristoforows/ticketIt/issues/3),
covering the thirteen implementation slices (#49–#61) and reconciled by
the gate-report slice ([M2.14, #62](https://github.com/cristoforows/ticketIt/issues/62)).

## Ownership

**Only the gate-report slice (#62) edits this index.** Every other M2
slice adds exactly one new evidence file to this directory and leaves
this file alone, for the same reason M1's equivalent index gives
([docs/evidence/m1/README.md](../m1/README.md)): parallel slices must
not conflict with each other over a shared index file.

## Conventions

- One file per slice issue: `docs/evidence/m2/<issue-number>-<short-slug>.md`
  (e.g. `49-galley-boot.md`).
- Every file follows [TEMPLATE.md](TEMPLATE.md), adapted from
  [M1's template](../m1/TEMPLATE.md) for application code: Purpose;
  What already existed; What this slice added; Exact versions and
  toolchain; Reproducible commands; Observed results; Implementation
  limitations and follow-ups; Outstanding checks and owning milestone;
  Decision impacts.
- Evidence files record what was actually built and run, not a
  substitute for `docs/implementation-plan.md`, `docs/deployment.md`,
  or `docs/open-decisions.md`. No individual slice edits those, or this
  index — the gate-report slice reconciles all of them together.

## Records

Every row is one evidence file; "Establishes" is what the slice set
out to build, and "Headline finding" is its single most consequential
observed result — see the file itself for exact versions, reproducible
commands, and the full set of findings and limitations.

| File | Issue | Establishes | Headline finding |
| --- | --- | --- | --- |
| [49-galley-boot.md](49-galley-boot.md) | [#49](https://github.com/cristoforows/ticketIt/issues/49) | Galley boots independently, serves `GET /api/status` with a fixed five-field shape and the shared JSON error shape, shuts down gracefully | `net/http.ServeMux`'s method-pattern precedence gives `405` for free over `404`; graceful shutdown is proven by re-binding the exact same address immediately after a real `SIGTERM`. |
| [50-swiftlet-boot.md](50-swiftlet-boot.md) | [#50](https://github.com/cristoforows/ticketIt/issues/50) | Swiftlet boots independently of the Go toolchain, fetches and renders Galley's status via a dev proxy, with explicit loading/error states | Built entirely against the issue's fixed JSON shape with no live Galley to verify against (Go was not installed on that machine at the time) — the live two-server check became this slice's own outstanding item, closed by #51. |
| [51-api-contract.md](51-api-contract.md) | [#51](https://github.com/cristoforows/ticketIt/issues/51) | `contracts/openapi.yaml` as the single source of truth, generated types on both sides, a two-part drift check | TypeScript 7 removed the classic Compiler API `openapi-typescript` needs, forcing a second, separate `contracts/` Node toolchain pinned to TypeScript 5.9.3; the drift check was demonstrated actually failing on a deliberate contract/code mismatch, then passing again after reverting. |
| [52-postgresql-persistence.md](52-postgresql-persistence.md) | [#52](https://github.com/cristoforows/ticketIt/issues/52) | Forward-only PostgreSQL migrations, live database health on `GET /api/status`, a development-only diagnostic gated at route registration, restart-durability proof | Two genuinely separate OS processes (not two in-process calls) proved a diagnostic note survives a real `SIGTERM` and restart against the same database; an unreachable database is reported honestly (`database.status: "error"`) without refusing to boot. |
| [53-browser-harness.md](53-browser-harness.md) | [#53](https://github.com/cristoforows/ticketIt/issues/53) | The approved primary test seam: `e2e/run.sh` builds and runs a real Swiftlet production build against a real Galley and real PostgreSQL in Chromium headless shell | The failure-mode spec was proven to actually fail when run against a live (not stopped) Galley, showing the suite can go red; the implementation was recovered from a subagent terminated mid-task by a spend limit, then independently verified end to end by the orchestrating session. |
| [54-oauth-session.md](54-oauth-session.md) | [#54](https://github.com/cristoforows/ticketIt/issues/54) | GitHub OAuth sign-in restricted to one configured Owner, a hashed PostgreSQL-persisted session, the `requireSession` convention later routes reuse | After bootstrap, sign-in is checked against the identity's immutable numeric GitHub account id, never the configured login string again — the Owner can rename their GitHub account later without losing access, and a later edit to the configured login cannot redirect access to a different account. |
| [55-swiftlet-sign-in.md](55-swiftlet-sign-in.md) | [#55](https://github.com/cristoforows/ticketIt/issues/55) | Swiftlet's sign-in page, authenticated shell, and sign-out; a standalone `cmd/githubfake` substitute provider a real browser can reach | Non-owner rejection is Galley's own raw JSON error response, rendered directly by the browser on the OAuth callback redirect — there is no Swiftlet code positioned to soften or reformat Galley's decision, by construction. |
| [56-ticket-capture-list.md](56-ticket-capture-list.md) | [#56](https://github.com/cristoforows/ticketIt/issues/56) | ticketIt's first domain record: title-only Ticket capture into Backlog, an Owner-scoped persisted list, newest-first with an `id` tiebreak | A byte-vs-code-point counting bug in the 200-character title limit (`len()` against a `maxLength` JSON Schema defines in code points) was caught only in review, because every existing test used ASCII where the two counts coincide. |
| [57-ticket-detail-page.md](57-ticket-detail-page.md) | [#57](https://github.com/cristoforows/ticketIt/issues/57) | Client-side routing and the canonical full-page Ticket detail view; `Ticket.id` replaced everywhere with a non-sequential public UUID | Vite's SPA-fallback default (`appType: "spa"`) — not assumed, verified directly against the production build with `curl` — is what makes a hard reload of `/tickets/:id` work at all; a deliberate break (`appType: "mpa"`) reproduced all four detail-page specs failing. |
| [58-refinement-fields.md](58-refinement-fields.md) | [#58](https://github.com/cristoforows/ticketIt/issues/58) | Manual `goal`/`context`/`successCriteria`/`constraints` editing with guidance prompts copied verbatim from `docs/ticket-creation.md`, no AI involved | Partial-update semantics require `*string` pointers end to end (absent vs. empty vs. text) to be genuinely distinguishable; deliberately reintroducing the conflation issue #56 had already fixed once for `title` immediately failed the central partial-update test while every unrelated test stayed green. |
| [59-ticket-templates.md](59-ticket-templates.md) | [#59](https://github.com/cristoforows/ticketIt/issues/59) | Basic/Coding Templates, a `completionCondition` derived once at creation and never recomputed, a `repository` reference field available on either Template | An AST-scanning guardrail test proves no code path anywhere in the module maps a Template to an Agent, engine, or capability; it caught two structurally different deliberate violations (a function and a package-level variable) during this slice, and a third form (a string-literal comparison bypassing identifier matching) found during review, extending the scan. |
| [60-lifecycle-transitions.md](60-lifecycle-transitions.md) | [#60](https://github.com/cristoforows/ticketIt/issues/60) | Galley-enforced Status state machine implementing D3 §2's human-assigned workflow table, a separate explicit Accept command, an Owner Assignee column, transactional concurrency | A deliberately un-locked read-then-write version of the transition handler reproduced two concurrent conflicting transitions **both** applying, on the first trial, every one of five separate re-runs — the real fix (`SELECT ... FOR UPDATE` inside one transaction) was re-verified green three additional times including under `-race`. |
| [61-status-controls.md](61-status-controls.md) | [#61](https://github.com/cristoforows/ticketIt/issues/61) | Swiftlet's own controls for #60's workflow — Status buttons, Accept, Assign/Unassign — inside the reusable `TicketDetail` component, plus the full human-path browser proof | A rejected or stale transition attempt is shown with Galley's actual live rejection reason, cross-checked in a browser spec against a real direct API call rather than trusted as a hardcoded UI string; the one static copy this slice keeps (the `reviewedPrMerge` "Accept unavailable" message) is cross-checked the same way so a future wording drift fails the spec rather than silently going stale. |

## Clean-checkout verification (M2.14, 2026-09-22)

Per issue #62's own rule — "a check you did not run is not a passed
check" — every command below was re-run from this branch
(`m2/62-gate-report`, based on `origin/m2/61-status-controls`) against
a genuinely emptied `ticketit_dev`/`ticketit_test` (dropped and
recreated, not merely reused), a `rm -rf node_modules dist` Swiftlet
tree, and a from-scratch `e2e/run.sh` invocation. None of the output
below is copied from an earlier evidence record.

### Galley

```sh
cd apps/galley
gofmt -l .                          # (no output)
go vet ./...                        # (no output)
go build ./...                      # (no output)
DATABASE_URL="postgres://localhost:5432/ticketit_dev?sslmode=disable" go run ./cmd/migrate
go test ./... -count=1 -v
go test ./internal/httpapi/... -run Contract -v
./scripts/check-contract-drift.sh
```

Observed: `gofmt`/`go vet` produced no output (clean); `go build`
succeeded; migrations applied cleanly to an empty database
(`migrations applied: schema version 7`, all 7 tables present:
`diagnostic_notes`, `oauth_states`, `owner_identities`, `owners`,
`schema_migrations`, `sessions`, `tickets`); `go test ./... -count=1`
passed in all 5 packages (`cmd/galley`, `cmd/githubfake`,
`internal/config`, `internal/githubfake`, `internal/httpapi`) with 103
top-level tests / 214 total `--- PASS` lines including subtests, 0
`--- FAIL`; the 9 contract-response validation tests passed; the
Galley-side drift check reported `OK: internal/httpapi/api.gen.go
matches contracts/openapi.yaml (no drift)`.

### Contracts (Swiftlet-side drift)

```sh
cd contracts
npm ci
./check-swiftlet-drift.sh
```

Observed: `OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches
openapi.yaml (no drift)`.

### Swiftlet

```sh
cd apps/swiftlet
rm -rf node_modules dist
npm ci
npx tsc -p tsconfig.json --noEmit
npm run test -- --run
npm run build
```

Observed: `npm ci` installed 108 packages, 0 vulnerabilities; `tsc
--noEmit` produced no output (clean); 8 test files / 64 tests passed,
0 failures; `npm run build` succeeded (26 modules transformed).

### Browser suite

```sh
cd e2e
./run.sh
```

Observed: `SUITE PASSED` — 31 specs across 15 files, 0 failures,
covering status, sign-in/sign-out/non-owner rejection, session and
Ticket persistence across a genuine Galley restart, Ticket detail
routing (including a real browser back-button check), manual
refinement, both Templates, the full human lifecycle path (capture →
refine → Ready → In Progress → In Review → Accept → Done), manual
Blocked/resume, a rejected-transition case, and the backend-failure
error state. `lsof -iTCP -sTCP:LISTEN -P` after the run showed no
`galley`/`githubfake`/`vite`/`node` listener left behind.

No documented command failed or needed correction to run as written;
every application README and `e2e/README.md` matches what actually
runs.

## Acceptance criteria verification (issue #3)

Each of #3's stated acceptance criteria, verified against the clean
re-run above (not against any older evidence record's copied output):

1. **"Swiftlet and Galley start and build independently, and the
   browser/API smoke path works before authentication or Ticket
   features are layered on."** — **Met.** #49/#50 establish independent
   builds with no cross-toolchain dependency (Galley needs no Node;
   Swiftlet needs no Go); #53 establishes the real-browser smoke path
   against real PostgreSQL. Sequencing: #49→#50→#51→#52→#53 all landed
   before #54 (auth) and #56 (Tickets), so the smoke path was proven
   before either was layered on, not merely proven eventually.
2. **"Configured Owner can sign in; non-owner access is rejected.
   Development diagnostics are unavailable in production."** — **Met.**
   #54 restricts sign-in to one configured Owner and rejects a
   non-owner identity with `owner_mismatch`
   (`TestOAuthSignIn_NonOwnerRejected`); #52's
   `TestDevDiagnosticRoutes_AbsentInProduction` (re-run clean above)
   proves the development-only diagnostic returns the identical `404`
   an unknown route gets when `GALLEY_ENVIRONMENT=production`.
3. **"Tickets and app-owned persisted data survive application
   restart."** — **Met**, at two independent levels. Go-level, real
   separate OS processes: `TestRestartDurability_DiagnosticNoteSurvivesFreshProcess`
   (#52, extended by #54 to also prove the session itself survives) and
   `TestRestartDurability_CompletionConditionSurvivesFreshProcess`
   (#59). Browser-level, a genuine Galley restart mid-suite:
   `session-restart-*`, `ticket-persistence-*`,
   `ticket-refinement-*`, and `ticket-lifecycle-*`
   before/after spec pairs, all re-run green above.
4. **"Title-only Backlog capture and manual refinement work without
   AI."** — **Met.** #56 (title-only capture,
   `TestCreateTicket_TitleOnlyCapturesBacklog`) and #58 (the four
   refinement fields, guidance text copied verbatim from
   `docs/ticket-creation.md`, "No AI of any kind is involved" stated
   and verified in #58's own record — no external call of any kind
   appears anywhere in this diff).
5. **"Human assignment never launches automation, and supported manual
   lifecycle transitions are enforced by Galley."** — **Met.** #60's
   `TestManualLifecycleActionsCreateNoExecutionRecords` asserts, against
   real PostgreSQL, that no table beyond `tickets` exists or gains a row
   from any manual command (assign, every Status transition, Accept,
   unassign) — a falsifiable check, demonstrated actually failing when a
   phantom `rounds` table name was added to its own expectation list.
   The D3 §2 transition table is enforced server-side
   (`TestChangeTicketStatus_D3S2Table`'s exhaustive 36-cell grid) and
   proven live through Swiftlet's own controls (#61's
   `ticket-lifecycle.spec.ts`).
6. **"Template-derived completion conditions remain independent of
   assignment; templates do not become permanent work-type enums."** —
   **Met.** #59 derives `completionCondition` from the Template exactly
   once, at creation (`insertTicket` is the only call site of
   `defaultCompletionCondition`), and proves it is never recomputed even
   when the stored value is made to deliberately disagree with what the
   Template would currently produce
   (`TestUpdateTicket_CompletionConditionNotRecomputedFromTemplate`).
   The guardrail test (`TestNoTemplateToCapabilityMapping`) proves no
   Template-to-Agent/engine/capability mapping exists anywhere in the
   module. `template` is a closed two-value presentation/default
   selector, not a work-type enum — Tickets remain flexible per
   `docs/ticket-creation.md`.

**Scope items** (#3's numbered "Scope" list, 1–6, plus "Establish
browser-to-backend tests with real PostgreSQL"): each maps one-to-one
onto a completed slice — 1↔#49/#50, 2↔#52, 3↔#54, 4↔#56/#57,
5↔#58, 6↔#59/#60/#61 — and the browser-to-backend tests onto #53,
extended by every later slice. All are **Met**; Coding-Template
execution is honestly unavailable (#59's Pull Request section states
this in the UI itself, naming M8), not silently stubbed as working.

No acceptance criterion in #3 is unmet.

## What M2 does not include

Stated plainly, per issue #62's own instruction: M2 has **no Agents,
Rounds, execution, or Michelin** — there is no `apps/michelin`
directory, no Agent Assignee, no engine adapter, and the guardrail test
in #59/#60 exists specifically to keep it that way structurally, not
just by omission. There is **no board, modal, Badges, or archive** —
`TicketDetail` is deliberately reusable for M3's future modal (#57,
#58) but the modal itself does not exist. There is **no object
storage** — Recipes/Reports/Skills do not exist yet (M6/M7). There is
**no hosting** — every verification above ran against a local
PostgreSQL instance and local processes only; nothing was deployed,
and no paid resource or provider account was created, per `AGENTS.md`,
"Paid resources."

## Decisions: what M2 touched

**M2 resolves no open decision.** [D3](../../decisions/d3-agent-template-compatibility.md)
was accepted by the Owner before M2 began (#13) and M2 is the first
milestone to build against it: #59 implements its Template/completion-
condition rule, #60/#61 implement its §2 human-assigned workflow table.
Every M2 slice's own evidence record confirms it resolves nothing
further. D1, D2, D4–D9 are untouched as decisions; M2's concrete
observations relevant to D2 and D4 are recorded in
[docs/open-decisions.md](../../open-decisions.md) as observations, not
resolutions.

**No ADR was added by this slice.** Every M2 engineering choice
reviewed for this criterion (replacing `Ticket.id` with a public UUID
everywhere, the hand-rolled two-route Swiftlet router, the contract
generator/tooling choices, the migration tool and its non-automatic
startup behavior, the AST-scanning D3 guardrail) is recorded in its own
slice's evidence file as "an engineering choice within the approved
design," per that slice's own issue text — none of them is a
hard-to-reverse, surprising choice made through a genuine trade-off at
the scale of ADRs 0001–0003. **No `CONTEXT.md` change was needed
either** — every term M2's slices used (Owner, Ticket, Ticket Template,
Assignee, Status and its six values) was already defined; "completion
condition" is used as the Ticket Template's own attribute name, already
covered by that entry's existing prose, not a missing glossary concept.

## Limitations and follow-ups routed

Every limitation recorded across #49–#61's own evidence files, routed
to its owning milestone, decision, or issue:

| Limitation | Owner | Disposition |
| --- | --- | --- |
| No CI anywhere in the repository | — | Issue [#68](https://github.com/cristoforows/ticketIt/issues/68) (`ready-for-human`), already filed; commented with the e2e-suite gap below. |
| `additionalProperties: false` declared but not enforced (hand-rolled handlers accept unknown request properties) | — | Issue [#75](https://github.com/cristoforows/ticketIt/issues/75) (`ready-for-human`), already filed. |
| No verification against real `github.com` OAuth | M10 | Already explicit in M10's own scope (`docs/implementation-plan.md`, "Document owner bootstrap, OAuth callbacks..."; real-provider acceptance scenarios). No new issue. |
| `#68`'s own text explicitly deferred wiring the browser/e2e suite into CI ("it does not exist until #53... whoever lands that adds it") — #53 has since landed and nobody has picked this up | #68 | Noted in a comment on #68 rather than a duplicate issue. |
| Session TTL fixed at 30 days; no garbage collection of expired `sessions`/`oauth_states` rows | M10 | Issue [#79](https://github.com/cristoforows/ticketIt/issues/79), filed by this slice. |
| `StatusView`'s own error state is no longer reachable by any browser spec since #55 gated the app behind a session check | — | Issue [#80](https://github.com/cristoforows/ticketIt/issues/80), filed by this slice; no specific milestone dependency, pick up opportunistically. |
| Browser suite is Chromium headless-shell only; specs depend on `run.sh`'s file-order phases | M3 (per #53's own record: "revisit when the suite exceeds a handful of authenticated specs") | Already documented as a deliberate, disk-constrained trade-off in `e2e/README.md`; no new issue. |
| `run.sh` assumes a local `createdb`/`psql` on the current user's PostgreSQL | #68 | Noted in the same comment on #68 as the e2e-suite CI gap. |
| The Template guardrail test (#59) cannot see a mapping hidden entirely inside one of its six allowlisted functions | — | Recorded as an accepted, permanent trade-off in the test's own doc comment and in #59's evidence; not actionable without full type-checked data-flow analysis, disproportionate at this scale. No issue. |
| D4's "`Done → Ready` subject to an already-merged PR" caveat is unenforced (#60) | M8 / D4 | Observation added to `docs/open-decisions.md`, D4 section. |
| No Status precondition on Assignee changes; open-Round field locks do not exist (#60/#61) | M4 | Already explicit in M4's own scope (`docs/implementation-plan.md`, "Lock fields during open Rounds"). No new issue. |
| Reviewed-PR-merge completion is impossible in M2 by design (#60/#61) | D2 / M8 | Observation added to `docs/open-decisions.md`, D2 section. |
| `ticketit_test` is shared across all of Galley's `go test` packages and never reset; it grows without bound across sessions | — | Local development-loop hygiene only; CI (#68) will use a fresh service-container database per run and is unaffected. No issue. |
| Concurrent-migration locking (#52) and concurrent-Owner-bootstrap (#54) are exercised only incidentally by `go test`'s own default parallelism, not by a dedicated deterministic race test | M10 (plausible, per #52/#54's own records) | Folded into issue [#79](https://github.com/cristoforows/ticketIt/issues/79), same long-running-deployment hardening concern. |

### New issues filed by this slice

- [**#79** — Garbage-collect expired sessions/OAuth state; configurable
  session TTL; deterministic concurrency races](https://github.com/cristoforows/ticketIt/issues/79)
  — routed to **M10**, linking #52's and #54's own recorded limitations
  plus the concurrent-migration/bootstrap race tests neither slice had
  a trigger to write.
- [**#80** — Restore browser coverage for `StatusView`'s own error
  state](https://github.com/cristoforows/ticketIt/issues/80) — no fixed
  milestone; #55's own evidence record already names the gap.

Both are linked from [#62](https://github.com/cristoforows/ticketIt/issues/62).

This table is now complete for M2. Future milestones extend the
Ticket/Status/Template surface built here; they do not edit this
index — a later gate-report slice, if one is introduced, would follow
the same convention M1's and M2's each did.
