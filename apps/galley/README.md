# galley

Galley is ticketIt's Go backend. Per [ADR 0001](../../docs/adr/0001-single-authority-galley.md)
it is the sole authority over authoritative records; Swiftlet (the
React frontend) only submits owner commands and renders what Galley
returns.

This slice ([issue #49](https://github.com/cristoforows/ticketIt/issues/49))
adds an independently buildable, runnable Go module that serves one
unauthenticated application-status endpoint. There is no database, no
authentication, and no Ticket model yet — persistence arrives in
[#52](https://github.com/cristoforows/ticketIt/issues/52).

[Issue #51](https://github.com/cristoforows/ticketIt/issues/51) then
bound that endpoint to [`contracts/openapi.yaml`](../../contracts/openapi.yaml),
ticketIt's single source of truth for Galley's HTTP API — see
[`contracts/README.md`](../../contracts/README.md) for the contract-
first convention every later slice follows, the regeneration commands,
and the drift check. `GET /api/status`'s observable behavior is
unchanged by that refactor.

Galley is a standalone Go module (`go.mod` at this directory) with no
dependency on Node or any frontend toolchain. It does have third-party
Go dependencies as of issue #51 — the generated server types/interface
(`internal/httpapi/api.gen.go`) pull in no runtime dependency of their
own (see below), but the code-generation tool itself
(`oapi-codegen`, pinned via `go.mod`'s `tool` directive) and the
contract-drift test (`kin-openapi`, an ordinary `require`) mean
`go.sum` now exists. Neither is a Node/frontend dependency; "no Node
required to build Galley" still holds.

## Requirements

- Go `1.27.1` (see "Exact versions" below). No other toolchain is
  required.

## Build, test, run

All commands run from this directory (`apps/galley`).

```sh
go build ./...
go test ./...
go run ./cmd/galley
```

`go vet ./...` and `gofmt -l .` (expect no output) are also part of
this slice's definition of done.

### Running

```sh
go run ./cmd/galley
```

By default this listens on `:8080` (all interfaces, port 8080) and
serves:

```sh
curl http://localhost:8080/api/status
```

Port 8080 is the default specifically so Swiftlet's dev proxy
([issue #50](https://github.com/cristoforows/ticketIt/issues/50)),
which targets `http://localhost:8080` by default, works out of the box
against a locally running Galley.

Stop the process with `Ctrl-C` (`SIGINT`) or `SIGTERM`; Galley drains
in-flight requests and releases the listening socket before exiting
(see "Graceful shutdown" below).

## Configuration

Galley reads configuration from the environment at startup. Every
setting has an explicit default; a value that is present but cannot be
parsed or is not one of the accepted values fails startup immediately
with an actionable error on stderr and a non-zero exit code, rather
than starting in an unknown state.

| Variable             | Default       | Notes                                                                                   |
| -------------------- | ------------- | ---------------------------------------------------------------------------------------- |
| `GALLEY_HOST`         | `` (empty)    | Interface to listen on. Empty binds all interfaces.                                      |
| `GALLEY_PORT`         | `8080`        | Integer `0`–`65535`. `0` asks the OS for an ephemeral port (used by this module's own tests). |
| `GALLEY_ENVIRONMENT`  | `development` | Must be exactly `development` or `production`.                                           |
| `GALLEY_VERSION`      | `dev`         | Arbitrary version string reported by `GET /api/status`.                                  |

Example of a configuration failure:

```sh
$ GALLEY_ENVIRONMENT=staging go run ./cmd/galley
configuration error: invalid GALLEY_ENVIRONMENT "staging": must be "development" or "production"
$ echo $?
1
```

## `GET /api/status`

Described in [`contracts/openapi.yaml`](../../contracts/openapi.yaml)
and bound to it via the generated `ServerInterface`
(`internal/httpapi/api.gen.go`, see "Generated types and the drift
check" below). Returns `200` with exactly these five fields,
unauthenticated and free of secrets:

```json
{
  "application": "galley",
  "status": "ok",
  "version": "dev",
  "environment": "development",
  "startedAt": "2026-09-21T10:00:00Z"
}
```

- `application` and `status` are constant (`"galley"`, `"ok"`).
- `version` and `environment` come from configuration.
- `startedAt` is the RFC3339 UTC process start time, captured once when
  the process boots and returned unchanged on every request.

**This shape is fixed.** Swiftlet's client (issue #50, open PR #63)
validates all five fields as non-empty strings and treats a missing one
as an error. Later slices (e.g. #52's database health) may extend this
object **additively** with new fields; existing fields must never be
renamed or removed.

## Error shape

`ErrorBody`/`ErrorDetail` are generated from
[`contracts/openapi.yaml`](../../contracts/openapi.yaml) (see below).
Every error response — currently unknown routes and method mismatches —
uses this shared JSON shape:

```json
{
  "error": {
    "code": "not_found",
    "message": "no route for GET /nope"
  }
}
```

`code` is a short, stable, snake_case machine-readable identifier;
`message` is a human-readable, non-secret explanation. This slice
defines two codes:

| Situation                                   | Status | `code`               |
| -------------------------------------------- | ------ | --------------------- |
| No route matches the request path            | `404`  | `not_found`            |
| Route exists, method not allowed on it       | `405`  | `method_not_allowed`   |

A `405` response also carries an `Allow` header naming the accepted
method(s).

**Every later slice that adds a Galley endpoint should reuse this exact
shape** (`internal/httpapi.ErrorBody` / `ErrorDetail`) for its own error
responses, rather than defining a new one.

## Router choice

Routing uses only the standard library's `net/http.ServeMux`, using the
method- and pattern-aware routing added in Go 1.22 (e.g.
`mux.HandleFunc("GET /api/status", ...)`). No third-party router
(`chi`, `gorilla/mux`, `httprouter`, ...) is used.

**Why:** this slice has a handful of fixed routes with per-method
dispatch — exactly what the enhanced `ServeMux` was built for. Pulling
in a third-party router would add a dependency (and a `go.sum`) for
capability the standard library already provides. `ServeMux`'s
documented pattern-specificity rules are used deliberately for
method-mismatch handling: a method-qualified pattern (`"GET
/api/status"`) is strictly more specific than the same path without a
method (`"/api/status"`) and always wins when both could match, so
registering both together yields a 200 for `GET` and routes every other
method to a handler that returns the shared `405` error shape. A
pattern ending in `/` (just `"/"`) is a subtree match that catches every
path neither of the above claims, which becomes the shared `404`
handler. See `internal/httpapi/handler.go` for the implementation and
`internal/httpapi/handler_test.go` for tests confirming this precedence
empirically (not just by reading the documentation). If Galley's routing
needs ever outgrow this (e.g. complex path parameters, per-route
middleware chains), revisit this choice explicitly and record the
change here.

## Generated types and the drift check

`internal/httpapi/api.gen.go` is generated from
[`contracts/openapi.yaml`](../../contracts/openapi.yaml) by
[oapi-codegen](https://github.com/oapi-codegen/oapi-codegen) v2.8.0
(pinned in `go.mod`'s `tool` directive), configured by
[`contracts/galley/oapi-codegen.config.yaml`](../../contracts/galley/oapi-codegen.config.yaml)
to emit both the schema types (`StatusResponse`, `ErrorBody`,
`ErrorDetail`) and a `ServerInterface` for Go 1.22+'s `net/http`
routing style — the same style this package already uses (see "Router
choice" above), so adopting it required no router migration.
**Do not hand-edit `api.gen.go`** — see
[`contracts/README.md`](../../contracts/README.md) for the full
"contract first, then implement" convention.

Regenerate after editing the contract:

```sh
cd apps/galley
go generate ./...
```

Two independent checks guard against the contract and the
implementation disagreeing (see `contracts/README.md`, "The drift
check", for the full explanation and for both checks caught failing on
a deliberate mismatch):

```sh
# 1. The real handler's response validates against the contract's schema.
go test ./internal/httpapi/... -run Contract -v

# 2. Regenerating the contract produces no diff against the committed file.
./scripts/check-contract-drift.sh
```

Two overrides exist solely to keep `GET /api/status`'s response bytes
unchanged by the move to generated types: `startedAt` carries
`x-go-type: string` in the contract (keeping it a plain Go `string`
rather than oapi-codegen's default `time.Time`, whose marshaling could
add fractional seconds Galley never produced), and
`internal/httpapi/status.go` defines `StatusResponse.MarshalJSON` to
hold the field order (oapi-codegen emits struct fields alphabetically by
property name, which `encoding/json` then serializes in that order).
Both are commented at the point of use.

## CORS

No CORS headers are added. The browser reaches Galley only through
Swiftlet's dev proxy (issue #50): the proxy forwards `/api/*`
server-side from Swiftlet's own dev server, so the browser only ever
talks to Swiftlet's origin and CORS is never invoked. This is a narrow,
recorded decision, not an oversight — if a future client ever needs
genuine cross-origin browser access to Galley, that requires its own
explicit, narrowly-scoped CORS decision, not a permissive default added
here.

## Structured logging and graceful shutdown

Every request is logged as one structured JSON line (via `log/slog`) to
stdout with `method`, `path`, `status`, `duration_ms`, and
`remote_addr`.

On `SIGINT` or `SIGTERM`, Galley stops accepting new connections, lets
in-flight requests finish (`http.Server.Shutdown`, bounded by a 10s
timeout), and only then exits — releasing the listening socket. This is
verified by an automated test
(`cmd/galley/main_test.go:TestRun_ServesStatusThenShutsDownCleanly`)
that boots the real server on an OS-assigned port, serves a real
request over it, triggers shutdown, and then proves the socket was
released by successfully re-binding the exact same address — and
manually with a real process and `kill -TERM`/`kill -INT` (see
`docs/evidence/m2/49-galley-boot.md`).

## Layout

```text
apps/galley/
├── go.mod
├── go.sum
├── README.md               # this file
├── scripts/
│   └── check-contract-drift.sh  # drift check part 2: regeneration produces no diff
├── cmd/galley/             # main package: wiring, config load, graceful shutdown
└── internal/
    ├── config/             # environment parsing and validation
    └── httpapi/            # routing, status handler, shared error shape, request logging
        ├── api.gen.go      # generated from contracts/openapi.yaml — DO NOT EDIT
        ├── generate.go     # the //go:generate directive that produces api.gen.go
        └── contract_test.go  # drift check part 1: response validates against the contract
```

## Exact versions and toolchain

- Go: `1.27.1` (darwin/arm64), pinned in `go.mod`'s `go` directive.
- `github.com/getkin/kin-openapi` `v0.149.0` — an ordinary `require`,
  used only by `internal/httpapi/contract_test.go` (the drift check;
  see "Generated types and the drift check" above).
- `github.com/oapi-codegen/oapi-codegen/v2` `v2.8.0` — a `tool`
  dependency (Go 1.24+'s `go.mod` `tool` directive), used only by
  `go generate`. Its own dependency graph (several `github.com/`,
  `golang.org/x/`, and YAML/JSON-Schema packages) is why `go.sum`
  exists now; none of it is linked into the built `galley` binary.
- The generated `api.gen.go` itself imports only the standard library
  (`fmt`, `net/http`) — generating it added no runtime dependency to
  the actual served application, only to the tool that produces it and
  to the test that checks it.

See `docs/evidence/m2/49-galley-boot.md` for the full reproducible
verification record (commands and their actual output).
