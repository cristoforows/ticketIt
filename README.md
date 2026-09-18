# ticketIt

A personal ticket tracker with board/list views and configurable AI agents that carry out work in traceable rounds.

**Status:** design documented; application implementation has not started.

## Applications

| Application | Stack | Responsibility | Initial deployment |
| --- | --- | --- | --- |
| `swiftlet` | React | Ticket UI, review, configuration, usage | Hosted with Galley |
| `galley` | Go + PostgreSQL | Authoritative ticket state, ownership, permissions, queue, history | Hosted with Swiftlet |
| `michelin` | TypeScript + Node.js | Local processing, native LangChain/LangGraph research, managed OpenCode coding | Owner's computer |

The planned monorepo keeps these applications independently buildable under `apps/`, with API contracts under `contracts/`. Recipes and reports use S3-compatible object storage; Cloudflare R2 or Supabase Storage is awaiting selection.

## Design and implementation planning

Start here:

1. [V1 scope](docs/v1-scope.md) — consolidated approved behavior and deferred features.
2. [Implementation plan](docs/implementation-plan.md) — dependency-ordered milestones and acceptance gates.
3. [Open decisions](docs/open-decisions.md) — unresolved choices, recommendations, and when they matter.
4. [Integration feasibility](docs/integration-feasibility.md) — evidence, limitations, and checks required before rollout.
5. [Acceptance scenarios](docs/acceptance-scenarios.md) — research demonstration and coding/recovery checks.

[CONTEXT.md](CONTEXT.md) defines domain vocabulary. Implementation details belong in the design docs:

- [Ticket creation and templates](docs/ticket-creation.md)
- [Ticket views, locks, and archiving](docs/ticket-views.md)
- [Organization, booths, and badges](docs/ticket-organization.md)
- [Agent execution and permissions](docs/agent-execution.md)
- [Deployment and application boundaries](docs/deployment.md)
- [Usage accounting](docs/usage-accounting.md)

## Repository workflow

Issues and PRDs belong to [cristoforows/ticketIt](https://github.com/cristoforows/ticketIt). Development agents use the isolated `cristoforows` GitHub CLI profile documented in [issue-tracker.md](docs/agents/issue-tracker.md).

That developer CLI profile is separate from ticketIt's planned runtime authentication: GitHub OAuth for owner sign-in, and a local fine-grained GitHub token for Michelin's API actions.

Build, setup, and test commands will be added when the application scaffold exists.
