# ticketIt

A personal ticket tracker with board/list views and configurable AI agents that carry out work in traceable rounds.

**Status:** [v1 spec #1](https://github.com/cristoforows/ticketIt/issues/1) and ten milestone issues published. [M1's](https://github.com/cristoforows/ticketIt/issues/2) bounded adapter proofs are complete (see [docs/integration-feasibility.md](docs/integration-feasibility.md) and [docs/evidence/m1/](docs/evidence/m1/README.md)); the Owner has resolved [D3](docs/decisions/d3-agent-template-compatibility.md) in favor of owner-chosen Agents without template restrictions. [M2's](https://github.com/cristoforows/ticketIt/issues/3) thirteen implementation slices are complete and gate-reported at [#62](https://github.com/cristoforows/ticketIt/issues/62): the Owner can sign in, capture and refine a Ticket, and manage basic human-assigned work through Swiftlet and Galley against real PostgreSQL — see [docs/evidence/m2/](docs/evidence/m2/README.md) for the full slice index and verified acceptance criteria. M2 has no Agents, Rounds, execution, or Michelin, and no board, modal, Badges, archive, object storage, or hosting; M3 has not started.

## Applications

| Application | Stack | Responsibility | Initial deployment |
| --- | --- | --- | --- |
| `swiftlet` | React | Ticket UI, review, configuration, usage | Hosted with Galley |
| `galley` | Go + PostgreSQL | Authoritative ticket state, ownership, permissions, queue, history | Hosted with Swiftlet |
| `michelin` | TypeScript + Node.js | Local processing, native LangChain/LangGraph research, managed OpenCode coding | Owner's computer |

The monorepo keeps these applications independently buildable under `apps/`, with API contracts under `contracts/`. `swiftlet` and `galley` are built (M2); `michelin` remains planned until M4. Recipes and reports use S3-compatible object storage; Cloudflare R2 or Supabase Storage is awaiting selection.

## Design and implementation planning

Start here:

1. [V1 scope](docs/v1-scope.md) — consolidated approved behavior and deferred features.
2. [Implementation plan](docs/implementation-plan.md) — approved M1–M10 milestones, linked issues, blocking edges, scope, and acceptance gates.
3. [Open decisions](docs/open-decisions.md) — unresolved choices, recommendations, and when they matter.
4. [Integration feasibility](docs/integration-feasibility.md) — evidence, limitations, and checks required before rollout.
5. [Acceptance scenarios](docs/acceptance-scenarios.md) — research demonstration and coding/recovery checks.
6. [Execution interface contract](docs/contracts/execution-interface.md) — Galley/Michelin execution contract and the Swiftlet→Galley owner-command boundary.
7. [Architectural decision records](docs/adr/) — hard-to-reverse choices restating the approved design.

[M1 — Foundational decisions and integration proofs (#2)](https://github.com/cristoforows/ticketIt/issues/2) has its experiment results and accepted [D3 rules](docs/decisions/d3-agent-template-compatibility.md); [M2 — Application foundations and persistent owner workflow (#3)](https://github.com/cristoforows/ticketIt/issues/3) is complete and gate-reported at [#62](https://github.com/cristoforows/ticketIt/issues/62); [M3 — Planning, navigation, and Ticket organization (#4)](https://github.com/cristoforows/ticketIt/issues/4) is next. Remaining integration gates are tracked in [open decisions](docs/open-decisions.md). Each milestone spans multiple sessions and is split into implementation-sized vertical slices when work begins. Manual workflows arrive in M2–M3, controlled Agent execution in M4, and real research/coding in M7/M8. Research and coding can proceed independently after their shared M5/M6 prerequisites.

[CONTEXT.md](CONTEXT.md) defines domain vocabulary. Implementation details belong in the design docs:

- [Ticket creation and templates](docs/ticket-creation.md)
- [Ticket views, locks, and archiving](docs/ticket-views.md)
- [Organization, booths, and badges](docs/ticket-organization.md)
- [Agent execution and permissions](docs/agent-execution.md)
- [Deployment and application boundaries](docs/deployment.md)
- [Usage accounting](docs/usage-accounting.md)

## Repository workflow

Issues and PRDs belong to [cristoforows/ticketIt](https://github.com/cristoforows/ticketIt). Development agents use the isolated `cristoforows` GitHub CLI profile documented in [issue-tracker.md](docs/agents/issue-tracker.md).

That developer CLI profile is separate from ticketIt's own runtime authentication: GitHub OAuth for owner sign-in (built, M2, against a local substitute provider — real `github.com` verification is M10), and a local fine-grained GitHub token for Michelin's planned API actions (M8).

## Build, setup, and test

Each application is independently buildable — a Swiftlet build needs no Go toolchain, and a Galley build needs no Node. See each application's own README for the full picture (configuration, endpoints, and design rationale); the commands below are the actually-run entry points.

**Prerequisites:** Go 1.27.1, Node 26.9.0/npm 11.19.1, and a local PostgreSQL 17 instance your user can `createdb` on (all documented, all local — see `docs/deployment.md`, "Provisioning requires explicit Owner approval": no hosted database or account is created here).

```sh
# Galley (apps/galley) — one-time local database setup, then build/test
createdb ticketit_dev && createdb ticketit_test
cd apps/galley
DATABASE_URL=postgres://localhost:5432/ticketit_dev?sslmode=disable go run ./cmd/migrate
gofmt -l . && go vet ./... && go build ./... && go test ./...

# Swiftlet (apps/swiftlet)
cd apps/swiftlet
npm ci && npm test && npm run build

# contracts/ — regenerate both clients and check for drift after editing contracts/openapi.yaml
cd contracts
npm ci && npm run generate:swiftlet
cd ../apps/galley && ./scripts/check-contract-drift.sh
cd ../../contracts && ./check-swiftlet-drift.sh

# e2e/ — the full browser-to-backend suite (real Swiftlet build, real Galley, real PostgreSQL)
cd e2e
./run.sh
```

`apps/galley/README.md` also documents running Galley itself (`go run ./cmd/galley`, requiring `GALLEY_OWNER_GITHUB_LOGIN`/OAuth client settings) and `apps/swiftlet/README.md` documents its dev server against a running Galley. For M1's integration-proof experiments, see [experiments/README.md](experiments/README.md).
