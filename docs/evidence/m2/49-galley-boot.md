# Galley boots and serves application status

## Purpose

Establish that `apps/galley` — the ticketIt Go backend — is an
independently buildable, runnable Go module that reads its
configuration from the environment (with actionable failure on invalid
input), serves `GET /api/status` with the exact fixed JSON shape,
returns the shared JSON error shape for unknown routes and method
mismatches, and shuts down gracefully on `SIGINT`/`SIGTERM`, releasing
its listening socket. Tracking issue:
[#49 — M2.1 — Galley boots and serves application status](https://github.com/cristoforows/ticketIt/issues/49),
under [M2 (#3)](https://github.com/cristoforows/ticketIt/issues/3).

## What already existed

No application code. The repository held documentation, the M1
`experiments/` workspace, and `CONTEXT.md`. There was no `apps/`
directory, no database, and no HTTP service.

Issue #50 (Swiftlet boots and displays Galley-provided status) was
implemented in parallel in open PR #63, targeting this exact `GET
/api/status` shape without a running Galley to verify against (Go was
not installed on that run). This slice does not touch `apps/swiftlet`;
it implements the Galley side of that same fixed contract and verifies
it with a real running server, closing that gap for later
verification.

## What this slice added

- `apps/galley`: a standalone Go module (its own `go.mod`, no
  dependency on any other module in this repository, no third-party
  dependencies, no `go.sum`).
- `apps/galley/internal/config`: `Load(getenv)` reads `GALLEY_HOST`,
  `GALLEY_PORT`, `GALLEY_ENVIRONMENT`, `GALLEY_VERSION` with explicit
  defaults (`""`, `8080`, `development`, `dev`), validates port range
  (`0`–`65535`) and environment (`development`/`production`), and
  returns a descriptive `error` naming the offending variable and
  accepted values on invalid input — never a silent fallback.
- `apps/galley/internal/httpapi`:
  - `NewHandler(cfg, startedAt, logger)` builds the full HTTP handler:
    routing, the status payload, the shared error shape, and request
    logging.
  - `GET /api/status` returns the fixed five-field JSON payload
    (`application`, `status`, `version`, `environment`, `startedAt`),
    with `startedAt` captured once at process start and formatted
    RFC3339 UTC.
  - The shared JSON error shape, `{"error":{"code":"...","message":"..."}}`
    (`ErrorBody`/`ErrorDetail`), used for `404` (`not_found`, unknown
    route) and `405` (`method_not_allowed`, wrong method on
    `/api/status`, with an `Allow` header naming the accepted method).
  - Structured per-request access logging via `log/slog`
    (`method`, `path`, `status`, `duration_ms`, `remote_addr`) to
    stdout.
- `apps/galley/cmd/galley/main.go`: process wiring — loads config,
  binds a listener, serves, and on `SIGINT`/`SIGTERM` (via
  `signal.NotifyContext`) calls `http.Server.Shutdown` with a 10s
  timeout before exiting. The core logic lives in an unexported `run`
  function taking an injectable `getenv`, an `io.Writer` for logs, and
  an optional "ready" channel that reports the bound address — this is
  what lets the test suite exercise the real listen/serve/shutdown
  lifecycle (including on an OS-assigned port) without touching the
  real process environment or real OS signals.
- Tests covering: default and explicit configuration (both valid and
  invalid), the status payload under both `development` and
  `production` settings, the error shape for an unknown route and for
  a method mismatch, and an end-to-end test that boots the real server,
  serves a real HTTP request over a real socket, triggers shutdown by
  canceling context (the same path a real signal takes), and then
  proves the socket was released by re-binding the exact same address.
- `apps/galley/README.md`: build/test/run commands, the configuration
  table, the fixed status shape, the shared error shape (for later
  slices to reuse), the router choice and rationale, the CORS decision,
  and logging/shutdown behavior.
- `docs/evidence/m2/TEMPLATE.md` and `docs/evidence/m2/README.md`
  (this evidence file's own template and the M2 evidence-index stub).

### Router/HTTP library choice and rationale

**Standard library `net/http.ServeMux` only** — no third-party router.

Go 1.22 added method- and pattern-aware routing to `ServeMux`
(`mux.HandleFunc("GET /api/status", ...)`), which is exactly what this
slice's handful of fixed routes with per-method dispatch needs. Using
it avoids adding any dependency (and a `go.sum`) for capability the
standard library already provides, in the spirit of the issue's
"prefer the standard library and minimal dependencies."

The method-mismatch (`405`) behavior relies on a documented but
easy-to-get-wrong `ServeMux` precedence rule: a method-qualified
pattern (`"GET /api/status"`) is strictly more specific than the same
exact path registered without a method (`"/api/status"`), and the more
specific pattern always wins when a request could match both. So
registering both together gives `GET /api/status` the status handler
and every other method on that same path the `405` handler, without
needing to inspect `r.Method` manually inside the mux itself. A pattern
of exactly `"/"` is a subtree match that catches every path neither of
the above claims, which becomes the `404` handler. This was **not**
assumed from documentation alone — `internal/httpapi/handler_test.go`
sends `POST`/`DELETE`/`PUT` to `/api/status` and an unrelated path to
confirm this precedence empirically (see "Observed results" below).

## Exact versions and toolchain

- Go: `go1.27.1 darwin/arm64` (`go version` output below), pinned via
  `go.mod`'s `go 1.27.1` directive. This is the exact toolchain
  installed on this machine for this work.
- No third-party Go dependencies; `go.mod` has no `require` block and
  there is no `go.sum`.
- No Node/npm toolchain is involved anywhere in `apps/galley`.

## Reproducible commands

All commands below run from `apps/galley/` on a clean checkout:

```sh
cd apps/galley
go version
gofmt -l .          # expect no output
go vet ./...
go build ./...
go test ./... -v
```

To run the server and verify it manually:

```sh
cd apps/galley
go run ./cmd/galley
# in another shell:
curl -i http://localhost:8080/api/status
curl -i http://localhost:8080/unknown
curl -i -X POST http://localhost:8080/api/status
# then Ctrl-C (SIGINT) the server process
```

## Observed results

```
$ go version
go version go1.27.1 darwin/arm64

$ gofmt -l .
(no output — clean)

$ go vet ./...
(no output — clean)

$ go build ./...
(no output — success)

$ go test ./... -v
=== RUN   TestRun_ConfigurationFailure
--- PASS: TestRun_ConfigurationFailure (0.00s)
=== RUN   TestRun_ServesStatusThenShutsDownCleanly
--- PASS: TestRun_ServesStatusThenShutsDownCleanly (0.00s)
PASS
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/galley	0.241s
=== RUN   TestLoad_Defaults
--- PASS: TestLoad_Defaults (0.00s)
=== RUN   TestLoad_ExplicitProductionSettings
--- PASS: TestLoad_ExplicitProductionSettings (0.00s)
=== RUN   TestLoad_InvalidPort
=== RUN   TestLoad_InvalidPort/not-a-number
=== RUN   TestLoad_InvalidPort/-1
=== RUN   TestLoad_InvalidPort/65536
=== RUN   TestLoad_InvalidPort/8080.5
=== RUN   TestLoad_InvalidPort/_
--- PASS: TestLoad_InvalidPort (0.00s)
    --- PASS: TestLoad_InvalidPort/not-a-number (0.00s)
    --- PASS: TestLoad_InvalidPort/-1 (0.00s)
    --- PASS: TestLoad_InvalidPort/65536 (0.00s)
    --- PASS: TestLoad_InvalidPort/8080.5 (0.00s)
    --- PASS: TestLoad_InvalidPort/_ (0.00s)
=== RUN   TestLoad_PortZeroIsValid
--- PASS: TestLoad_PortZeroIsValid (0.00s)
=== RUN   TestLoad_InvalidEnvironment
=== RUN   TestLoad_InvalidEnvironment/prod
=== RUN   TestLoad_InvalidEnvironment/Development
=== RUN   TestLoad_InvalidEnvironment/staging
=== RUN   TestLoad_InvalidEnvironment/PRODUCTION
--- PASS: TestLoad_InvalidEnvironment (0.00s)
    --- PASS: TestLoad_InvalidEnvironment/prod (0.00s)
    --- PASS: TestLoad_InvalidEnvironment/Development (0.00s)
    --- PASS: TestLoad_InvalidEnvironment/staging (0.00s)
    --- PASS: TestLoad_InvalidEnvironment/PRODUCTION (0.00s)
PASS
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/config	0.336s
=== RUN   TestStatusHandler_Development
--- PASS: TestStatusHandler_Development (0.00s)
=== RUN   TestStatusHandler_Production
--- PASS: TestStatusHandler_Production (0.00s)
=== RUN   TestUnknownRoute_ReturnsSharedErrorShape
--- PASS: TestUnknownRoute_ReturnsSharedErrorShape (0.00s)
=== RUN   TestMethodNotAllowed_ReturnsSharedErrorShape
=== RUN   TestMethodNotAllowed_ReturnsSharedErrorShape/POST
=== RUN   TestMethodNotAllowed_ReturnsSharedErrorShape/DELETE
=== RUN   TestMethodNotAllowed_ReturnsSharedErrorShape/PUT
--- PASS: TestMethodNotAllowed_ReturnsSharedErrorShape (0.00s)
    --- PASS: TestMethodNotAllowed_ReturnsSharedErrorShape/POST (0.00s)
    --- PASS: TestMethodNotAllowed_ReturnsSharedErrorShape/DELETE (0.00s)
    --- PASS: TestMethodNotAllowed_ReturnsSharedErrorShape/PUT (0.00s)
PASS
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	0.456s
```

Manual verification of the running server, `development` settings
(defaults, `go run ./cmd/galley`, no env vars set):

```
$ curl -i http://localhost:8080/api/status
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Content-Length: 117

{"application":"galley","status":"ok","version":"dev","environment":"development","startedAt":"2026-09-21T06:34:24Z"}

$ curl -i http://localhost:8080/unknown
HTTP/1.1 404 Not Found
Content-Type: application/json; charset=utf-8
Content-Length: 68

{"error":{"code":"not_found","message":"no route for GET /unknown"}}

$ curl -i -X POST http://localhost:8080/api/status
HTTP/1.1 405 Method Not Allowed
Allow: GET
Content-Type: application/json; charset=utf-8
Content-Length: 100

{"error":{"code":"method_not_allowed","message":"method POST not allowed for /api/status; use GET"}}
```

Manual verification under `production` settings
(`GALLEY_ENVIRONMENT=production GALLEY_VERSION=0.1.0`):

```
$ curl -i http://localhost:8080/api/status
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Content-Length: 118

{"application":"galley","status":"ok","version":"0.1.0","environment":"production","startedAt":"2026-09-21T06:34:47Z"}
```

Manual verification of configuration failure:

```
$ GALLEY_PORT=notanumber go run ./cmd/galley
configuration error: invalid GALLEY_PORT "notanumber": must be an integer between 0 and 65535 (0 selects an OS-assigned port, useful for tests)
$ echo $?
1

$ GALLEY_ENVIRONMENT=staging go run ./cmd/galley
configuration error: invalid GALLEY_ENVIRONMENT "staging": must be "development" or "production"
$ echo $?
1
```

Manual verification of graceful shutdown, with a real process and a
real signal (not just the automated test's context-cancellation path):
started the built binary, confirmed it served a request, sent a real
`SIGTERM` to the process, and observed both the structured shutdown log
lines and — the actual proof the socket was released — a second
instance of the same binary successfully re-binding port 8080
immediately afterward and serving a request:

```
$ /tmp/galley-bin &            # first instance
$ curl -i http://localhost:8080/api/status   # 200 OK, as above
$ kill -TERM <pid>
# log:
{"...","msg":"shutdown signal received, draining connections"}
{"...","msg":"galley stopped"}
$ pgrep -fl galley              # no output: process fully exited

$ /tmp/galley-bin &             # second instance, same port, right after
$ curl -o /dev/null -w "rebind curl status: %{http_code}\n" http://localhost:8080/api/status
rebind curl status: 200
```

The same rebind proof is also automated:
`cmd/galley/main_test.go:TestRun_ServesStatusThenShutsDownCleanly`
boots the server on an OS-assigned port (`GALLEY_PORT=0`), issues a
real HTTP request over the real socket, cancels the context (the same
path `signal.NotifyContext` takes for a real `SIGINT`/`SIGTERM`), waits
for `run()` to return with no error, and then calls `net.Listen` on the
exact same address to confirm it is free.

## Implementation limitations and follow-ups

No required behavior in issue #49 was left unimplemented. Everything in
"Acceptance criteria" was implemented and verified above: build/test/run
from `apps/galley`'s own README with no Node toolchain involved; the
exact five-field status payload under both `development` and
`production`; actionable configuration-failure messages; the shared
JSON error shape for unknown routes (and, beyond the letter of the
acceptance criteria but within "Conventions for this slice," for method
mismatches too, since the issue body explicitly asks for both); a
graceful shutdown that measurably releases the socket; and the
router/library choice recorded here and in the README.

One deliberate scope note, not a limitation: this slice does not
attempt to verify interoperation with `apps/swiftlet` (issue #50, open
PR #63) — that pairing is explicitly this slice's scope boundary
("Touch only `apps/galley`..."). Swiftlet's own evidence record
(`docs/evidence/m2/50-swiftlet-boot.md`) already names a live
two-server check as its own outstanding item once Galley exists; this
record does not re-open or duplicate that item, since neither #49 nor
#50 assigns it to this slice — see "Outstanding checks" below for how
this record frames it from Galley's side.

## Outstanding checks and owning milestone

- **Live two-server check (Swiftlet's dev server proxying to a running
  Galley, viewed in a browser).** Not performed here: this slice's
  scope boundary excludes touching or running `apps/swiftlet`, and
  Swiftlet's PR (#63) has not merged. Galley's own `GET /api/status`,
  `404`, and `405` behavior is verified directly above with `curl`
  against a real running process, satisfying this slice's own "Stops
  when" clause. The cross-application check is owned by whichever slice
  first has both halves mergeable — most naturally the gate-report
  slice, **M2** ([#62](https://github.com/cristoforows/ticketIt/issues/62)), per Swiftlet's own evidence record's identical
  note.
- **Persistence and database health.** Explicitly out of scope per this
  issue ("this slice uses no database") — owned by
  [#52](https://github.com/cristoforows/ticketIt/issues/52), which
  extends the status payload additively.
- **Authentication/authorization on any endpoint.** Explicitly out of
  scope for M2.1; `GET /api/status` is intentionally unauthenticated.
  No specific follow-up issue exists yet for when auth is introduced;
  owning milestone is wherever the v1 spec's GitHub OAuth sign-in
  (`docs/deployment.md`, "Ownership and sign-in") is implemented,
  expected in **M2** or later per the implementation plan.
- **Load/concurrency behavior beyond a handful of manual/sequential
  requests.** Not exercised. No specific follow-up issue exists yet;
  reasonable to defer to whichever milestone first introduces
  meaningful concurrent load (persistence in **M2**/#52, or later).

## Decision impacts (open-decision IDs)

None of D1, D2, D4–D9 are resolved or touched by this slice.
[D3](../../decisions/d3-agent-template-compatibility.md) is unrelated —
this slice has no Agent, Round, or execution concept, per M2's own
scope rule ("No AI, Agents, Rounds, or Michelin in M2"). This record's
only decision-relevant content is the router/HTTP-library choice
(standard library `net/http.ServeMux`, no third-party router), which
issue #49 designates as an engineering choice inside the approved
design for this slice to make and record, not an open product decision
requiring D-series resolution.
