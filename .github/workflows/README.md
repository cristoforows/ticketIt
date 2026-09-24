# CI

`ci.yml` runs three independent jobs on every pull request and on push
to `main`. Each runs the same commands as below, with one difference:
CI's `gofmt` step fails on any output; plain `gofmt -l .` exits 0 and
relies on you noticing (see `apps/galley/README.md`, "expect no
output").

## Galley

```sh
cd apps/galley
createdb ticketit_ci_probe   # any empty PostgreSQL 17 database
DATABASE_URL=postgres://localhost:5432/ticketit_ci_probe?sslmode=disable go run ./cmd/migrate
gofmt -l .
go vet ./...
go build ./...
GALLEY_TEST_DATABASE_URL=postgres://localhost:5432/ticketit_ci_probe?sslmode=disable go test ./...
```

See `apps/galley/README.md`, "Build, test, run", "Database
migrations", "Local PostgreSQL setup", and "Testing against real
PostgreSQL".

## Swiftlet

```sh
cd apps/swiftlet
npm ci
npm test
npm run build
```

See `apps/swiftlet/README.md`, "Install", "Test", "Build".

## Contracts

```sh
cd apps/galley && ./scripts/check-contract-drift.sh
cd contracts && npm ci && ./check-swiftlet-drift.sh
```

Both scripts require a clean git tree for their generated file first
(`git status`) — see `contracts/README.md`, "The drift check".
