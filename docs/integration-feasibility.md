# Integration feasibility

Read-only documentation/source review, 18 September 2026. These findings inform [M1 — Foundational decisions and integration proofs (#2)](https://github.com/cristoforows/ticketIt/issues/2) in the approved [implementation plan](implementation-plan.md). No runtime experiments, model calls, or GitHub delivery tests have been executed for this review.

Upstream `dev`/`main` source can differ from released packages. Pin versions and reproduce findings before relying on them.

## Evidence and limits

| Area | Evidence | Limit to verify |
| --- | --- | --- |
| Managed OpenCode | [SDK](https://opencode.ai/docs/sdk/) and [server helper source](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/server.ts) show starting a headless server/client and closing the process. | Requires installed executable and Michelin supervision. Helper inherits environment; worktree routing and environment/config isolation need explicit handling. |
| Events, questions, permissions | [Server API](https://opencode.ai/docs/server/) and [generated v2 types](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/v2/gen/types.gen.ts) expose events, pending questions/permissions, replies, and message/status queries. | SDK prose and generated versions differ. SSE alone is not durable replay or exactly-once delivery. Pending-wait recovery needs a pinned-version test. |
| Cancel versus pause | SDK exposes `session.abort`; [execution source](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/prompt.ts) implements cancellation. | No general documented guarantee that abort can be resumed at the exact suspended point. Do not treat another prompt as automatic same-round continuation after process failure. |
| Tool interception | [Plugins](https://opencode.ai/docs/plugins/) expose async `tool.execute.before`; [tool source](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/tools.ts) applies hooks to registered tools and ordinary MCP tools. | Hooks run inside OpenCode, not the remote SDK. Universal coverage is unproven for direct shell APIs, prompt file reads, provider-executed tools, and model-only continuation. |
| Live grants | [Native permissions](https://opencode.ai/docs/permissions/) support allow/ask/deny and approval responses. | Engine once/always choices are not ticketIt's ticket/time grant model. Broad allow or remembered approvals may bypass new authority checks unless the integration supplies admission control. |
| Configuration and skills | [Config](https://opencode.ai/docs/config/) and [skills](https://opencode.ai/docs/skills/) support prompts, models, agents, and discovered skills. | Ambient/global/project config and on-demand skill reads do not establish immutable per-round inputs. OpenCode file rollback snapshots are not agent-configuration snapshots. |
| OpenCode usage | Generated types include costs and input/output/reasoning/cache token fields on assistant/step records. | Avoid double-counting overlapping totals. Aborted calls, auxiliary work, and provider billing completeness need reconciliation. |
| LangChain human input | [HITL](https://docs.langchain.com/oss/javascript/langchain/human-in-the-loop) and [LangGraph interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) support checkpointed pauses and resume. | Use durable storage, not only memory. Interrupted nodes may restart from the beginning; effects before an interrupt can repeat. App recovery policy still governs actual process death. |
| OpenRouter integration | [ChatOpenRouter](https://docs.langchain.com/oss/javascript/integrations/chat/openrouter) documents tools, streaming, plugin settings, and token usage; [web search](https://openrouter.ai/docs/guides/features/plugins/web-search) supplies URL citations. | Verify raw citations/costs in the selected streaming path. Search occurs inside provider calls and may be an already-dispatched remote action rather than a separately intercepted local tool. |
| OpenRouter accounting | [Usage accounting](https://openrouter.ai/docs/guides/guides/usage-accounting) and the [LangChain adapter source](https://github.com/langchain-ai/langchainjs/blob/main/libs/providers/langchain-openrouter/src/chat_models/index.ts) expose provider/normalized data. | Normalized token metadata is not a guarantee that cost, cache-write tokens, usage-only SSE chunks, or search-cost breakdown survive. Preserve raw provenance and explicit unknowns. |
| GitHub identities | [OAuth](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), [fine-grained PATs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens), and [PR APIs](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request) support separate owner login and account actions. | Fine-grained token resource-owner/collaborator limitations matter. API token scopes do not constrain separate SSH credentials. Human-review evidence needs an explicit product rule. |

## Interpretation for ticketIt

- A ticketIt round, OpenCode session, and LangGraph thread have distinct identities and lifecycles.
- Disconnect control means preventing new supported actions, not undoing already-dispatched effects. Preventing model continuation requires more than a tool-only hook.
- Galley owns temporary grants. A single engine dispatch approval may use a one-call response internally while the application grant remains reusable until Done or expiry.
- V1 direct-host execution knowingly lacks container isolation. Worktrees do not sandbox shell commands. Document exactly what the supported action boundary enforces and where host trust remains.
- Saving a configuration snapshot is insufficient unless the engine actually uses the fixed content rather than rereading mutable ambient files.
- No selected library replaces ticket ownership checks, round accounting, human review, or idempotent side-effect handling.

## Planned feasibility experiments

Use deterministic local model/API stubs, synthetic credentials, fake clocks, and dispatch ledgers first. These are tests to build, not tests already passed.

M1 runs bounded adapter proofs using controlled substitutes for application interfaces that do not yet exist. It does not require the completed Swiftlet/Galley/Michelin application. Exercise the corresponding application behavior through controlled Rounds in M4–M6, then verify the actual native and OpenCode integrations in M7 and M8. Release acceptance across the deployed application belongs to M10.

### S1 — OpenCode lifecycle and control

Start a pinned executable/SDK pair in the chosen worktree. Emit text, a question, and a tool request from a stub model; reply through the SDK and retain the round ID. Drop/reconnect events and recover pending state without duplicates. Abort blocked/running work and check observed process/tool state before reporting Stopped. Kill the execution process and verify Interrupted/Blocked with no automatic new round.

### S2 — Live permission and disconnect admission

Disconnect Galley before dispatch, during an action, during approval wait, and between parallel requests. Assert zero new supported admissions while offline; already-dispatched work may finish. On reconnect, expired/revoked grants or pending Stop must prevent stale continuation. A new valid grant permits the same intact round to continue.

Test every enabled registered/custom/MCP tool, direct API path, model-only continuation, and Git/SSH operation. Explicitly investigate nested shell and provider-search boundaries. Unsupported required interception is a failed integration gate, not permission to silently weaken the spec.

### S3 — Fixed inputs and durable human input

Start with settings, skill, and recipe versions A. Pause, publish B, then resume: subsequent requests and skill reads still use A; a new round uses B. Repeat with conflicting ambient OpenCode configuration. Reload native checkpointed state and recover its pending question; duplicate replies must not repeat an observable side effect. Apply the application's explicit process-death recovery rule even if framework state can be reloaded.

### S4 — OpenRouter payload fidelity

Exercise actual adapter paths with JSON/SSE fixtures containing tools, URL citations, Unicode offsets, reasoning/cache fields, reported cost, usage-only final chunks, and truncated streams. Verify persistence through checkpoints and Galley ingestion. Deduplicate observations and distinguish aggregate reported cost from unavailable search-cost breakdowns. Follow with a controlled real selected-model smoke test before research acceptance.

### S5 — GitHub delivery and identity

Mock OAuth sign-in, PAT identity, PR creation/update, review/comments, and merge events; use a fake Git/SSH transport. Verify owner restriction, separate credentials, connected identity, draft creation, repeat-request reconciliation, branch/PR reuse, informational feedback, and qualifying-merge completion. Apply current grants to subsequent controlled API and Git admissions. Follow with an authorized fixture-repository delivery test before coding acceptance.

## Gate outcome

Record exact versions, fixtures, observed limitations, and test results when experiments run. S2 is the highest-priority uncertainty. If a required behavior fails, propose an integration mechanism or raise the corresponding [open decision](open-decisions.md); do not claim the behavior is delivered or substitute abort/restart for pause without agreement.
