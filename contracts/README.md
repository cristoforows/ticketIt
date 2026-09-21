# contracts

The single source of truth for Galley's HTTP API. `openapi.yaml`
describes every endpoint and the shared error shape; both applications
generate from it rather than hand-maintaining a second description.
Tracking issue: [#51 — M2.3 — API contract and generated client
convention](https://github.com/cristoforows/ticketIt/issues/51), under
[M2 (#3)](https://github.com/cristoforows/ticketIt/issues/3).

This slice describes exactly what already existed
([#49](https://github.com/cristoforows/ticketIt/issues/49),
[#50](https://github.com/cristoforows/ticketIt/issues/50)):
`GET /api/status` and the shared `{"error":{"code","message"}}` shape.
It adds no new endpoint — see
[docs/evidence/m2/51-api-contract.md](../docs/evidence/m2/51-api-contract.md)
for the full record.

## The convention: contract first, then implement

Every later slice that changes Galley's HTTP API follows this order:

1. **Edit `contracts/openapi.yaml` first.** Add the new path/operation
   or schema change here before writing any application code.
2. **Regenerate both sides** (commands below).
3. **Implement.** Galley's generated `ServerInterface`
   (`apps/galley/internal/httpapi/api.gen.go`) will not compile until
   every operation in the contract has a handler method; Swiftlet's
   generated types (`apps/swiftlet/src/api/generated/schema.d.ts`)
   give the new shape to whatever code calls it.
4. **Run the drift check** (below) before committing, and expect it to
   pass. If you changed the contract but see a diff from
   regeneration, or a schema-validation failure, you have not finished
   step 2 or 3 yet.

Do not hand-edit any generated file (`api.gen.go`,
`src/api/generated/schema.d.ts`) — they are marked "DO NOT EDIT" and
the drift check assumes they are always regeneration output, never
authored directly.

## Format and generators, and why

**OpenAPI 3.1.0** (`openapi.yaml`), the version this issue recommends.
Both generators below load it without incident — the one caveat is
`x-go-type: string` on `StatusResponse.startedAt` (see "Generated Go
types" below).

**Go (`apps/galley`): [oapi-codegen](https://github.com/oapi-codegen/oapi-codegen) v2.8.0**,
generating both models (`generate.models`) and a
[Go 1.22+ `net/http` server interface](https://github.com/oapi-codegen/oapi-codegen/blob/v2.8.0/docs/stdhttp-server.md)
(`generate.std-http-server`) — the same routing style Galley already
uses (`apps/galley/README.md`, "Router choice"), so no router
migration is needed to adopt generated server binding. Config:
[`contracts/galley/oapi-codegen.config.yaml`](galley/oapi-codegen.config.yaml).
The tool version is pinned in `apps/galley/go.mod`'s `tool` directive
(Go 1.24+'s built-in mechanism for pinning a dev-tool's version,
preferred here over a `tools.go` blank-import file or an unpinned
`go run pkg@latest`), so `go generate ./...` always uses exactly
v2.8.0 without a separate lockfile-like mechanism.

Chosen over `swagger-codegen`/`openapi-generator` (both need a JVM,
which Galley's toolchain doesn't otherwise require) and over hand-
maintained types (loses the compile-time link between contract and
implementation that makes the drift check meaningful — see below).

**TypeScript (`apps/swiftlet`): [openapi-typescript](https://github.com/openapi-ts/openapi-typescript) v7.13.0**,
generating only types (`components["schemas"]`, `paths`,
`operations`) — no runtime client library. Swiftlet's existing
hand-written `fetchGalleyStatus()` (issue #50) already does its own
runtime validation of the response shape (throwing a specific error
per missing/invalid field) and its own error-message construction
from `response.status`/`statusText`; that behavior is required to stay
byte-for-byte identical (issue #51's "Stops when" clause), so this
slice re-points its types at the generated schema
(`apps/swiftlet/src/api/status.ts`) rather than replacing the fetch
call with a generated client library. **[openapi-fetch](https://github.com/openapi-ts/openapi-fetch)**
was evaluated as the generated-client option and rejected here: it
reads `response.headers` before parsing a body, which the app's
existing test doubles (`vi.stubGlobal("fetch", ...)` returning a
plain `{ok, status, statusText, json}` object, not a real `Response`)
do not provide, so adopting it would mean rewriting passing tests for
no behavioral gain over generated types. This is recorded as this
slice's own engineering choice inside "generated types **or** a
generated client" (issue #51 accepts either) — see
`docs/evidence/m2/51-api-contract.md` for the full trade-off.

### Why a separate `contracts/package.json` for codegen

`openapi-typescript` v7.13.0 uses the classic TypeScript Compiler API
(`ts.factory`) at runtime, which `typescript` 7.x's package no longer
exports from its root entry point (only `./unstable/ast/factory` and
friends — a breaking restructuring, not a version-range mismatch).
Since `apps/swiftlet` is pinned to TypeScript 7.0.2, running
`openapi-typescript` with that version installed crashes
(`Cannot read properties of undefined (reading 'createKeywordTypeNode')`).
Rather than downgrade Swiftlet's own TypeScript version (`tsc`'s
type-checking of `src/`, unrelated to code generation) to satisfy a
dev tool, this directory has its **own** `package.json` pinning
`typescript@5.9.3` (the version `openapi-typescript` actually needs)
and `openapi-typescript@7.13.0`, entirely separate from
`apps/swiftlet/node_modules`. `apps/swiftlet`'s own `npm ci`, `npm
test`, and `npm run build` never install or invoke anything in this
directory — they only ever see the **committed** generated
`schema.d.ts`. This keeps the two TypeScript versions from ever
needing to coexist in the same `node_modules`, and keeps Swiftlet's
own build exactly as independent as before this slice.

### Generated Go types: two overrides

Both exist solely so binding to generated types changed no observable
byte of `GET /api/status`:

- `startedAt` carries `x-go-type: string` in the contract. Without it,
  oapi-codegen maps `format: date-time` to `time.Time`, whose
  `RFC3339Nano` marshaling can include fractional seconds — a byte-level
  change from the plain `startedAt.UTC().Format(time.RFC3339)` string
  Galley has always produced (issue #49).
- `StatusResponse.MarshalJSON` in `apps/galley/internal/httpapi/status.go`
  holds the JSON field order. oapi-codegen emits Go struct fields
  alphabetically by property name, and `encoding/json` serializes in
  declaration order, so left alone the response's keys would reorder.

## Committed generated artifacts

Both sides' generated files are **committed**, not produced as a
build step:

- `apps/galley/internal/httpapi/api.gen.go`
- `apps/swiftlet/src/api/generated/schema.d.ts`

This is the choice that keeps "independent builds must survive"
unconditionally true regardless of which generator either side uses:
`apps/swiftlet`'s `npm ci && npm test && npm run build` never invokes
Go or anything Go-toolchain-shaped, and `apps/galley`'s `go build
./... && go test ./...` never invokes Node — because neither build
step regenerates anything; they only compile/type-check already-
committed source. The trade-off is exactly the discipline the
convention above exists to enforce: a contract edit that isn't
followed by regeneration is instantly visible as review-diffable,
committed drift, not a step someone forgot to run in CI.

## Regenerating

**Galley** (requires only the Go toolchain already required by
`apps/galley`):

```sh
cd apps/galley
go generate ./...
```

**Swiftlet's types** (requires Node, via this directory's own,
separate toolchain — never `apps/swiftlet`'s):

```sh
cd contracts
npm ci
npm run generate:swiftlet
```

Commit the resulting diff in both cases.

## The drift check

**This is the part of the slice that matters most: a contract nothing
enforces is decoration.** Two independent mechanisms, both required to
pass:

1. **Response-vs-schema validation** — a Go test,
   `apps/galley/internal/httpapi/contract_test.go`
   (`TestGetStatus_ResponseMatchesContract`,
   `TestErrorResponses_MatchContract`), that sends a real request
   through the real, fully-wired `NewHandler` and validates the actual
   response bytes against `contracts/openapi.yaml`'s schema using
   [kin-openapi](https://github.com/getkin/kin-openapi)'s
   `openapi3filter`. This catches drift a compiler cannot: the
   contract and the implementation both compiling fine but
   disagreeing about an actual value (an enum/const, a required field
   silently becoming absent, and so on). Run it with:

   ```sh
   cd apps/galley
   go test ./internal/httpapi/... -run Contract -v
   ```

2. **Regeneration produces no diff** — `apps/galley/scripts/check-contract-drift.sh`
   and `contracts/check-swiftlet-drift.sh` each regenerate their
   side's generated file and fail (`git diff --exit-code`) if that
   produces any change. This catches the contract changing without
   regeneration, or a generated file being hand-edited.

   ```sh
   cd apps/galley && ./scripts/check-contract-drift.sh
   cd contracts && npm ci && ./check-swiftlet-drift.sh
   ```

`docs/evidence/m2/51-api-contract.md` records both checks caught
failing on a deliberate mismatch (with the real command output), and
passing again once reverted.

## Layout

```text
contracts/
├── README.md                    # this file
├── openapi.yaml                 # the contract: GET /api/status + the shared error shape
├── package.json                 # codegen-only toolchain for Swiftlet's types (see above)
├── check-swiftlet-drift.sh      # drift check, part 2 (Swiftlet side)
└── galley/
    └── oapi-codegen.config.yaml # pinned oapi-codegen configuration
```
