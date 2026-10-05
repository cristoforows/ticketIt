# ticketIt

A personal ticket tracker with board/list views and configurable AI agents that carry out work in traceable rounds.

**Status:** [v1 spec #1](https://github.com/cristoforows/ticketIt/issues/1) and ten milestone issues published. [M1's](https://github.com/cristoforows/ticketIt/issues/2) bounded adapter proofs and [M2's](https://github.com/cristoforows/ticketIt/issues/3) persistent Owner workflow are gate-reported in [M1 evidence](docs/evidence/m1/README.md) and [M2 evidence](docs/evidence/m2/README.md). [M3's](https://github.com/cristoforows/ticketIt/issues/4) board/list, modal, Status moves, reusable Badges and Archive/Restore have a **local** clean-worktree gate report at [M3 evidence](docs/evidence/m3/README.md); its execution-eligibility and open-Round checks are covered by M4. [M4's](https://github.com/cristoforows/ticketIt/issues/5) Agents, runner pairing, Owner priority order, atomic claims, open-Round lock, controlled-engine Rounds, delivery to In Review and explicit rework have a **local** clean-worktree gate report at [M4 evidence](docs/evidence/m4/README.md) (#138). [M5's](https://github.com/cristoforows/ticketIt/issues/6) questions and answers, live Permissions, the active slip, Stop, Failed, Interrupted, Reconcile, Owner-attested recovery and technical limits have a **local** clean-worktree gate report at [M5 evidence](docs/evidence/m5/README.md) (#173). Michelin runs only a scripted controlled engine; real research and coding are M7 and M8. The browser suite is local and not in CI. The Owner has resolved [D3](docs/decisions/d3-agent-template-compatibility.md), D5 and D8; remaining choices are in [open decisions](docs/open-decisions.md).

## Applications

| Application | Stack | Responsibility | Initial deployment |
| --- | --- | --- | --- |
| `swiftlet` | React | Ticket UI, review, configuration, usage | Hosted with Galley |
| `galley` | Go + PostgreSQL | Authoritative ticket state, ownership, permissions, queue, history | Hosted with Swiftlet |
| `michelin` | TypeScript + Node.js | Local processing, native LangChain/LangGraph research, managed OpenCode coding | Owner's computer |

The monorepo keeps these applications independently buildable under `apps/`, with API contracts under `contracts/`. `swiftlet` and `galley` are built (M2); `michelin` runs a controlled engine only (M4–M5). Recipes and reports use S3-compatible object storage; Cloudflare R2 or Supabase Storage is awaiting selection.

## Design and implementation planning

Start here:

1. [V1 scope](docs/v1-scope.md) — consolidated approved behavior and deferred features.
2. [Implementation plan](docs/implementation-plan.md) — approved M1–M10 milestones, linked issues, blocking edges, scope, and acceptance gates.
3. [Open decisions](docs/open-decisions.md) — unresolved choices, recommendations, and when they matter.
4. [Integration feasibility](docs/integration-feasibility.md) — evidence, limitations, and checks required before rollout.
5. [Acceptance scenarios](docs/acceptance-scenarios.md) — research demonstration and coding/recovery checks.
6. [Execution interface contract](docs/contracts/execution-interface.md) — Galley/Michelin execution contract and the Swiftlet→Galley owner-command boundary.
7. [Architectural decision records](docs/adr/) — hard-to-reverse choices restating the approved design.

[M1 — Foundational decisions and integration proofs (#2)](https://github.com/cristoforows/ticketIt/issues/2) has its experiment results and accepted [D3 rules](docs/decisions/d3-agent-template-compatibility.md); [M2 — Application foundations and persistent owner workflow (#3)](https://github.com/cristoforows/ticketIt/issues/3) is complete and gate-reported at [#62](https://github.com/cristoforows/ticketIt/issues/62). [M3 — Planning, navigation, and Ticket organization (#4)](https://github.com/cristoforows/ticketIt/issues/4) has eight implementation slices gate-verified in [#95's report](docs/evidence/m3/README.md). [M4 — Connected runner and durable controlled Rounds (#5)](https://github.com/cristoforows/ticketIt/issues/5) has eleven slices gate-reported in [#138's report](docs/evidence/m4/README.md). [M5 — Human input, live Permissions, and execution recovery (#6)](https://github.com/cristoforows/ticketIt/issues/6) has fourteen slices gate-reported in [#173's report](docs/evidence/m5/README.md). Remaining integration gates are tracked in [open decisions](docs/open-decisions.md). Each milestone spans multiple sessions and is split into implementation-sized vertical slices when work begins. Manual workflows arrive in M2–M3, controlled Agent execution in M4, and real research/coding in M7/M8. Research and coding can proceed independently after their shared M5/M6 prerequisites.

[CONTEXT.md](CONTEXT.md) defines domain vocabulary. Implementation details belong in the design docs:

- [Ticket creation and templates](docs/ticket-creation.md)
- [Ticket views, locks, and archiving](docs/ticket-views.md)
- [Agent execution and permissions](docs/agent-execution.md)
- [Deployment and application boundaries](docs/deployment.md)
- [Usage accounting](docs/usage-accounting.md)

## Repository workflow

Issues and PRDs belong to [cristoforows/ticketIt](https://github.com/cristoforows/ticketIt). Development agents use the isolated `cristoforows` GitHub CLI profile documented in [issue-tracker.md](docs/agents/issue-tracker.md).

That developer CLI profile is separate from ticketIt's own runtime authentication: GitHub OAuth for owner sign-in (built, M2, against a local substitute provider — real `github.com` verification is M10), and a local fine-grained GitHub token for Michelin's planned API actions (M8).

## Build, setup, and test

Each application is independently buildable — a Swiftlet build needs no Go toolchain, and a Galley build needs no Node. See each application's own README for configuration and endpoints. Run each group below independently from the repository root.

**Prerequisites:** Go 1.27.1, Node 26.9.0/npm 11.19.1, and local PostgreSQL with `createdb`/`psql` available (M3 gates passed on PostgreSQL 17.11 and 18.1; see `docs/deployment.md`, "Provisioning requires explicit Owner approval").

```sh
# Galley — one-time local database setup, then build/test
createdb ticketit_dev && createdb ticketit_test
(cd apps/galley && DATABASE_URL=postgres://localhost:5432/ticketit_dev?sslmode=disable go run ./cmd/migrate)
(cd apps/galley && gofmt -l . && go vet ./... && go build ./... && go test ./...)

# Swiftlet
(cd apps/swiftlet && npm ci && npm test && npm run build)

# Michelin
(cd apps/michelin && npm ci && npm run typecheck && npm test)

# Contracts — check committed generated clients for drift
(cd contracts && npm ci && npm run check:swiftlet-drift && npm run check:michelin-drift)
(cd apps/galley && ./scripts/check-contract-drift.sh)

# Browser-to-backend suite (dedicated ticketit_e2e database)
(cd e2e && ./run.sh)
```

Galley's tests use `ticketit_test` by default; the M3 gate used a fresh `ticketit_m3_gate3_test` via `GALLEY_TEST_DATABASE_URL` (exact commands and output in [M3 evidence](docs/evidence/m3/README.md)). The browser runner resets only its dedicated database's `public` schema. Regeneration after editing `contracts/openapi.yaml` is documented in [contracts/README.md](contracts/README.md). `apps/galley/README.md` also documents running Galley itself (`go run ./cmd/galley`, requiring `GALLEY_OWNER_GITHUB_LOGIN`/OAuth client settings) and `apps/swiftlet/README.md` documents its dev server against a running Galley. For M1's integration-proof experiments, see [experiments/README.md](experiments/README.md).
