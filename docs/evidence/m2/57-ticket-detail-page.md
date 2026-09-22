# Canonical full-page Ticket details

## Purpose

Adds client-side routing and the canonical, addressable full page for
a single Ticket to Swiftlet, and the Owner-scoped `GET
/api/tickets/{id}` operation to Galley that it fetches from. This is a
read-only view: editing, Templates, and Status transitions are out of
scope (`#58`, `#59`, `#60`/`#61`), as is anything M3 (board, modal,
Badges, archiving). Touches `contracts/`, `apps/galley`,
`apps/swiftlet`, and `e2e/`. Tracking issue: [#57 — M2.9 — Canonical
full-page Ticket details](https://github.com/cristoforows/ticketIt/issues/57),
under [M2 (#3)](https://github.com/cristoforows/ticketIt/issues/3).
Blocked by [#56](https://github.com/cristoforows/ticketIt/issues/56),
merged before this slice began (`docs/evidence/m2/56-ticket-capture-list.md`).

## What already existed

- **Galley**: `tickets` table (`internal/migrations/000003_create_tickets.up.sql`),
  `GET`/`POST /api/tickets` (`internal/httpapi/ticket.go`), both
  Owner-scoped and session-gated. `Ticket.id` was the internal,
  sequential `BIGINT GENERATED ALWAYS AS IDENTITY` primary key,
  returned directly as `id` by both operations. No `GET /api/tickets/{id}`
  operation existed.
- **Swiftlet**: `src/api/tickets.ts` (`fetchTickets`, `createTicket`),
  `src/components/TicketList.tsx` (loading/error/empty/list states plus
  the quick-capture form), mounted inside `AppShell` above `StatusView`.
  **No router was installed** — no `react-router` or any routing
  library in `package.json`, and no client-side navigation existed
  anywhere in this app; every page was the one `App.tsx` root switching
  on session state alone.
- **e2e**: `e2e/support/tickets.ts`'s `createTicket(page, title)` (the
  API-direct test-data helper `#56` established), `tests/ticket-persistence-before/after.spec.ts`,
  and every other spec from `#49`–`#56`. `run.sh`'s phase 10 already
  restarts Galley once, with `tests/session-restart-*` and
  `tests/ticket-persistence-*` sharing it.
- No sibling slice was landing in parallel that this slice depended on.

## What this slice added

### Decision 1 — the public Ticket identifier

**Chosen: replace what `Ticket.id` means and returns, everywhere,
rather than add a second field alongside it.** The alternative (a
separate `publicId` alongside the existing sequential `id`) was
rejected: keeping the sequential id on the wire at all — even next to
an opaque one — still lets a client observe insertion order and
enumerate Tickets by watching `id` increase, which is exactly what a
non-guessable identifier exists to prevent. The issue's own instruction
("prefer a non-guessable, non-sequential public identifier," "apply it
consistently across the contract," "do not leave the API exposing a
sequential id in one place and an opaque one in another") reads as
ruling out any shape where a sequential value is still visible on any
response. Replacing `id`'s meaning everywhere is the only shape that
actually removes the sequential value from the API surface, not just
from URLs.

**Migration** (`apps/galley/internal/migrations/000004_add_ticket_public_id.up.sql`,
forward-only): adds `tickets.public_id UUID NOT NULL UNIQUE`. Backfilled
for pre-existing rows via `gen_random_uuid()`, confirmed to be
PostgreSQL core (built in since PostgreSQL 13; verified directly
against this deployment's `17.11` with `select gen_random_uuid();` and
`select * from pg_cast where casttarget = 'uuid'::regtype;` — see
"Observed results" below) — no `pgcrypto` or other extension needed.
Backfilling was required, not optional: `ticketit_dev`/`ticketit_test`
already held Tickets from `#56`, and this project's migrations are
forward-only (no down-migration could undo a bad backfill later). New
rows generate their own `public_id` in Go
(`insertTicket`'s `uuid.NewString()`), matching how every other
identifier in this codebase (session tokens, OAuth `state`) is
generated in application code rather than left to a database default.
The internal `id` column, and every foreign key that targets it, is
untouched — only what the HTTP API exposes changed.

**Contract**: `Ticket.id`'s schema changed from `type: integer` to
`type: string, format: uuid`, with `x-go-type: string` (documentation
only, not enforced at bind time — matching this contract's existing
convention for `CreateTicketRequest.title`'s `maxLength`). This was
deliberate: oapi-codegen's default mapping for `format: uuid` binds
through `github.com/oapi-codegen/runtime/types.UUID`, which rejects a
malformed value in the generated wrapper itself, before the handler
runs, in a different response shape than this contract's shared
`ErrorBody`. Keeping the Go type a plain `string` means every value
`GetTicket` might see reaches the handler, which folds every failure
mode but the exact right one into the identical `404` (see Decision 1's
consequence, below).

**Every existing consumer was updated, not left inconsistent**:
`apps/galley/internal/httpapi/ticket.go` (`insertTicket`,
`listTicketsForOwner`, and the new `getTicketForOwner` all select/return
`public_id::text` — the internal `id` is never selected into a `Ticket`
struct anywhere in this package anymore), `apps/swiftlet/src/api/tickets.ts`
(`parseTicket`'s runtime shape check), `apps/swiftlet/src/components/TicketList.tsx`
and its test fixtures, and `e2e/support/tickets.ts`'s `Ticket` interface
and every spec using it. `go build`/`go vet`/`gofmt` and `tsc --noEmit`
both caught every call site the type change touched (see "Observed
results").

### Decision 2 — the Swiftlet router

**Chosen: a hand-rolled ~50-line reader of `window.location.pathname`
(`apps/swiftlet/src/router.ts`), not a routing library.** This app
needs exactly two routes today — the Backlog list (`/`) and a Ticket's
full-page detail view (`/tickets/:id`) — and no router existed before
this slice. A third-party router would add a dependency, its own API
surface, and (for data-loader-style routers) a data-fetching convention
this app does not otherwise use, for capability the platform already
provides at this scale. This mirrors `apps/galley/README.md`'s own
"Router choice" (`net/http.ServeMux` over `chi`/`gorilla/mux` for "a
handful of fixed routes") at the equivalent scale on the frontend side;
that section's own "revisit this choice explicitly ... if needs
outgrow this" applies here too, should M3 or later need nested routes,
guards, or code-splitting.

`useRoute()` (`useSyncExternalStore`, subscribed to the browser's real
`popstate` event) parses `window.location.pathname` into `{ name:
"backlog" }` or `{ name: "ticket-detail", ticketId }`; any other path
falls back to the Backlog view (only a Ticket identifier needs its own
not-found presentation in this slice, not an arbitrary route).
`navigate(path)` calls `history.pushState` then dispatches a synthetic
`popstate` event itself — `pushState` alone fires no event, so this is
what unifies an in-app `Link` click and real browser back/forward under
one subscription. `src/components/Link.tsx` is a real `<a href>`
(preserving middle-click/ctrl-click/"open in new tab") that calls
`navigate()` on an unmodified left click instead of a full page load.

### Galley

- `internal/httpapi/ticket.go`: new `GetTicket(w, r, id string)`
  handler and `getTicketForOwner` query function. `requireSession`
  first (the established convention). `uuid.Parse(id)` is checked
  **before** any query runs: a value that fails to parse is folded into
  the same `404 not_found` as "not found," both because the contract
  requires it (never reveal which case occurred) and because
  PostgreSQL has no cast at all — implicit, assignment, or otherwise —
  from `text` to `uuid` (confirmed directly against `pg_cast`, not
  assumed; see "Observed results"), so an unvalidated malformed value
  would fail the `::uuid` cast as a genuine query error, which this
  handler would then have to distinguish from "no rows" to avoid
  mis-reporting a malformed identifier as `503 database_unavailable`.
  `writeTicketNotFound` is the one place that writes the shared
  `404 not_found` shape, used for both the malformed-input path and the
  "zero rows" path.
- `internal/httpapi/handler.go`: registered
  `/api/tickets/{id}` → `methodNotAllowedHandler("GET")`, matching the
  existing pattern for `/api/tickets`.
- `go.mod`: `github.com/google/uuid` promoted from an indirect
  dependency (already pulled in transitively by `oapi-codegen/runtime`
  since `#54`) to a direct `require` via `go mod tidy` — no new module
  was downloaded.
- Regenerated `internal/httpapi/api.gen.go` (`go generate ./...`,
  oapi-codegen v2.8.0, unchanged pin): `Ticket.Id` is now `string`,
  `GetTicket(w, r, id string)` added to `ServerInterface`, `GET
  /api/tickets/{id}` registered in `HandlerWithOptions`. Confirmed the
  generated path-parameter binding never format-validates a plain
  `string` destination (read `oapi-codegen/runtime`'s
  `BindStringToObjectWithOptions` directly — the `reflect.String` case
  is an unconditional `v.SetString(src)`), so a malformed identifier
  really does reach the handler rather than being rejected by generated
  code in a different shape.
- **Tests** (`internal/httpapi/ticket_test.go`, `contract_test.go`, all
  against real PostgreSQL): `TestGetTicket_ReturnsOwnersTicket` (full
  round trip), `TestGetTicket_RequiresSession`,
  `TestGetTicket_UnknownAndMalformedIdentifiersAreIndistinguishable`
  (byte-for-byte comparison of the two response bodies — the same
  technique `production_gating_test.go` uses to prove two responses are
  identical, not merely similar), `TestGetTicket_ScopedToOwner` (see
  "Owner-scoping proof, singleton limitation" below),
  `TestGetTicket_MethodNotAllowed`, a `"get"` subtest added to
  `TestTickets_DatabaseUnavailable`, and `TestGetTicket_ResponseMatchesContract`
  (both the `200` and `404` shapes). Existing tests updated for the
  `string` id: `insertTicketAt` now generates and returns its own
  `public_id` alongside the internal id it already returned (needed
  because `public_id` is random and carries no insertion order of its
  own, unlike the internal `IDENTITY` column the tiebreak test still
  needs to know insertion order).
- **Owner-scoping proof, singleton limitation** (same as `#56`'s own
  recorded limitation for `ListTickets`): `owners` is a true
  one-row-per-deployment singleton (`owners_singleton_uq`), so a second
  real Owner cannot be constructed to prove "another Owner's identifier
  returns 404" by actually creating one — and a ticket cannot be
  inserted under a nonexistent owner id either, since `tickets.owner_id`
  is a `NOT NULL REFERENCES owners(id)` foreign key.
  `TestGetTicket_ScopedToOwner` follows `TestListTicketsForOwner_ScopedToOwner`'s
  established technique instead: it calls `getTicketForOwner` directly
  with a bogus owner id that can never belong to any real Owner, for a
  Ticket that does exist under the real Owner, and asserts it is not
  found — proving the same `WHERE owner_id = $1 AND public_id =
  $2::uuid` filter that also backs `ListTickets`'s scoping is what
  stands between any non-owning caller and a Ticket that exists. This
  is recorded here, not silently worked around, per `AGENTS.md`'s
  honesty expectation — exactly as `#56`'s own evidence record did for
  the analogous limitation.

### Swiftlet

- `src/router.ts` (new), `src/components/Link.tsx` (new) — see
  Decision 2 above.
- `src/api/tickets.ts`: `fetchTicket(id)` and `TicketNotFoundError`
  (thrown on Galley's `404`), mirroring `fetchTickets`/`createTicket`'s
  existing `UnauthenticatedError` convention exactly. `parseTicket`'s
  runtime shape check now expects `id: string`.
- `src/components/TicketDetail.tsx` (new): **pure presentation.** Takes
  an already-fetched `Ticket` prop and renders title, Status, and
  timestamps only — no Rounds, Reports, PR links, or Grill Mode section,
  and no placeholder implying any of them (`docs/ticket-views.md`,
  "Ticket details"). Neither fetches nor routes.
- `src/components/TicketDetailPage.tsx` (new): the fetching/routing
  container. Reads `ticketId` from the route, calls `fetchTicket`, and
  renders exactly one of loading / `TicketDetail` / an explicit
  not-found state (`data-testid="ticket-detail-not-found"`) / an
  explicit error state — never a blank screen or raw error for an
  unknown identifier.
- **Reuse for M3's modal** (issue #57's explicit acceptance criterion):
  M3's modal will need its own container (reading the Ticket from
  wherever the modal was opened, not a route parameter, and without a
  "Back to Backlog" link a full page needs) but can render the *exact
  same* `TicketDetail` component with the exact same `Ticket` prop
  shape inside that different container. `TicketDetail` has no
  awareness of being a full page, a route, or a fetch — which is what
  makes it reusable without a second implementation, rather than merely
  asserted to be.
- `src/components/TicketList.tsx`: each Ticket's title is now a `Link`
  to `/tickets/<id>` (`data-testid="ticket-title"` unchanged — it is
  now the `<a>` itself rather than a `<span>` wrapping plain text).
- `src/components/AppShell.tsx`: reads `useRoute()` and renders either
  `TicketList` + `StatusView` (the Backlog route) or `TicketDetailPage`
  (the Ticket-detail route) beneath the unchanged signed-in-owner/sign-out
  header.
- Regenerated `src/api/generated/schema.d.ts` (openapi-typescript
  7.13.0, unchanged pin).
- **Tests** (Vitest + Testing Library): `router.test.tsx` (route
  parsing, `navigate()`'s synthetic-popstate re-render, and a real
  `popstate` event), `TicketDetail.test.tsx` (renders exactly the four
  fields; explicitly asserts no Rounds/Reports/PR-links/Grill-Mode
  testid exists), `TicketDetailPage.test.tsx` (loading, success,
  not-found on `404`, an explicit error state on any other failure,
  the "Back to Backlog" link, and re-fetching when `ticketId` changes),
  a new "links each Ticket's title" test and updated `id` fixtures in
  `TicketList.test.tsx`, and a new route-switching test in
  `AppShell.test.tsx`.

### e2e

- `e2e/support/tickets.ts`: `Ticket.id` is now `string`.
- `e2e/tests/ticket-detail.spec.ts` (new, 4 specs): opening a Ticket
  from the list (real click, not a direct `goto`) shows its full page
  and a **reload** renders the same content; loading a Ticket's URL
  **directly** renders its full page; an **unknown identifier** renders
  the not-found page; and the Backlog list still renders correctly
  after visiting a Ticket's page and clicking back. Background Tickets
  are created via `e2e/support/tickets.ts`'s API-direct helper (`#56`'s
  established convention: data setup, not the behavior under test); the
  "opening from the list" spec drives the real UI click, since that
  navigation *is* the behavior under test.
- `e2e/run.sh`: new phase (10b) running `tests/ticket-detail.spec.ts`
  against the already-restarted Galley from phase 10, signing in fresh
  (like `status.spec.ts`/`auth.spec.ts`) since no restart is needed for
  this spec. Exit-code aggregation and the final summary log extended
  accordingly.

### The SPA fallback (the named "classic failure point")

**Verified directly, not assumed.** `vite.config.ts` sets no `appType`
(Vite's default is `"spa"`), which enables the HTML-fallback middleware
for both the dev server and `vite preview`: an unmatched path that
accepts `text/html` serves the built `index.html` instead of a static
404. Confirmed with the actual production build and `vite preview`
serving it — see "Observed results" for the exact `curl` output — and
by the browser suite's own reload assertion in
`tests/ticket-detail.spec.ts`. No code change was needed to make this
work; the risk was that it might not, which is why it was checked
directly and a deliberate, reverted break (see "Proof the suite can
fail" below) proves the new specs actually depend on it rather than
merely happening to pass.

## Exact versions and toolchain

- Go `1.27.1` (darwin/arm64) — unchanged.
- Node `v26.9.0` — unchanged.
- `apps/galley`: `github.com/google/uuid` `v1.6.0` — promoted from
  indirect to direct (see "Galley" above); no other dependency change.
  `oapi-codegen/oapi-codegen/v2` `v2.8.0` (unchanged pin) regenerated
  `api.gen.go`; `github.com/getkin/kin-openapi` `v0.149.0` (unchanged)
  validates the new contract test.
- `apps/swiftlet`: no new dependency — `router.ts`/`Link.tsx` use only
  React 19.3.0 and the standard `history`/`window` APIs already
  available; `TicketDetail.tsx`/`TicketDetailPage.tsx` use only React,
  `@testing-library/react`, and Vitest, all already present.
  `openapi-typescript` `7.13.0` (unchanged pin, `contracts/package.json`)
  regenerated `schema.d.ts`. `vite` `8.3.0` (unchanged) — its default
  `appType: "spa"` is what the SPA-fallback verification above depends
  on.
- `e2e`: `@playwright/test` `1.63.0` — unchanged. Chromium's headless
  shell only (`--only-shell`), same as every prior slice.
- PostgreSQL server: `17.11` (Homebrew), `localhost:5432`. Go-side
  verification used `ticketit_test` (real, shared, never reset — see
  "Owner-scoping proof, singleton limitation" above); browser-suite
  runs used `ticketit_e2e`, reset from empty by `run.sh` each time.
  `ticketit_dev` and `ticketit_m1_native` were untouched throughout.

## Reproducible commands

**Galley** (from `apps/galley/`, real PostgreSQL):

```sh
gofmt -l .
go vet ./...
go build ./...
go test ./... -count=1 -v
go test ./internal/httpapi/... -run Contract -v
./scripts/check-contract-drift.sh
```

**Contract drift, Swiftlet side** (from `contracts/`):

```sh
npm ci
npm run generate:swiftlet
./check-swiftlet-drift.sh
```

**Swiftlet** (from `apps/swiftlet/`):

```sh
npm ci
npm run test -- --run
npm run build
```

**SPA fallback, direct verification** (from `apps/swiftlet/`, after
`npm run build`):

```sh
node_modules/.bin/vite preview --host 127.0.0.1 --port 4321 --strictPort &
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4321/tickets/abc-123
```

**Browser suite** (from `e2e/`):

```sh
./run.sh
```

## Observed results

### `gen_random_uuid()` is PostgreSQL core, no extension required

```
$ psql "postgres://localhost:5432/ticketit_test?sslmode=disable" -c "select gen_random_uuid();"
           gen_random_uuid
--------------------------------------
 9323d9cc-bab0-4884-9de9-0a2bdc69c14c
(1 row)

$ psql ... -c "select version();"
 PostgreSQL 17.11 (Homebrew) on aarch64-apple-darwin25.6.0, ...
```

### PostgreSQL has no cast from `text` to `uuid` (confirmed, not assumed)

```
$ psql ... -c "select castsource::regtype, casttarget::regtype, castcontext from pg_cast where casttarget = 'uuid'::regtype;"
 castsource | casttarget | castcontext
------------+------------+-------------
(0 rows)

$ psql <<'SQL'
create temporary table t2 (id uuid);
prepare ins (text) as insert into t2 (id) values ($1);
execute ins('123e4567-e89b-12d3-a456-426614174000');
SQL
ERROR:  column "id" is of type uuid but expression is of type text
HINT:  You will need to rewrite or cast the expression.

prepare sel (text) as select * from t2 where id = $1;
ERROR:  operator does not exist: uuid = text
```

This is why `getTicketForOwner`'s `WHERE ... public_id = $2::uuid`
casts explicitly, and why `GetTicket` validates with `uuid.Parse`
*before* querying: an unvalidated malformed value would fail the cast
as a genuine SQL error, not return zero rows.

### `gofmt` / `go vet` / `go build`

```
$ gofmt -l .
(no output — clean)
$ go vet ./...
(no output — clean)
$ go build ./...
(no output — success)
```

### `go test ./... -count=1 -v` — 64 top-level `--- PASS` + 44 subtest `--- PASS` = 108, 0 `FAIL`

```
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/galley	2.153s
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/githubfake	0.914s
?   	github.com/cristoforows/ticketIt/apps/galley/cmd/migrate	[no test files]
?   	github.com/cristoforows/ticketIt/apps/galley/internal/auth	[no test files]
?   	github.com/cristoforows/ticketIt/apps/galley/internal/authtest	[no test files]
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/config	1.733s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/githubfake	0.498s
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	2.241s
?   	github.com/cristoforows/ticketIt/apps/galley/internal/migrations	[no test files]
?   	github.com/cristoforows/ticketIt/apps/galley/internal/postgres	[no test files]
```

Full `internal/httpapi` Ticket-related output:

```
=== RUN   TestTickets_ResponseMatchesContract
--- PASS: TestTickets_ResponseMatchesContract (0.04s)
=== RUN   TestGetTicket_ResponseMatchesContract
--- PASS: TestGetTicket_ResponseMatchesContract (0.02s)
=== RUN   TestCreateTicket_TitleOnlyCapturesBacklog
--- PASS: TestCreateTicket_TitleOnlyCapturesBacklog (0.02s)
=== RUN   TestCreateTicket_TrimsTitle
--- PASS: TestCreateTicket_TrimsTitle (0.01s)
=== RUN   TestCreateTicket_RejectsBlankTitle
--- PASS: TestCreateTicket_RejectsBlankTitle (0.01s)
    --- PASS: TestCreateTicket_RejectsBlankTitle/blank_ (0.00s)
    --- PASS: TestCreateTicket_RejectsBlankTitle/blank_#01 (0.00s)
    --- PASS: TestCreateTicket_RejectsBlankTitle/blank_#02 (0.00s)
=== RUN   TestCreateTicket_RejectsTitleOverMaxLength
--- PASS: TestCreateTicket_RejectsTitleOverMaxLength (0.01s)
=== RUN   TestCreateTicket_AcceptsTitleAtMaxLength
--- PASS: TestCreateTicket_AcceptsTitleAtMaxLength (0.01s)
=== RUN   TestCreateTicket_CountsTitleLengthInCharactersNotBytes
--- PASS: TestCreateTicket_CountsTitleLengthInCharactersNotBytes (0.01s)
=== RUN   TestCreateTicket_RejectsMalformedJSON
--- PASS: TestCreateTicket_RejectsMalformedJSON (0.01s)
=== RUN   TestCreateTicket_RequiresSession
--- PASS: TestCreateTicket_RequiresSession (0.01s)
=== RUN   TestListTickets_RequiresSession
--- PASS: TestListTickets_RequiresSession (0.01s)
=== RUN   TestListTickets_NewestFirstWithIdTiebreak
--- PASS: TestListTickets_NewestFirstWithIdTiebreak (0.01s)
=== RUN   TestListTicketsForOwner_TiebreaksOnIdWhenCreatedAtTies
--- PASS: TestListTicketsForOwner_TiebreaksOnIdWhenCreatedAtTies (0.01s)
=== RUN   TestListTicketsForOwner_ScopedToOwner
--- PASS: TestListTicketsForOwner_ScopedToOwner (0.01s)
=== RUN   TestGetTicket_ReturnsOwnersTicket
--- PASS: TestGetTicket_ReturnsOwnersTicket (0.01s)
=== RUN   TestGetTicket_RequiresSession
--- PASS: TestGetTicket_RequiresSession (0.00s)
=== RUN   TestGetTicket_UnknownAndMalformedIdentifiersAreIndistinguishable
--- PASS: TestGetTicket_UnknownAndMalformedIdentifiersAreIndistinguishable (0.01s)
=== RUN   TestGetTicket_ScopedToOwner
--- PASS: TestGetTicket_ScopedToOwner (0.01s)
=== RUN   TestGetTicket_MethodNotAllowed
--- PASS: TestGetTicket_MethodNotAllowed (0.00s)
=== RUN   TestTickets_DatabaseUnavailable
--- PASS: TestTickets_DatabaseUnavailable (0.00s)
    --- PASS: TestTickets_DatabaseUnavailable/list (0.00s)
    --- PASS: TestTickets_DatabaseUnavailable/create (0.00s)
    --- PASS: TestTickets_DatabaseUnavailable/get (0.00s)
=== RUN   TestTickets_MethodNotAllowed
--- PASS: TestTickets_MethodNotAllowed (0.00s)
PASS
```

### Contract-response validation and both drift checks

```
$ go test ./internal/httpapi/... -run Contract -v
=== RUN   TestGetStatus_ResponseMatchesContract
--- PASS: TestGetStatus_ResponseMatchesContract (0.03s)
=== RUN   TestGetStatus_DatabaseUnreachableResponseMatchesContract
--- PASS: TestGetStatus_DatabaseUnreachableResponseMatchesContract (0.00s)
=== RUN   TestDiagnosticNotes_ResponseMatchesContract
--- PASS: TestDiagnosticNotes_ResponseMatchesContract (0.02s)
=== RUN   TestTickets_ResponseMatchesContract
--- PASS: TestTickets_ResponseMatchesContract (0.02s)
=== RUN   TestGetTicket_ResponseMatchesContract
--- PASS: TestGetTicket_ResponseMatchesContract (0.02s)
=== RUN   TestGetSession_ResponseMatchesContract
--- PASS: TestGetSession_ResponseMatchesContract (0.02s)
=== RUN   TestErrorResponses_MatchContract
--- PASS: TestErrorResponses_MatchContract (0.01s)
=== RUN   TestAuthErrorResponses_MatchContract
--- PASS: TestAuthErrorResponses_MatchContract (0.01s)
PASS

$ ./scripts/check-contract-drift.sh
OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).

$ cd ../../contracts && npm ci && ./check-swiftlet-drift.sh
> ticketit-contracts@0.0.0 generate:swiftlet
> openapi-typescript openapi.yaml -o ../apps/swiftlet/src/api/generated/schema.d.ts
✨ openapi-typescript 7.13.0
🚀 openapi.yaml → ../apps/swiftlet/src/api/generated/schema.d.ts [16.7ms]
OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
```

### Swiftlet: install, test, build

```
$ npm ci
added 108 packages, and audited 109 packages in 743ms
found 0 vulnerabilities

$ npm run test -- --run
 Test Files  8 passed (8)
      Tests  36 passed (36)

$ npm run build
✓ 26 modules transformed.
dist/index.html                  0.31 kB │ gzip:  0.23 kB
dist/assets/index-720eUBMM.js  230.51 kB │ gzip: 71.33 kB
✓ built in 50ms
```

36 tests across 8 files: `App.test.tsx` (4), `AppShell.test.tsx` (5,
+1 new route-switching test), `SignInPage.test.tsx` (1),
`StatusView.test.tsx` (5), `TicketList.test.tsx` (8, +1 new link
test), `TicketDetail.test.tsx` (2, new), `TicketDetailPage.test.tsx`
(6, new), `router.test.tsx` (5, new).

### SPA fallback, verified directly against the production build

```
$ node_modules/.bin/vite preview --host 127.0.0.1 --port 4321 --strictPort &
  ➜  Local:   http://127.0.0.1:4321/
$ curl -s -o /dev/null -w "GET /tickets/abc-123 -> %{http_code}\n" http://127.0.0.1:4321/tickets/abc-123
GET /tickets/abc-123 -> 200
$ curl -s http://127.0.0.1:4321/tickets/abc-123 | head -5
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
```

### Browser suite — `SUITE PASSED`, 15 specs across 8 files

```
$ cd e2e && ./run.sh
...
[run.sh] running tests/status.spec.ts against a live galley
  ✓  1 [chromium] › tests/status.spec.ts:20:1 › status page displays the values Galley actually returns (359ms)
[run.sh] running tests/auth.spec.ts against a live galley and the substitute GitHub provider
  ✓  1..4 [chromium] › tests/auth.spec.ts (4 passed)
[run.sh] running tests/session-restart-before.spec.ts (signs in, saves storage state)
  ✓  1 [chromium] › tests/session-restart-before.spec.ts:20:1 › the Owner signs in before Galley restarts (134ms)
[run.sh] running tests/ticket-persistence-before.spec.ts (captures two Tickets, newest first)
  ✓  1 [chromium] › tests/ticket-persistence-before.spec.ts:29:1 › the Owner captures two Tickets, newest first, before Galley restarts (235ms)
[run.sh] restarting galley (same database, same origin, new process) to prove the session and Tickets survive
[run.sh] galley ready (pid 74934)
[run.sh] running tests/session-restart-after.spec.ts against the restarted galley
  ✓  1 [chromium] › tests/session-restart-after.spec.ts:21:1 › the session survives a Galley restart (83ms)
[run.sh] running tests/ticket-persistence-after.spec.ts against the restarted galley
  ✓  1 [chromium] › tests/ticket-persistence-after.spec.ts:25:1 › the two captured Tickets are still listed, in the same order, after a Galley restart (88ms)
[run.sh] running tests/ticket-detail.spec.ts against the restarted galley
  ✓  1 [chromium] › tests/ticket-detail.spec.ts:14:3 › ticket detail page › opening a Ticket from the list shows its full page, and a reload renders the same content (242ms)
  ✓  2 [chromium] › tests/ticket-detail.spec.ts:37:3 › ticket detail page › loading a Ticket's URL directly renders its full page (117ms)
  ✓  3 [chromium] › tests/ticket-detail.spec.ts:47:3 › ticket detail page › an unknown Ticket identifier renders a clear not-found page, not a blank screen or a raw error (117ms)
  ✓  4 [chromium] › tests/ticket-detail.spec.ts:57:3 › ticket detail page › the Backlog list still renders correctly after visiting a Ticket's page (172ms)
[run.sh] stopping galley to exercise the failure-mode spec (pid 74934)
[run.sh] running tests/backend-failure.spec.ts against a stopped galley
  ✓  1 [chromium] › tests/backend-failure.spec.ts:28:1 › the app shows its error state when Galley is stopped, instead of a blank or fabricated page (85ms)
[run.sh] status.spec.ts exit code: 0
[run.sh] auth.spec.ts exit code: 0
[run.sh] session-restart-before.spec.ts exit code: 0
[run.sh] ticket-persistence-before.spec.ts exit code: 0
[run.sh] session-restart-after.spec.ts exit code: 0
[run.sh] ticket-persistence-after.spec.ts exit code: 0
[run.sh] ticket-detail.spec.ts exit code: 0
[run.sh] backend-failure.spec.ts exit code: 0
[run.sh] SUITE PASSED
[run.sh] stopping swiftlet preview server (pid 74687)
[run.sh] stopping the substitute GitHub provider (pid 74652)
```

`lsof -i -P` immediately after exit showed no `galley`/`githubfake`/
`vite`/`node` listener left behind, both after this run and after every
deliberately-broken run below.

## Proof the suite can fail

Three separate, targeted, reverted breaks, each capturing the actual
red output, each reverted (confirmed via `diff` against a saved copy of
the pre-break file, showing no difference), followed by a confirming
green run — two at the Go level (one Owner-scoping, one 404 logic, both
against the real, shared `ticketit_test` database, satisfying the
requirement that at least one break target Owner-scoping or 404
logic), one at the browser level (the named SPA-fallback risk).

**1. Owner-scoping removed** (`getTicketForOwner`'s query changed from
`WHERE owner_id = $1 AND public_id = $2::uuid` to `WHERE public_id =
$1::uuid`, dropping the owner filter entirely):

```
$ go test ./internal/httpapi/... -run 'TestGetTicket' -v
=== RUN   TestGetTicket_ResponseMatchesContract
--- PASS: TestGetTicket_ResponseMatchesContract (0.04s)
=== RUN   TestGetTicket_ReturnsOwnersTicket
--- PASS: TestGetTicket_ReturnsOwnersTicket (0.02s)
=== RUN   TestGetTicket_RequiresSession
--- PASS: TestGetTicket_RequiresSession (0.01s)
=== RUN   TestGetTicket_UnknownAndMalformedIdentifiersAreIndistinguishable
--- PASS: TestGetTicket_UnknownAndMalformedIdentifiersAreIndistinguishable (0.02s)
=== RUN   TestGetTicket_ScopedToOwner
    ticket_test.go:562: getTicketForOwner(bogusOwnerID, a6bed707-309c-41b4-b95c-458dbe29aa63) found a ticket belonging to a different owner -- owner scoping is not enforced
--- FAIL: TestGetTicket_ScopedToOwner (0.01s)
=== RUN   TestGetTicket_MethodNotAllowed
--- PASS: TestGetTicket_MethodNotAllowed (0.01s)
FAIL
```

Exactly the scoping test failed; every other `GetTicket` test —
including the 404-parity test, which does not depend on scoping —
stayed green, isolating the break precisely.

**2. 404-parity broken** (a malformed identifier changed from folding
into `writeTicketNotFound` to returning its own distinct
`400 invalid_request`):

```
$ go test ./internal/httpapi/... -run 'TestGetTicket' -v
=== RUN   TestGetTicket_ResponseMatchesContract
--- PASS: TestGetTicket_ResponseMatchesContract (0.03s)
=== RUN   TestGetTicket_ReturnsOwnersTicket
--- PASS: TestGetTicket_ReturnsOwnersTicket (0.02s)
=== RUN   TestGetTicket_RequiresSession
--- PASS: TestGetTicket_RequiresSession (0.01s)
=== RUN   TestGetTicket_UnknownAndMalformedIdentifiersAreIndistinguishable
    ticket_test.go:531: malformed identifier: status = 400, want 404; body={"error":{"code":"invalid_request","message":"malformed ticket identifier"}}
--- FAIL: TestGetTicket_UnknownAndMalformedIdentifiersAreIndistinguishable (0.01s)
=== RUN   TestGetTicket_ScopedToOwner
--- PASS: TestGetTicket_ScopedToOwner (0.01s)
=== RUN   TestGetTicket_MethodNotAllowed
--- PASS: TestGetTicket_MethodNotAllowed (0.01s)
FAIL
```

Exactly the 404-parity test failed this time; the scoping test (an
entirely different code path) stayed green. Both breaks were reverted
(`diff internal/httpapi/ticket.go <saved pre-break copy>` showed no
difference) and the full `go test ./internal/httpapi/...` suite
returned to green (see "Observed results" above, which is the
confirming run after both reverts).

**3. The SPA fallback disabled** (`vite.config.ts`'s returned config
gained `appType: "mpa"`, which turns off Vite's HTML-fallback
middleware for both the dev server and `vite preview`):

Direct verification first:

```
$ npm run build && node_modules/.bin/vite preview --host 127.0.0.1 --port 4322 --strictPort &
$ curl -s -o /dev/null -w "GET /tickets/abc-123 -> %{http_code}\n" http://127.0.0.1:4322/tickets/abc-123
GET /tickets/abc-123 -> 404
```

Then the full browser suite, with the same break still in place:

```
$ cd e2e && ./run.sh
...
[run.sh] running tests/ticket-detail.spec.ts against the restarted galley
  ✘  1 [chromium] › tests/ticket-detail.spec.ts:14:3 › ... reload renders the same content
  ✘  2 [chromium] › tests/ticket-detail.spec.ts:37:3 › ... loading a Ticket's URL directly renders its full page
  ✘  3 [chromium] › tests/ticket-detail.spec.ts:47:3 › ... an unknown Ticket identifier renders a clear not-found page
  ✘  4 [chromium] › tests/ticket-detail.spec.ts:57:3 › ... the Backlog list still renders correctly after visiting a Ticket's page

  4 failed
    Error: expect(locator).toHaveText(expected) failed
    Locator: getByTestId('ticket-detail-title')
    ... waiting for getByTestId('ticket-detail-title')
    Error: element(s) not found

[run.sh] stopping galley to exercise the failure-mode spec (pid 73918)
[run.sh] running tests/backend-failure.spec.ts against a stopped galley
  ✓  1 [chromium] › tests/backend-failure.spec.ts:28:1 › the app shows its error state when Galley is stopped, instead of a blank or fabricated page (90ms)
[run.sh] status.spec.ts exit code: 0
[run.sh] auth.spec.ts exit code: 0
[run.sh] session-restart-before.spec.ts exit code: 0
[run.sh] ticket-persistence-before.spec.ts exit code: 0
[run.sh] session-restart-after.spec.ts exit code: 0
[run.sh] ticket-persistence-after.spec.ts exit code: 0
[run.sh] ticket-detail.spec.ts exit code: 1
[run.sh] backend-failure.spec.ts exit code: 0
[run.sh] SUITE FAILED
```

All 4 `ticket-detail.spec.ts` specs failed — every one of them navigates
directly to `/tickets/:id` at some point — while every other spec,
including the unrelated `ticket-persistence-*`/`session-restart-*`
pairs sharing the same restart phase, stayed green. `lsof -i -P`
showed no orphaned process after this failed run either. The break was
reverted (`diff vite.config.ts <saved pre-break copy>` showed no
difference) and the confirming green run is the "Browser suite" section
above.

## Implementation limitations and follow-ups

- **`GetTicket`'s Owner-scoping and 404-parity tests exercise the
  singleton Owner's own scoping query with a synthetic bogus owner id,
  the same limitation `#56`'s evidence record already accepted for
  `ListTickets`** (see "Owner-scoping proof, singleton limitation"
  above) — not a gap introduced by this slice, but inherited and
  applied consistently to the new endpoint. A true second-Owner
  end-to-end proof needs multi-Owner support, which is not part of M2's
  scope.
- No other required behavior in issue #57 was left unimplemented; every
  acceptance criterion is satisfied and verified above:
  - Every Ticket has its own URL rendering the full page on direct load
    and reload (verified directly and by the browser suite).
  - Detail data comes from Galley, Owner-scoped, with unknown and
    malformed identifiers returning the shared `404` (Go-level tests,
    byte-for-byte comparison).
  - Not-found is handled visibly in the UI
    (`ticket-detail-not-found`, browser spec).
  - The Ticket URL identifier choice is recorded (this document,
    "Decision 1").
  - Detail content (`TicketDetail`) is reusable by M3's modal without
    duplicating it (this document, "Reuse for M3's modal").

## Outstanding checks and owning milestone

- **CI automation** of the commands recorded here — no owning issue
  yet, unchanged from every prior M2 slice's own recorded limitation.
- **Board, modal, Badges, archive** — all explicitly **M3**, per the
  issue's own scope statement; no code here anticipates their shape.
  `TicketDetail`'s reusability is prepared for, not built ahead of.
- **Editing, Templates, Status transitions, status controls** — `#58`,
  `#59`, `#60`, `#61` respectively; this slice added no placeholder for
  any of them, and the detail page is read-only.
- **Real-provider (github.com) OAuth verification** — unrelated to this
  slice's own changes, still **M10** per `#54`'s original record.

## Decision impacts (open-decision IDs)

None of D1, D2, D4–D9 are resolved or touched by this slice. D3 is
unrelated — this slice has no Agent, Round, or execution concept, per
M2's scope rule. This record's decision-relevant content is entirely
the two engineering choices this slice made and records: replacing
`Ticket.id` with an opaque, non-sequential public UUID everywhere
(rather than adding a second field alongside the sequential one), and a
hand-rolled two-route reader of `window.location.pathname` (rather than
a routing library) for Swiftlet's first client-side navigation. Neither
is an open product decision requiring D-series resolution. This slice
provisions no paid resource and creates no provider account, per
`AGENTS.md`'s "Paid resources" rule.
