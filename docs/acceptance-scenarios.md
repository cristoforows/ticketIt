# Acceptance scenarios

These describe acceptance work to perform after implementation. They have not been executed. The hosting-comparison story was selected with the owner; the additional checks below derive from approved v1 behavior.

The approved [implementation plan](implementation-plan.md) develops controlled execution checks in M4–M6, real-engine checks in M7/M8, and combined accounting in M9. [M10 — Deployment, operational setup, and v1 acceptance (#11)](https://github.com/cristoforows/ticketIt/issues/11) runs the complete hosted scenarios below. M7 and M8 have shared prerequisites but neither blocks the other.

## First research scenario: compare hosting for ticketIt

Use a bounded comparison of three hosting options, informed by one Markdown recipe, as the first end-to-end research scenario.

### Ticket

- **Title:** Compare hosting options for ticketIt.
- **Template:** Basic.
- **Goal:** Recommend a practical hosting option for the first version of ticketIt.
- **Recipe:** A Markdown document containing the agreed deployment requirements and the owner's hosting constraints.

### Known deployment requirements

- React frontend and independent Go backend, hosted together initially.
- PostgreSQL for application data.
- Cloudflare R2 or Supabase Storage for recipes and reports, with the final provider still pending.
- Agent processing runs on the owner's local TypeScript/Node.js runner, not on the application host.
- Hosted endpoints support owner sign-in and authenticated communication with the runner.
- One owner per deployment in v1.
- Limited personal use, with combined application hosting, PostgreSQL, and object-storage costs below $10/month. OpenRouter usage is outside this hosting budget.
- Free tiers, sleeping services, and occasional cold starts are acceptable provided stored data persists.

### Success criteria

- Compare three hosting options against the supplied requirements.
- Explain deployment fit, relevant limitations, and estimated ongoing costs using cited sources, identifying whether each option fits the below-$10/month hosting budget.
- Recommend one option and explain the trade-offs and remaining uncertainties.
- Deliver the Markdown report within the completed round for human review.

### End-to-end behavior to demonstrate

1. Capture the ticket in Backlog and use optional Grill Mode to clarify missing requirements.
2. Link the recipe and assign a native research agent.
3. Move the sufficiently defined ticket to Ready and execute through the local runner.
4. Research using OpenRouter web search and the fixed recipe version.
5. Store the report in object storage and show it in the round's ticket section.
6. Accept the report to move the ticket from In Review to Done.
7. Inspect preparation and execution usage, with round-level details and ticket totals.

### Bootstrap dependency

Run this scenario after a provisional installation and test storage connection exist. It validates the research workflow and can inform a later hosting choice; it cannot choose the infrastructure required to run itself. Provider selections remain in [open-decisions.md](open-decisions.md).

## Coding acceptance scenario

Use an owner-selected small change in an authorized fixture repository with explicit success criteria. Complete [open decisions D2–D4](open-decisions.md) before evaluating review or exceptional PR behavior.

1. Create a Coding-template ticket, select its repository, and assign an OpenCode-backed agent.
2. Provide the required scoped connection permissions and move the ticket to Ready.
3. Confirm execution in its separate worktree without changing the owner's normal checkout.
4. Deliver a draft PR and per-round commit, summary, tests/results, and criteria assessment.
5. Submit feedback on GitHub and verify that it does not automatically start work.
6. Explicitly requeue through ticketIt; another round updates the same branch and PR while preserving the first round's delivery.
7. Complete the agreed human-review step and merge; verify Done and expiration of ticket-based grants. Time-based grants continue until expiry or revocation.
8. Inspect both rounds and the retained usage totals.

## Control and recovery checks

| Scenario | Required observation |
| --- | --- |
| Assignment/status ordering | Valid Ready + agent assignment requests work in either order; title-only capture does not bypass readiness checks. |
| Duplicate claim/event | One active execution for the work request; replayed events do not duplicate actions, reports, or costs. |
| Necessary question | Blocked ticket remains locked; answer continues the same round. |
| Changed agent/recipe/skill | Open round uses its original versions; later round uses the updated versions. |
| Expired grant | Subsequent unauthorized actions blocked; permitted work can continue; renewal follows the same-round input flow. |
| Disconnection | New supported actions pause, ticket stays locked; reconnect reconciles authority and pending Stop before continuing intact execution. |
| Process death | Interrupted/Blocked, retained history, no automatic new round. |
| Owner stop | Stopping until confirmation; then Backlog + Stopped badge and retained partial work/usage. |
| Failure | Failed/Blocked with explanation and preserved work; new execution needs explicit requeue. |
| Open-round edits/archive | Fields read-only; answer/permission/Stop controls remain usable; archive requires the round to end. |
| Queued archive/restore | Archive withdraws work; restoring previous Ready yields Backlog, not automatic execution. |
| Stopped badge removal | Manual removal changes the badge only, not historical round outcome. |
| Incomplete usage | Unknown/estimated data is identified; archived and interrupted costs remain visible. |
| Modal/full page | Same ticket data and controls; board/list opens modal, direct URL opens full page. |

## Release evidence

Capture the actual versions, environment, test results, report/PR references, and any supported-capability limits during validation. Simulated providers establish control behavior; real selected-model and authorized GitHub checks establish external compatibility. A required check that cannot pass remains an open issue rather than an implied success.
