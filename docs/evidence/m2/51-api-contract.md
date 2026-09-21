# API contract and generated client convention

## Purpose

Establish `contracts/` as the single source of truth for Galley's HTTP
API, bind both `apps/galley` and `apps/swiftlet` to it through
generated code, and add a drift check that fails when the committed
contract and the implementation disagree. This slice touches
`contracts/`, `apps/galley`, and `apps/swiftlet`; it adds no new
endpoint and no database access. Tracking issue:
[#51 — M2.3 — API contract and generated client convention](https://github.com/cristoforows/ticketIt/issues/51),
under [M2 (#3)](https://github.com/cristoforows/ticketIt/issues/3).
Blocked by [#49](https://github.com/cristoforows/ticketIt/issues/49)
and [#50](https://github.com/cristoforows/ticketIt/issues/50), both
merged before this slice began.

## What already existed

- `apps/galley` (issue #49, merged): a standalone Go module serving
  `GET /api/status` with a hand-written `StatusResponse` struct, a
  hand-written `ErrorBody`/`ErrorDetail` shared error shape, and
  `net/http.ServeMux`-based routing with no third-party dependencies
  and no `go.sum`.
- `apps/swiftlet` (issue #50, merged): a Vite + React + TypeScript app
  with a hand-written `GalleyStatus` interface in `src/api/status.ts`,
  fetching `/api/status` and validating the response shape at runtime
  (throwing a specific error per missing/invalid field).
- No `contracts/` directory. No API description existed anywhere;
  each side's shape was hand-maintained prose plus hand-written types,
  kept in sync only by convention and by each side's own tests.
- No CI configuration exists anywhere in the repository (no
  `.github/workflows`); build/test verification is manual, per
  application README, for every M2 slice so far.

## What this slice added

### `contracts/`

- `contracts/openapi.yaml` — OpenAPI **3.1.0**, describing `GET
  /api/status` (`operationId: getStatus`) and the shared error shape
  completely: `StatusResponse` (five required fields,
  `additionalProperties: false`, `const`/`enum` on the three fixed-
  value fields) and `ErrorBody`/`ErrorDetail`, referenced from the
  operation's `default` response (OpenAPI's mechanism for "every
  status this operation doesn't otherwise document").
- `contracts/README.md` — the contract-first convention ("edit the
  contract, regenerate, then implement"), the format/generator
  choices and rationale, the committed-artifacts decision, the
  regeneration commands, and the two-part drift check. Linked from
  both application READMEs, per the issue's placement requirement.
- `contracts/galley/oapi-codegen.config.yaml` — pinned generator
  config for Galley's side.
- `contracts/package.json` / `package-lock.json` — a **separate**,
  codegen-only Node toolchain for Swiftlet's generator (see "Format
  and generator choices" below for why it isn't inside
  `apps/swiftlet`).
- `contracts/check-swiftlet-drift.sh` — drift check part 2 for the
  TypeScript side (regeneration produces no diff).

### `apps/galley`

- `internal/httpapi/api.gen.go` (generated, committed) — via
  [oapi-codegen](https://github.com/oapi-codegen/oapi-codegen) v2.8.0,
  `generate.models` + `generate.std-http-server`: the `StatusResponse`
  / `ErrorBody` / `ErrorDetail` types and a `ServerInterface` +
  `HandlerFromMux` for Go 1.22+ `net/http` routing — the same routing
  style Galley already used, so no router migration was needed.
- `internal/httpapi/generate.go` — the `//go:generate` directive.
- `internal/httpapi/status.go` — rewritten: `newServer`/`server.GetStatus`
  implement `ServerInterface` against the generated types, plus a
  `MarshalJSON` override holding the JSON field order issue #49
  established (see below).
- `internal/httpapi/errors.go` — trimmed to the `newErrorBody`/
  `fallbackErrorJSON` helpers only; the `ErrorBody`/`ErrorDetail`
  types themselves are now generated.
- `internal/httpapi/handler.go` — `NewHandler` now wires
  `HandlerFromMux(newServer(...), mux)` onto the same `*http.ServeMux`
  used for the shared 404/405 handlers, preserving the exact route-
  precedence behavior and structured-logging wrapper from issue #49
  unchanged.
- `internal/httpapi/contract_test.go` (new) — the drift check's first
  half: `TestGetStatus_ResponseMatchesContract` and
  `TestErrorResponses_MatchContract` (see "The drift check" below).
- `scripts/check-contract-drift.sh` (new) — the drift check's second
  half.
- `go.mod`/`go.sum` — `oapi-codegen` pinned as a Go 1.24+ `tool`
  dependency (used only by `go generate`, never linked into the built
  binary); `github.com/getkin/kin-openapi` v0.149.0 as an ordinary
  `require`, used only by `contract_test.go`. This is the first
  third-party Go dependency in `apps/galley`; the generated
  `api.gen.go` itself imports only `fmt`/`net/http` (no
  `github.com/oapi-codegen/runtime`, since this endpoint has no
  parameters to bind), so the **served** application still ships zero
  third-party runtime code.
- `README.md` — updated "GET /api/status", "Error shape" sections; new
  "Generated types and the drift check" section; updated "Layout" and
  "Exact versions and toolchain".

### `apps/swiftlet`

- `src/api/generated/schema.d.ts` (generated, committed) — via
  [openapi-typescript](https://github.com/openapi-ts/openapi-typescript)
  v7.13.0: `paths`, `operations`, and `components["schemas"]` typed
  exactly from the contract, in the contract's declared field order
  (openapi-typescript does not alphabetize, unlike oapi-codegen).
- `src/api/status.ts` — `GalleyStatus` is now `components["schemas"]["StatusResponse"]`
  from the generated schema, replacing the hand-written interface.
  **The runtime logic is otherwise untouched**: the same `fetch`
  call, the same `REQUIRED_FIELDS` presence check, the same error
  messages for network failure / non-2xx / shape mismatch. This was a
  deliberate choice — see "Format and generator choices" below.
- `README.md` — new "Regenerating types from the contract" section;
  updated intro and "What this app renders, and where from" to
  reference the generated schema and `contracts/README.md`.

No change to `App.tsx`, `main.tsx`, `StatusView.tsx`, or either app's
tests: `StatusView.test.tsx` and `App.test.tsx` pass unmodified (see
"Observed results"), which is itself evidence that this slice changed
no observable behavior.

## Format and generator choices, and why

**OpenAPI 3.1.0** — the version the issue recommends. Both generators
load it without incident, with one contract-side accommodation (see
"One hand-written seam" below).

**Galley: oapi-codegen v2.8.0**, generating both models and a Go
1.22+ `net/http` server interface (`std-http-server`), pinned via
`go.mod`'s `tool` directive (Go 1.24+'s built-in mechanism for a
versioned dev tool, preferred here over a `tools.go` blank-import file
or an unpinned `go run pkg@latest`). Chosen over `openapi-generator`/
`swagger-codegen` (both need a JVM Galley's toolchain doesn't
otherwise require) and over hand-maintained types (loses the compile-
time link between contract and implementation — the `ServerInterface`
means an operation added to the contract will not compile until
Galley implements it, which is the strongest form of "the handler is
bound to the schema" available).

**Swiftlet: openapi-typescript v7.13.0, types only — not a generated
client.** [openapi-fetch](https://github.com/openapi-ts/openapi-fetch)
(the natural generated-client pairing) was evaluated and rejected:
it reads `response.headers` before parsing a body (confirmed by
reading its source,
`node_modules/openapi-fetch/dist/index.mjs`), but
`StatusView.test.tsx`'s and `App.test.tsx`'s existing
`vi.stubGlobal("fetch", ...)` doubles return a plain `{ok, status,
statusText, json}` object, not a real `Response` — adopting
`openapi-fetch` would mean rewriting five passing tests to construct
real `Response` objects, for no behavioral gain over generated types,
and would risk exactly the kind of incidental behavior change issue
#51 explicitly rules out ("Keep GET /api/status's observable behavior
byte-for-byte identical"). Issue #51 accepts either "generated types
**or** a generated client"; generated types was the lower-risk choice
that satisfies the criterion without touching passing tests. This
trade-off, including the concrete `response.headers` incompatibility,
is recorded here and in `contracts/README.md`.

### Why a separate `contracts/package.json` for Swiftlet's codegen

`openapi-typescript` v7.13.0 uses the classic TypeScript Compiler API
(`ts.factory.createKeywordTypeNode`, etc.) at runtime. `apps/swiftlet`
is pinned to TypeScript **7.0.2** (issue #50's choice), and
TypeScript 7's package no longer exports the classic Compiler API from
its root entry point — `npm view typescript@7.0.2 exports` shows only
`"."`: `"./lib/version.cjs"` plus a set of `./unstable/ast/*`
subpaths; there is no `ts.factory` there. Running
`openapi-typescript` against that installation crashes:

```
TypeError: Cannot read properties of undefined (reading 'createKeywordTypeNode')
    at .../openapi-typescript/dist/lib/ts.mjs:11:28
```

This is a structural break (TypeScript 7's native-compiler
restructuring), not a version-range mismatch `npm install
--legacy-peer-deps` or an `overrides` entry can paper over — both were
tried and both still resolved to the single incompatible installation
in this project's flat `node_modules` (npm does not create a nested,
independent copy for a **peer** dependency just because `overrides`
names a different version; `--legacy-peer-deds` alone drops the
override rather than the peer conflict). Downgrading `apps/swiftlet`'s
own TypeScript to satisfy a dev tool was rejected as out of this
slice's scope (that pin is issue #50's own recorded choice).

The resolution: `contracts/package.json` is a **separate** npm project
(own `node_modules`, own lockfile) pinning `openapi-typescript@7.13.0`
+ `typescript@5.9.3` (the version the generator actually needs),
entirely decoupled from `apps/swiftlet/node_modules`. Because the
generated output is committed, `apps/swiftlet`'s own `npm ci`, `npm
test`, and `npm run build` never install or invoke anything in
`contracts/` — confirmed below by a clean-room `npm ci` showing the
same package count as issue #50's own baseline evidence (108
packages, unchanged).

### Keeping the response byte-for-byte identical

Binding to generated types needed two accommodations:

1. `StatusResponse.startedAt` carries `x-go-type: string` in the
   contract. Without it, oapi-codegen maps `format: date-time` to Go's
   `time.Time`, whose default JSON marshaling (`RFC3339Nano`) can
   include fractional seconds — different from the plain
   `startedAt.UTC().Format(time.RFC3339)` string Galley has always
   produced.
2. oapi-codegen emits Go struct fields **alphabetically** by JSON
   property name (`Application, Environment, StartedAt, Status,
   Version`), not in the contract's declared order (`application,
   status, version, environment, startedAt`). Since `encoding/json`
   serializes in declaration order, left alone this would have silently
   reordered the response's bytes. A hand-written `MarshalJSON` on the
   generated `StatusResponse` (`apps/galley/internal/httpapi/status.go`)
   restores the original order.

Both are documented at the point of use, so a future contributor
understands them before removing them.

**Considered for (2) and deferred:** oapi-codegen's `x-order` extension
orders generated struct fields from the contract itself, which would
remove the hand-written `MarshalJSON` entirely. Deferred because it ties
the contract to one Go generator — a different generator ignores the
extension silently — and because key order is semantically meaningless
in JSON, so the whole constraint is worth revisiting rather than
re-engineering while this slice is only documenting existing APIs.
Neither approach is covered by a test today: every test decodes the body
before asserting, so nothing fails if the order changes.

## Exact versions and toolchain

- Go: `go1.27.1 darwin/arm64`.
- `github.com/oapi-codegen/oapi-codegen/v2` `v2.8.0` (Go `tool`
  dependency; not linked into the built binary).
- `github.com/getkin/kin-openapi` `v0.149.0` (ordinary `require`, used
  only by `internal/httpapi/contract_test.go`).
- Node: `26.9.0`. npm: `11.19.1`.
- `apps/swiftlet`: unchanged from issue #50 — `typescript` `7.0.2`,
  `vite` `8.3.0`, `vitest` `5.0.1`, no new dependency added (see
  "clean-room `npm ci`" below).
- `contracts/` (codegen-only, never installed by either app's own
  build): `openapi-typescript` `7.13.0`, `typescript` `5.9.3`.

## Reproducible commands

**Galley** (from `apps/galley/`, clean checkout):

```sh
go build ./...
go vet ./...
gofmt -l .          # expect no output
go test ./... -v
```

**Regenerate Galley's contract binding:**

```sh
cd apps/galley
go generate ./...
```

**Swiftlet** (from `apps/swiftlet/`, clean checkout):

```sh
rm -rf node_modules dist
npm ci
npm test
npm run build
```

**Regenerate Swiftlet's types** (from `contracts/`, separate
toolchain):

```sh
cd contracts
npm ci
npm run generate:swiftlet
```

**Drift check** (both halves; see "The drift check" below for what
each catches):

```sh
cd apps/galley && go test ./internal/httpapi/... -run Contract -v
cd apps/galley && ./scripts/check-contract-drift.sh
cd contracts && npm ci && ./check-swiftlet-drift.sh
```

**Live two-server verification** (Galley on `:8080`, Swiftlet's dev
server on `:5173` proxying `/api/*`):

```sh
cd apps/galley && go run ./cmd/galley &
cd apps/swiftlet && npm run dev &
curl -i http://localhost:8080/api/status
curl -i http://localhost:5173/api/status
```

## Observed results

### Galley: build, vet, fmt, test

```
$ go build ./...
(no output — success)

$ go vet ./...
(no output — clean)

$ gofmt -l .
(no output — clean)

$ go test ./... -v
=== RUN   TestRun_ConfigurationFailure
--- PASS: TestRun_ConfigurationFailure (0.00s)
=== RUN   TestRun_ServesStatusThenShutsDownCleanly
--- PASS: TestRun_ServesStatusThenShutsDownCleanly (0.00s)
PASS
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/galley	0.496s
=== RUN   TestLoad_Defaults
--- PASS: TestLoad_Defaults (0.00s)
=== RUN   TestLoad_ExplicitProductionSettings
--- PASS: TestLoad_ExplicitProductionSettings (0.00s)
=== RUN   TestLoad_InvalidPort
    --- PASS: TestLoad_InvalidPort/not-a-number (0.00s)
    --- PASS: TestLoad_InvalidPort/-1 (0.00s)
    --- PASS: TestLoad_InvalidPort/65536 (0.00s)
    --- PASS: TestLoad_InvalidPort/8080.5 (0.00s)
    --- PASS: TestLoad_InvalidPort/_ (0.00s)
--- PASS: TestLoad_InvalidPort (0.00s)
=== RUN   TestLoad_PortZeroIsValid
--- PASS: TestLoad_PortZeroIsValid (0.00s)
=== RUN   TestLoad_InvalidEnvironment
    --- PASS: TestLoad_InvalidEnvironment/prod (0.00s)
    --- PASS: TestLoad_InvalidEnvironment/Development (0.00s)
    --- PASS: TestLoad_InvalidEnvironment/staging (0.00s)
    --- PASS: TestLoad_InvalidEnvironment/PRODUCTION (0.00s)
--- PASS: TestLoad_InvalidEnvironment (0.00s)
PASS
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/config	0.960s
=== RUN   TestGetStatus_ResponseMatchesContract
--- PASS: TestGetStatus_ResponseMatchesContract (0.00s)
=== RUN   TestErrorResponses_MatchContract
    --- PASS: TestErrorResponses_MatchContract/not_found (0.00s)
    --- PASS: TestErrorResponses_MatchContract/method_not_allowed (0.00s)
--- PASS: TestErrorResponses_MatchContract (0.00s)
=== RUN   TestStatusHandler_Development
--- PASS: TestStatusHandler_Development (0.00s)
=== RUN   TestStatusHandler_Production
--- PASS: TestStatusHandler_Production (0.00s)
=== RUN   TestUnknownRoute_ReturnsSharedErrorShape
--- PASS: TestUnknownRoute_ReturnsSharedErrorShape (0.00s)
=== RUN   TestMethodNotAllowed_ReturnsSharedErrorShape
    --- PASS: TestMethodNotAllowed_ReturnsSharedErrorShape/POST (0.00s)
    --- PASS: TestMethodNotAllowed_ReturnsSharedErrorShape/DELETE (0.00s)
    --- PASS: TestMethodNotAllowed_ReturnsSharedErrorShape/PUT (0.00s)
--- PASS: TestMethodNotAllowed_ReturnsSharedErrorShape (0.00s)
PASS
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	1.351s
```

Every test from issue #49's own suite (`TestStatusHandler_Development`,
`TestStatusHandler_Production`, `TestUnknownRoute_ReturnsSharedErrorShape`,
`TestMethodNotAllowed_ReturnsSharedErrorShape`) passes **unmodified**
against the now-generated types — direct evidence the refactor changed
no observable behavior.

### Swiftlet: clean-room install, test, build

```
$ rm -rf node_modules dist && npm ci
added 108 packages, and audited 109 packages in 749ms
found 0 vulnerabilities

$ npm test

> swiftlet@0.1.0 test
> vitest run

 RUN  v5.0.1 /apps/swiftlet
 Test Files  2 passed (2)
      Tests  6 passed (6)
   Duration  402ms

$ npm run build

> swiftlet@0.1.0 build
> tsc -p tsconfig.json --noEmit && vite build

vite v8.3.0 building client environment for production...
✓ 17 modules transformed.
dist/index.html                  0.31 kB │ gzip:  0.23 kB
dist/assets/index-_IoWTHEq.js  221.65 kB │ gzip: 69.26 kB
✓ built in 47ms
```

**108 packages** — identical to issue #50's own baseline evidence
(`docs/evidence/m2/50-swiftlet-boot.md`: "added 108 packages"),
confirming this slice added no dependency to `apps/swiftlet` itself;
the type-only binding and the codegen toolchain add nothing to its
`node_modules`. All 6 tests pass unmodified (the same tests issue #50
wrote: successful response, non-2xx, unreachable backend, malformed
shape, loading state, and the `App` smoke test).

### Live two-server verification

Galley run directly, and through Swiftlet's dev-server proxy, same
process (`startedAt` identical across both, confirming the same
running Galley instance):

```
$ curl -i http://localhost:8080/api/status
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Date: Mon, 21 Sep 2026 07:09:29 GMT
Content-Length: 117

{"application":"galley","status":"ok","version":"dev","environment":"development","startedAt":"2026-09-21T07:09:12Z"}

$ curl -i http://localhost:5173/api/status
HTTP/1.1 200 OK
Vary: Origin
content-type: application/json; charset=utf-8
date: Mon, 21 Sep 2026 07:09:29 GMT
content-length: 117
connection: close

{"application":"galley","status":"ok","version":"dev","environment":"development","startedAt":"2026-09-21T07:09:12Z"}
```

Byte-identical bodies (117 bytes both), matching the exact field order
and shape issue #49 established.

## The drift check

Two independent mechanisms, both demonstrated failing on a deliberate
mismatch below, then passing again once reverted (working tree
confirmed clean via `git status --short` after each revert).

### Check 1: response-vs-schema validation (`contract_test.go`)

**Baseline (passing):**

```
$ go test ./internal/httpapi/... -run TestGetStatus_ResponseMatchesContract -v
=== RUN   TestGetStatus_ResponseMatchesContract
--- PASS: TestGetStatus_ResponseMatchesContract (0.00s)
PASS
```

**Deliberate mismatch:** changed only `contracts/openapi.yaml`'s
`status` property from `const: ok` to `const: okay`, without touching
Galley's implementation (which still returns `"status":"ok"`):

```
$ go test ./internal/httpapi/... -run TestGetStatus_ResponseMatchesContract -v
=== RUN   TestGetStatus_ResponseMatchesContract
    contract_test.go:75: GET /api/status response {"application":"galley","status":"ok","version":"dev","environment":"development","startedAt":"2026-09-21T10:00:00Z"} does not validate against ../../../../contracts/openapi.yaml: response body doesn't match schema #/components/schemas/StatusResponse: validation failed due to: error at "/status": at '/status': value must be 'okay'
        Schema:
          null

        Value:
          null
--- FAIL: TestGetStatus_ResponseMatchesContract (0.00s)
FAIL
FAIL	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	0.216s
FAIL
```

**Reverted** (`const: okay` back to `const: ok`):

```
$ go test ./internal/httpapi/... -run TestGetStatus_ResponseMatchesContract -v
=== RUN   TestGetStatus_ResponseMatchesContract
--- PASS: TestGetStatus_ResponseMatchesContract (0.00s)
PASS
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	0.246s
```

### Check 2: regeneration produces no diff (both sides)

This check catches a different kind of drift than Check 1: adding an
**optional** field to the contract doesn't violate response-schema
validation (a response simply omitting an optional field is still
valid), so Check 1 passes even though the contract and the generated
code have diverged. Check 2 catches exactly this.

**Deliberate mismatch:** added an `uptimeSeconds` property to
`StatusResponse` in `contracts/openapi.yaml`, without regenerating
either side.

Galley side (`apps/galley/scripts/check-contract-drift.sh`):

```
$ ./scripts/check-contract-drift.sh
diff --git a/apps/galley/internal/httpapi/api.gen.go b/apps/galley/internal/httpapi/api.gen.go
index 7f3a205..4c96e90 100644
--- a/apps/galley/internal/httpapi/api.gen.go
+++ b/apps/galley/internal/httpapi/api.gen.go
@@ -81,6 +81,9 @@ type StatusResponse struct {
 	StartedAt string               `json:"startedAt"`
 	Status    StatusResponseStatus `json:"status"`

+	// UptimeSeconds Deliberate drift-check demo field (see docs/evidence/m2/51-api-contract.md); reverted immediately after capture.
+	UptimeSeconds *int `json:"uptimeSeconds,omitempty"`
+
 	// Version Galley's configured version string (GALLEY_VERSION).
 	Version string `json:"version"`
 }

DRIFT DETECTED: regenerating internal/httpapi/api.gen.go from contracts/openapi.yaml produced the diff above.
Either the contract changed without regenerating, or the generated file was hand-edited. Run 'go generate ./...' and commit the result, or investigate the diff.
```
(exit code 1)

Swiftlet side (`contracts/check-swiftlet-drift.sh`):

```
$ ./check-swiftlet-drift.sh
> ticketit-contracts@0.0.0 generate:swiftlet
> openapi-typescript openapi.yaml -o ../apps/swiftlet/src/api/generated/schema.d.ts

✨ openapi-typescript 7.13.0
🚀 openapi.yaml → ../apps/swiftlet/src/api/generated/schema.d.ts [10.8ms]
diff --git a/apps/swiftlet/src/api/generated/schema.d.ts b/apps/swiftlet/src/api/generated/schema.d.ts
index 3bbec5d..1df0d8c 100644
--- a/apps/swiftlet/src/api/generated/schema.d.ts
+++ b/apps/swiftlet/src/api/generated/schema.d.ts
@@ -36,6 +36,8 @@ export interface components {
             status: "ok";
             /** @description Galley's configured version string (GALLEY_VERSION). */
             version: string;
+            /** @description Deliberate drift-check demo field (see docs/evidence/m2/51-api-contract.md); reverted immediately after capture. */
+            uptimeSeconds?: number;
             /** @enum {string} */
             environment: "development" | "production";
             /**

DRIFT DETECTED: regenerating ../apps/swiftlet/src/api/generated/schema.d.ts from openapi.yaml produced the diff above.
Either the contract changed without regenerating, or the generated file was hand-edited. Run 'npm run generate:swiftlet' and commit the result, or investigate the diff.
```
(exit code 1)

**Reverted** (`git checkout -- contracts/openapi.yaml
apps/galley/internal/httpapi/api.gen.go
apps/swiftlet/src/api/generated/schema.d.ts`); both checks pass again:

```
$ ./scripts/check-contract-drift.sh     # from apps/galley
OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).

$ ./check-swiftlet-drift.sh             # from contracts
OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
```

`git status --short` at the repository root showed no output after
each revert, confirming the working tree returned exactly to the
committed state before continuing.

## Implementation limitations and follow-ups

- **Swiftlet uses generated types, not a generated client.** Issue
  #51 accepts either ("Swiftlet calls Galley through generated types
  or a generated client"); this was a deliberate choice, not a gap —
  see "Format and generator choices" above for the concrete
  `openapi-fetch`/`response.headers`/test-double incompatibility that
  motivated it. If a future slice wants a full generated client (for
  example, once an endpoint's request shape is complex enough that
  hand-rolled `fetch` logic stops scaling), the blocker to resolve
  first is `StatusView.test.tsx`'s/`App.test.tsx`'s fetch doubles
  returning plain objects rather than real `Response` instances; no
  specific follow-up issue exists yet, natural owner is whichever M2
  slice next touches `apps/swiftlet`'s API layer.
- **No CI wiring for the drift check or either app's build/test.** No
  `.github/workflows` (or any CI) exists anywhere in this repository
  yet — this predates this slice and is not specific to it. The drift
  check and both apps' build/test commands are documented and
  manually reproducible (this record and both READMEs), but nothing
  runs them automatically on push/PR. No specific follow-up issue
  exists yet; natural owner is the gate-report slice
  ([#62](https://github.com/cristoforows/ticketIt/issues/62)) or a
  dedicated CI-setup slice, whichever M2/M3 decides to introduce CI.
- **OpenAPI has no way to attach a response schema to "no route
  matched" or "method not allowed" as such** — these aren't
  operations. `TestErrorResponses_MatchContract` works around this by
  validating the 404/405 response bodies directly against the
  contract's `ErrorBody` schema component (not through the
  operation/router-based `openapi3filter.ValidateResponse` path used
  for the 200 case). This is a modeling constraint of OpenAPI itself,
  not a gap in this slice's coverage — both response bodies are
  checked against the exact schema the contract defines for them.

No other required behavior in issue #51 was left unimplemented; every
acceptance criterion is satisfied and verified above.

## Outstanding checks and owning milestone

- **CI automation** of the build/test/drift-check commands recorded
  here — no owning issue yet; see "Implementation limitations" above.
- **Extending the contract to #52's database health fields** — owned
  by [#52](https://github.com/cristoforows/ticketIt/issues/52), which
  should follow this slice's own convention (edit
  `contracts/openapi.yaml` first, regenerate, then implement) and can
  reuse `internal/httpapi/contract_test.go`'s pattern for its own new
  response fields.
- **Whether other M2 endpoints' request shapes need a full generated
  client** rather than generated types — deferred, see "Implementation
  limitations" above.

## Decision impacts (open-decision IDs)

None of D1, D2, D4–D9 are resolved or touched by this slice.
[D3](../../decisions/d3-agent-template-compatibility.md) is unrelated
— this slice has no Agent, Round, or execution concept, per M2's scope
rule. This record's decision-relevant content is entirely the
engineering choices issue #51 designates as this slice's own to make
and record: the contract format (OpenAPI 3.1.0), the two generators
and their exact versions, the committed-vs-build-time-generation
choice (committed), and the generated-types-vs-generated-client choice
for Swiftlet (types) — none of these are open product decisions
requiring D-series resolution.
