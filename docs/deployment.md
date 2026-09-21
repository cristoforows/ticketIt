# Deployment and local execution

See [implementation-plan.md](implementation-plan.md) for the approved M1–M10 milestones and [open-decisions.md](open-decisions.md) for remaining selections. Application directories below describe the planned scaffold, not implemented services.

M2 establishes Swiftlet/Galley and PostgreSQL locally; M4 connects Michelin with controlled execution. M6 selects document storage, M7/M8 add real research/coding, and M10 completes hosting, reproducible operational setup, and deployed acceptance. The hosting-comparison demonstration runs after its provisional installation exists.

## Provisioning requires explicit Owner approval

No agent or automated process provisions a paid resource. This covers creating, upgrading, or resuming any account, instance, database, bucket, domain, or plan that can incur a charge, at Cloudflare R2, Supabase, any application or PostgreSQL host, OpenRouter, or any other provider. It includes free tiers that require payment details or that bill automatically once an allowance is exceeded.

The Owner performs these steps themselves, or gives explicit approval for a named resource at a named provider immediately beforehand. Approval for one resource is not approval for the next. Approval to research or compare providers is not approval to create an account, and a documented cost target is not standing authorization to spend against it.

Until the Owner approves, run everything locally: PostgreSQL on the developer machine, local substitutes or fixtures for object storage, and controlled provider substitutes in tests. A task that cannot proceed without a paid resource is a blocked task to report, with the specific resource named, rather than a signup to perform.

The selections this affects are tracked in [open-decisions.md](open-decisions.md), "Known operational selections awaiting the owner": object storage and application/PostgreSQL hosting (**D7**, reaching M6 and M10) and model-provider credentials (**D7**, reaching M7 and M8). Recording a recommendation there never resolves the decision or authorizes the spend.

## Initial split

Host the ticketIt web app and its backend online. The hosted side manages ticket data, agent configurations, the work queue, round history, and the usage dashboard. Recipes and reports use Cloudflare R2 or Supabase Storage, pending the user's provider selection.

Keep the frontend and ticket-management backend as independent application modules with an explicit API boundary, released and hosted together for v1. The backend owns authoritative ticket state and validates updates reported by runners. The local runner remains a separate application; OpenCode is a process it manages.

The frontend must not own ticket workflow rules, access the database directly, or depend on backend implementation internals. The backend serves both the frontend and runner without depending on UI components. Shared API contracts may describe requests, responses, and events.

Combined deployment is an operational choice rather than a requirement to combine application code. Preserve the ability to build and test frontend and backend independently and deploy them separately later. Runtime framework details and packaging remain undecided.

### Monorepo and application names

Keep the three independent applications in one repository:

```text
ticketIt/
├── apps/
│   ├── swiftlet/   # React frontend
│   ├── galley/     # Go ticket-management backend
│   └── michelin/   # TypeScript/Node.js local runner
├── contracts/     # API schemas and client-generation configuration
├── docs/
├── CONTEXT.md
└── AGENTS.md
```

Use `swiftlet`, `galley`, and `michelin` as the application names. Each application retains independent dependencies, build, tests, and entry point. Swiftlet and Galley are deployed together initially; Michelin runs locally and manages OpenCode. This layout describes the planned scaffold.

### Technology choices

React is selected for the frontend, Go for the backend, and TypeScript with Node.js for the local runner. The native research harness uses LangChain TypeScript with its LangGraph foundation. Frontend build tooling and backend HTTP framework/router remain undecided.

Use PostgreSQL as the application database for tickets, rounds, agent configurations, permission grants, ownership, usage records, and document metadata/associations. Recipe versions and report content remain in object storage. The PostgreSQL hosting provider is not yet selected and is independent of the object-storage provider choice.

Python is excluded from the implementation stack. The Go backend and TypeScript runner communicate through the execution API and retain independent build and runtime boundaries.

Run agent processing on the user's computer through a local runner. The runner coordinates model-provider API calls and executes local tools; the model itself normally executes at its provider.

The local runner supports both the native research harness and OpenCode coding execution. AI-powered Grill Mode also requires the local processing service under this initial split.

## Ownership and sign-in

Support one owner per deployment in v1, with sign-in and explicit ownership of tickets, recipes, agents, and connected accounts. Enforce that ownership in backend access rules while leaving room for multiple independent users later.

The initial deployment is for limited personal use. Target combined application hosting, PostgreSQL, and object-storage costs below $10/month, excluding OpenRouter usage. Free tiers, sleeping services, and occasional cold starts are acceptable provided stored data persists. Verify provider-specific quotas and retention behavior before selecting hosting providers.

Use GitHub OAuth for owner sign-in in v1, restricted to the configured owner. Request only the access needed to establish identity, then create a ticketIt session. Signing in is distinct from authorizing agent use of a connected external account.

Keep the owner identity independent of GitHub-specific identifiers so additional sign-in providers can be supported later. This extensibility does not change the one-owner-per-deployment scope of v1. Owner bootstrap, session handling, and future identity-linking behavior still need implementation design.

## Runner lifecycle

For the first iteration, start the runner manually as a long-lived terminal process. The terminal shows operational logs; the ticketIt web app is the user-facing interface for agent work.

The runner authenticates to the hosted app and initiates outbound communication to retrieve eligible work and return progress, questions, usage, and results. It does not require public inbound access to the user's laptop. Initial work retrieval can use polling.

Runner authentication is separate from model-provider credentials and connected-account authorization. Pairing, credential storage, distribution, and startup commands still need implementation design.

The OpenRouter model-provider credential and a fine-grained GitHub personal access token are configured locally on the runner in v1. The runner uses GitHub's API directly; `gh` is not required. Future multi-user support must include web-managed provider configuration and credentials, scoped to the appropriate owner, and GitHub connections should support a future browser-based authorization flow. Runner authentication credential storage remains undecided.

## Managed OpenCode

The runner starts and supervises a separate headless OpenCode server process through its SDK. Users do not need to launch an interactive OpenCode terminal UI or maintain a separate server manually.

The integration creates sessions, supplies ticket context and supported agent configuration, and relays progress, questions, permission requests, and results into ticketIt. An OpenCode session is an engine detail; ticketIt retains its own round lifecycle and history.

OpenCode must be available on the local machine. Installation and packaging remain to be decided.

Coding execution runs directly on the host in v1, in per-ticket Git worktrees. Container isolation is an important v2 upgrade; worktree separation and application-level permissions do not constitute a complete host sandbox.

## Availability

Closing the browser does not stop a live runner. When the runner is unavailable, the hosted app can still manage tickets and display stored results, while new agent work waits.

If the runner loses contact with the hosted app during a round, pause new actions until it reconnects. Keep the ticket locked and display Runner disconnected. If execution state remains intact, reconnection can continue the same round after reconciling current permissions and pending controls.

If the execution process actually stopped, use the Interrupted-to-Blocked recovery flow in `agent-execution.md`. Loss of contact alone does not prove the process stopped. Disconnect detection, engine-specific pausing, and reconciliation mechanics still need implementation design.

## Later evolution

The same execution interface should support a runner on a remote machine later. OS-service installation or a desktop wrapper can replace manual terminal startup without changing ticket management.
