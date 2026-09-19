# D3 — Owner-chosen Agents and human-assigned workflow

**Status:** Accepted. The [Owner's decision on #13](https://github.com/cristoforows/ticketIt/issues/13#issuecomment-5743245026)
rejects template-based Agent restrictions, approves the human-assigned workflow and
existing execution/field-lock rules, and allows temporary MVP implementation limits.
This revision of [PR #30](https://github.com/cristoforows/ticketIt/pull/30) records that
decision in place of the original restrictive proposal.

## Scope and invariants

This decision answers assignment, human workflow, reassignment, and manual-status
questions for M2, M4, and M8. It does not resolve D2 (review/merge evidence), D4
(exceptional PRs and repository/template changes after delivery), or D5 (stranded
runner recovery).

- The Owner chooses the Assignee. Templates supply presentation, information, and
  default completion conditions; they do not whitelist execution engines.
- Tickets remain generic. No permanent work-type or one-capability-per-Ticket rule
  is introduced.
- Assignment and reassignment never change the Ticket's completion condition.
- A Round can contribute to a Ticket without completing the entire Ticket.
- Human assignment never launches automation. An unarchived Ready Ticket with an
  Agent requests execution in either order, subject to required-input validation.
- Open-Round field locks, live Permissions, confirmed Stop, and explicit requeue
  remain in force. Best-effort work does not bypass these controls.

## 1. Assignment and execution prerequisites

### Accepted matrix: Owner chooses the Assignee

Every cell below permits assignment when no Round is open. "Allowed" is not a
guarantee that an engine can finish the requested work or that execution can begin
without its inputs and Permissions.

| Template | Human Assignee | Native-research Agent | OpenCode-coding Agent |
| --- | --- | --- | --- |
| **Basic** (human acceptance) | Allowed. Title alone is sufficient for manual Ready/In Progress. | Allowed. Agent readiness requires goal and Success Criteria. | Allowed. Agent readiness requires goal and Success Criteria; repository-targeted coding also requires the selected repository and configured checkout. |
| **Coding** (reviewed PR merged) | Allowed. Title alone is sufficient for manual Ready/In Progress; completion still needs the retained PR-merge condition. | Allowed, including investigation before implementation. Goal and Success Criteria are required for Agent readiness; a research contribution does not complete the Ticket. | Allowed. Agent readiness requires goal and Success Criteria; repository-targeted coding also requires the selected repository and configured checkout. |

Separate three checks:

1. **Assignment:** never reject an Agent merely because of the Ticket Template or
   the Agent's advertised research/coding capability. This applies in Backlog, Ready,
   and reassignment after delivery. An open Round still locks the Assignee field.
2. **Readiness:** preserve goal and Success Criteria before Ready + Agent-assigned
   requests work. Validate the same required inputs whichever condition becomes true
   second. Missing inputs remain an explicit validation failure, not an exemption
   from readiness or a hidden template/engine restriction.
3. **Action prerequisites:** repository-targeted coding needs one selected repository
   mapped to a configured checkout and the necessary authority. That information
   must be available on either template when needed. Reuse one Ticket repository
   reference; do not introduce a competing Basic-only repository concept. Research
   on a Coding-template Ticket does not require a checkout merely because of the
   template; validate repository access when the requested action actually needs it.

An Agent attempts the requested work using available capabilities, makes reasonable
assumptions within scope, and asks for necessary information or access through the
existing same-Round input flow. It reports useful contributions and unmet Success
Criteria honestly. If it cannot complete the requested work after reasonable
attempts, the existing Failed/Blocked flow applies. Delivery still enters In Review;
it never lets the Agent declare the Ticket Done.

Example: a Researcher investigates a Coding Ticket and delivers findings. The Owner
reviews them, reassigns to a Coder after the Round ends, and explicitly requeues.
The second Round implements the change. The Ticket retains both results and remains
subject to reviewed-PR-merge completion throughout. Conversely, coding work on a
Basic Ticket retains human acceptance as its completion condition.

### Options and consequences

- **Option A — template-gated assignment (rejected by Owner):** reject Basic/Coder
  and Coding/Researcher combinations. This simplifies a narrow initial UI but forbids
  useful investigation and handoff workflows and turns templates into engine rules.
- **Option B — Owner-chosen assignment (accepted):** allow all six combinations,
  retain action/input validation, and let Agents attempt useful work. Completion
  stays independent. This requires exposing relevant inputs beyond template defaults
  and handling imperfect results honestly rather than predicting success upfront.

Temporary MVP implementation limitations are acceptable when a path is not yet
implemented or supporting it adds complexity. Surface the concrete limitation and
record follow-up work; do not encode it as a permanent template/Agent prohibition or
silently claim unsupported behavior works. An unavailable runtime can prevent actual
execution without making the Owner's assignment invalid by design.

## 2. Human-assigned workflow

Human work creates no execution Round. A currently human-assigned Ticket can still
retain Rounds, Reports, PR links, and usage from an earlier Agent assignment; none
of that history is erased. The following owner transitions apply with no open Round.

| From | To | Allowed | Notes |
| --- | --- | --- | --- |
| Backlog | Ready | Yes | Title alone is sufficient for a human Assignee. |
| Ready | Backlog | Yes | Owner withdraws readiness. |
| Ready | In Progress | Yes | Owner marks the start of their own work. |
| In Progress | Ready | Yes | Owner pauses or backs out. |
| In Progress | Blocked | Yes | Owner marks their own work stuck; no fake Round is created. |
| Blocked | In Progress | Yes | Owner resumes human work when unblocked. |
| In Progress | In Review | Yes | Owner marks their work ready for review/completion. |
| In Review | In Progress | Yes | Manual rework; no new execution Round. |
| In Review | Done (human-acceptance condition) | Via explicit Accept | Same owner action as acceptance of Agent-delivered work. |
| In Review | Done (reviewed-PR-merge condition) | Not via plain status-set | Use the shared evidence mechanism selected by D2. |
| Done | Ready | Yes, subject to D4 for an already-merged PR | Reopening never restores expired ticket-based Permissions. |
| Other skips, such as Backlog → In Progress/Done or Ready → In Review/Done | Rejected | Follow the manual sequence and completion condition above. |

**Manual Blocked options:** Option A permits the Owner to mark human work Blocked
(accepted); Option B reserves Blocked solely for Agent execution (rejected). The
accepted rule provides a way to report external obstacles without fabricating a
Round. It does not add a manual Blocked override for Agent-assigned work.

### Completing human work that requires a reviewed PR merge

- **Option 1 — owner-recorded PR link plus observed merge (recommended to D2):** reuse
  the same review/merge evidence path as Agent-delivered PRs. Consistent evidence is
  the benefit; GitHub observation must be implemented before it can be used.
- **Option 2 — explicit owner attestation (alternative for D2):** simpler and usable
  without automatic observation, but evidence is weaker unless it is also the shared
  Agent-delivery rule. Do not introduce a separate shortcut solely for human work.

**Accepted D3 rule:** use whichever review/merge evidence mechanism D2 selects for
both human- and Agent-assigned Tickets. D3 does not select observation versus
attestation or treat a merge fact alone as proof of human review. M8 implements that
shared mechanism. Until it exists, reject completion of a Ticket requiring reviewed
PR merge with an explicit current-implementation reason; do not silently downgrade
the condition. Human-acceptance Tickets can complete independently in M2.

## 3. Reassignment before and after delivery

| Round state | Reassignment |
| --- | --- |
| Any open Round, including claimed-but-not-started, Waiting for Input, or disconnected | Rejected until the Round ends; the Assignee field remains locked. |
| No open Round, including after delivery or human work | Allowed between human and Agent or between Agents, regardless of Template. Retain history and completion condition. |

- Reassignment outside Ready does not request execution. Reassignment to an Agent
  while Ready does request execution when required-input validation passes.
- Recheck readiness and actual execution prerequisites, never a template/capability
  whitelist. For example, a title-only human Ready Ticket still needs goal and
  Success Criteria before it can request Agent work.
- In Review, changing the Assignee does not itself begin rework. Agent rework still
  requires explicit return to Ready; human rework follows the manual table.
- Preserve previous Round results and usage across handoffs. D4 still owns changing
  the repository/template after delivery and exceptional PR transitions; ordinary
  reassignment is not deferred wholesale to D4.

**Options:** reject changes during an open Round (accepted) or queue a hidden future
reassignment (rejected). The accepted choice preserves the visible field-lock
contract. Waiting to reassign is an execution-consistency rule, not a restriction on
which Agent the Owner may choose afterward.

## 4. Manual moves on Agent-assigned Tickets

| Attempted owner action | Rule |
| --- | --- |
| Manually set In Progress or In Review | Rejected; execution start and delivery own those transitions. |
| Manually set free-form Blocked | Rejected; Agent-side Blocked follows Waiting for Input, Failed, or Interrupted. |
| Force Done without the retained completion condition | Rejected; explicit Accept or D2's reviewed-merge evidence must apply. |
| Edit Ticket fields during an open Round | Rejected, including Assignee and Recipe links. |
| Force Backlog/Stopped for an open Round | Rejected; Stop must be requested and cessation confirmed. |
| Start a Round bypassing Ready | Rejected; Ready + Agent-assigned remains the request path. |

Owner actions remain available through their existing paths: Ready/Backlog changes
when no Round is open, View, answer/Permission approval, Stop request, explicit rework,
Accept for human-acceptance Tickets, reassignment when unlocked, and archive when no
Round is open. Archive/restore retain their existing rules.

**Options:** retain strict execution-owned transitions (accepted), or allow an
emergency manual override for an abandoned runner (not adopted here). The latter
could falsely declare cessation while work remains active. D5 owns stranded-runner
recovery; this decision does not invent an override or weaken confirmed Stop.

## Implementation rules and verification examples

| Rule / example | Owning milestone |
| --- | --- |
| Title-only human Ready; manual Blocked/resume; explicit Accept; rejected status skips | M2 |
| All six assignment combinations allowed by design; no template-based rejection in Backlog or reassignment | M4 |
| Required goal/Success Criteria enforced for either Ready/assignment order | M4 |
| No reassignment during any open Round; unlocked handoffs retain completion and Round history | M4, with M5 waits/recovery |
| Coding Ticket → Researcher findings → review → Coder reassignment → explicit requeue | M7/M8 composition |
| Basic Ticket → Coder with repository inputs → delivery → explicit human acceptance | M8 |
| Shared human/Agent reviewed-merge completion evidence, with no early manual Done shortcut | M8 after D2 |
| Concrete MVP limitations surfaced with follow-up work instead of permanent assignment rules | Each implementing milestone |

These are requirements and verification examples, not claims that application code
or runtime tests already implement this decision.

## Routing: remaining decisions

- **D2:** human-review evidence and merge authority, including observation versus
  attestation. Choose once for both assignee kinds; still owned by M8.
- **D4:** closed-unmerged PRs, reopening after merge, merge during a Round, and
  repository/template changes after delivery. Preserve prior work; still owned by M8.
- **D5:** stranded runner and stop recovery. Open-Round locks and confirmed cessation
  remain required; still owned by M5.
- Other model/provider, permission-enforcement, and execution-limit choices remain
  tracked in [open-decisions.md](../open-decisions.md). Permissive assignment is not
  a decision to bypass authority checks or declare a failed integration gate passed.
