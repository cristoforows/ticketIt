# M1 evidence index

Evidence records for [M1 — Foundational decisions and integration
proofs (#2)](https://github.com/cristoforows/ticketIt/issues/2), backing
the bounded experiments in
[docs/integration-feasibility.md](../../integration-feasibility.md)
("Planned feasibility experiments").

## Ownership

**Only the gate-report slice ([M1.18 — M1 gate report and decision
routing, issue #29](https://github.com/cristoforows/ticketIt/issues/29))
edits this index.** Every other M1 experiment slice adds exactly one new
evidence file to this directory and leaves this file alone. This keeps
parallel experiment slices from conflicting with each other over a
shared index file, the same reason `experiments/` has no root
`package.json`.

## Conventions

- One file per experiment issue: `docs/evidence/m1/<issue-number>-<short-slug>.md`
  (e.g. `16-opencode-boot.md`).
- Every file follows [TEMPLATE.md](TEMPLATE.md): Purpose; Exact
  versions; Reproducible commands; Documentation research (unverified);
  Fixture/stub evidence (observed); Real-provider evidence (observed, or
  "none executed"); Observed limitations; Outstanding checks and owning
  milestone; Decision impacts (open-decision IDs).
- Evidence files are records of what was actually run and observed, not
  a substitute for `docs/integration-feasibility.md` or
  `docs/open-decisions.md`. Neither of those documents, nor this index,
  is updated by an individual experiment slice.

## Records

M1's bounded adapter experiments ran 18–19 September 2026. Every row
below is one evidence file; "Establishes" is what the slice set out to
prove, and "Headline finding" is its single most consequential observed
result — see the file itself for exact versions, reproducible commands,
and the full set of findings and limitations.

| File | Issue | Establishes | Headline finding |
| --- | --- | --- | --- |
| [14-experiment-workspace.md](14-experiment-workspace.md) | [#14](https://github.com/cristoforows/ticketIt/issues/14) | The `experiments/` workspace mechanism: package-per-experiment isolation, `file:../shared` dependency, evidence-file conventions | A fresh clone's `npm ci && npm test` passes end to end in three independent packages (`shared`, `_template`, `tracer-fake-clock`); no shared root manifest or lockfile exists to conflict across parallel slices. |
| [15-admission-ledger.md](15-admission-ledger.md) | [#15](https://github.com/cristoforows/ticketIt/issues/15) | `AdmissionLedger`, a deterministic fake-clock-driven substitute for Galley's authorization/control state, plus its loopback HTTP facade | 40/40 tests encode every v1-scope Permission rule (ticket-based vs. time-based grants, disconnected hold-not-deny, pending-Stop precedence, already-dispatched carve-out) as executable, spec-cited assertions; ships the exact HTTP facade later OpenCode/native/GitHub slices reach it through. |
| [16-opencode-boot.md](16-opencode-boot.md) | [#16](https://github.com/cristoforows/ticketIt/issues/16) | Headless OpenCode boot against a scripted stub model, with full config/data/cache/state isolation and clean shutdown | `opencode-ai`/`@opencode-ai/sdk` `1.18.31` (pinned, released together) boots, isolates a decoy "real" global config correctly in both directions, and shuts down with zero orphaned processes — but `--port=0` was unreliable (bound to a fixed port in several conditions), worked around by the harness itself picking a free port. |
| [17-opencode-questions.md](17-opencode-questions.md) | [#17](https://github.com/cristoforows/ticketIt/issues/17) | Question/permission round trips, event-stream + pending-query reconciliation, duplicate-reply handling, once-vs-always permission semantics | A remembered **"always"** permission reply suppresses OpenCode's native ask for a brand-new session in the same still-running process, not just the granting session — the engine's own permission memory cannot be treated as ticketIt's authority boundary. |
| [18-opencode-cancellation.md](18-opencode-cancellation.md) | [#18](https://github.com/cristoforows/ticketIt/issues/18) | Abort-while-running, abort-while-waiting, post-abort continuation, and unclean process death | A clean `session.abort()` kills a running shell tool's child process within 0–1ms; an unclean `SIGKILL` of the server leaves that same child process running as an orphan with no cleanup mechanism anywhere in this build or harness. |
| [19-opencode-fixed-inputs.md](19-opencode-fixed-inputs.md) | [#19](https://github.com/cristoforows/ticketIt/issues/19) | Effective fixed inputs (instructions/Skill/Recipe) surviving a pause across every OpenCode discovery-source decoy this build supports | Two failed gates: an ambient `OPENCODE_CONFIG` env var's `instructions` array concatenates (not replaces) into an unrelated Round's request, and an ambient `OPENCODE_PERMISSION` env var silently overrides a Round's own configured `"ask"` permission to `"allow"`, letting a shell command run with no pending-permission wait at all. |
| [20-opencode-admission.md](20-opencode-admission.md) | [#20](https://github.com/cristoforows/ticketIt/issues/20) | A `tool.execute.before` plugin-hook admission bridge to `AdmissionLedger`, tested against disconnect, expiry, revocation, and Stop | The hook remains the operative gate even under a remembered "always" permission grant that suppresses OpenCode's own prompt entirely — but `tool.execute.before` resolves *before* a native "ask" permission request becomes pending, not after, a real ordering constraint for any design combining both. |
| [21-opencode-coverage-matrix.md](21-opencode-coverage-matrix.md) | [#21](https://github.com/cristoforows/ticketIt/issues/21) | The full action-path coverage matrix: every built-in tool, a custom tool, an MCP tool, model-only continuation, and nested shell, with zero grants | Model-only continuation is structurally ungated at this hook position (0 `admit()` calls across three disconnected text-only turns) and nested shell sub-actions get one whole-call admission with no visibility inside — both recorded as failed gates for D1, not weakened. |
| [22-native-harness-boot.md](22-native-harness-boot.md) | [#22](https://github.com/cristoforows/ticketIt/issues/22) | `createAgent` (LangChain JS `1.5.11`) booted with a scripted model, a durable PostgreSQL `LangGraph` checkpoint, and Round-ID/thread-ID separation | A shipped `.d.ts` `@example` block named the wrong `createAgent` parameter (`prompt` instead of `systemPrompt`); caught only by observing the system prompt was silently absent from the model's actual request, not by reading the docs. |
| [23-native-durable-input.md](23-native-durable-input.md) | [#23](https://github.com/cristoforows/ticketIt/issues/23) | A durable `LangGraph interrupt()`-based question proven across two genuinely separate OS processes, duplicate-resume safety, and the application's own process-death recovery rule | LangGraph restarts an interrupted node from the beginning on resume — a side effect placed before `interrupt()` observably repeats on every resume; a clearly labeled negative-control test shows the framework would have happily continued a mid-tool-call `SIGKILL`'d thread, which the application's own recovery policy refuses to do. |
| [24-native-admission.md](24-native-admission.md) | [#24](https://github.com/cristoforows/ticketIt/issues/24) | Native-path admission before both tool and model calls, including provider-executed search (which has no separate interceptable step) | A held/denied tool call pauses the graph via a resumable `interrupt()`; a held/denied model call throws directly, ending the step outright — two genuinely different mechanisms a caller must handle depending on which kind of call was refused. |
| [25-openrouter-fidelity.md](25-openrouter-fidelity.md) | [#25](https://github.com/cristoforows/ticketIt/issues/25) | The real, pinned `ChatOpenRouter` adapter (`0.4.13`) run against a local fake OpenRouter server across tool calls, citations, usage fields, truncation, and mid-stream errors | When usage arrives via a separate trailing SSE chunk with empty `choices` — the pattern OpenRouter's own docs describe as the norm — `ChatOpenRouter.stream()` silently drops it entirely: zero usage, zero cost, no error. URL citations are dropped in both `invoke` and `stream` modes. |
| [26-usage-persistence.md](26-usage-persistence.md) | [#26](https://github.com/cristoforows/ticketIt/issues/26) | Usage/citation survival through a real checkpoint reload, plus a Galley-ingestion substitute (`UsageIngest`) satisfying every stated M9 rule | LangChain's normalized `usage_metadata` convenience field does **not** survive a checkpoint reload (only the raw `response_metadata.usage` passthrough does) — a naive re-derivation of usage from a reloaded message is lossy even when the adapter itself captured everything at turn time. |
| [27-github-identity.md](27-github-identity.md) | [#27](https://github.com/cristoforows/ticketIt/issues/27) | Mocked OAuth sign-in restriction, fine-grained PAT identity/scope checks, and fake Git/SSH transport, all gated by `AdmissionLedger` | A repository outside a fine-grained PAT's resource set returns 404 with only that PAT ever sent over the wire — a separate, broader "admin" PAT configured in the same fixture but never passed to the connection is never sent, confirmed from the full request log. |
| [28-pr-delivery-lifecycle.md](28-pr-delivery-lifecycle.md) | [#28](https://github.com/cristoforows/ticketIt/issues/28) | Draft-PR find-or-create, rework reuse, informational reviews/comments, merge-to-Done grant precedence, and two undefined transitions (D4) | A closed-unmerged PR and a merge observed while a Round is open are each recorded as an explicit undefined transition with the observed data, leaving Ticket status completely unchanged — no transition is invented for either case. |

This table is now complete for M1; the gate-report slice
([#29](https://github.com/cristoforows/ticketIt/issues/29)) reconciled it
against [docs/integration-feasibility.md](../../integration-feasibility.md)
and [docs/open-decisions.md](../../open-decisions.md).
