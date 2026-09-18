# D3 — Agent/Template compatibility and human-assigned workflow rules (proposal)

**Status:** Proposed, awaiting Owner decision on [#13](https://github.com/cristoforows/ticketIt/issues/13).
This document is a draft. It does not resolve D3; the Owner resolves it by approving
options here (or requesting changes) on #13. See [open-decisions.md](../open-decisions.md).

## Scope

Answers the four sub-questions in #13 for v1 only:

1. Supported Agent capability x Ticket Template combinations.
2. The human-assigned manual workflow, including reaching Done for a reviewed-PR-merge
   completion condition without an Agent.
3. Reassignment (human<->Agent, Agent<->Agent).
4. Manual status changes that must be rejected on Agent-assigned Tickets because
   execution owns them.

It does **not** resolve D2 (human-review evidence and merge authority) or D4 (exceptional
PRs and template/repository changes after delivery). Both are explicitly routed, not
answered, in [Routing](#routing-d2-and-d4-not-resolved-here).

## Invariants held by every option below

- The Agent never determines completion. Completion is always an owner action (accept,
  or an observed/attested merge) or a system observation, never an Agent's self-report.
- No work-type enum. "Capability" (native research, OpenCode coding) is a property of an
  **Agent**'s execution engine, not a new classification on the **Ticket** or **Template**.
- Tickets stay generic; templates supply presentation, required fields, and the default
  completion condition, not a permanent execution binding.
- A Ticket's completion condition is independent of its Assignee and is never changed by
  assignment, reassignment, or engine capability.
- Human assignment never launches automation.
- Ready plus Agent assignment requests execution regardless of which condition became
  true first, and the same validation applies regardless of order.

## 1. Eligibility matrix: Agent capability x Ticket Template

An Agent's execution engine declares one capability in v1: **native research** or
**OpenCode coding**. The eligibility check runs at every point that could request or
change execution: Agent assignment, Ready transition, and reassignment — not only at
Ticket creation.

### Recommended matrix (Option A)

| Template | Human Assignee | Native-research Agent | OpenCode-coding Agent |
| --- | --- | --- | --- |
| **Basic** (completion: human acceptance) | Eligible. No extra prerequisite; title alone is sufficient for Ready and In Progress. Manual-guidance fields (goal, context, Success Criteria, constraints) are recommended, not enforced, for a human Assignee. | Eligible. Prerequisites: goal and Success Criteria present (required for Ready + Agent-assigned in either order, per `ticket-creation.md`). | **Rejected.** Reason: Basic has no repository-selection field; OpenCode-coding cannot execute without a selected target repository. |
| **Coding** (completion: reviewed PR merged) | Eligible. No extra prerequisite enforced at Ready; the human does the work outside Michelin and records the PR themselves (§2). Repository field can be filled for reference but does not block a human Assignee. | **Rejected.** Reason: native research cannot deliver or merge a pull request, so it can never satisfy this Template's completion condition — rejected even when goal, Success Criteria, and a repository are all present. | Eligible. Prerequisites: goal, Success Criteria, and one selected target repository mapped to a configured local checkout. |

Rejections are honest failures at the moment they are triggered (assignment,
reassignment, or Ready), with the reason above surfaced to the owner — never a silent
no-op and never a downgraded/partial acceptance.

### Alternative considered (Option B) — decouple repository from Template

Add "repository" as a Ticket-level attribute available on any Template, so
OpenCode-coding could be assigned to a Basic Ticket too (completion would stay human
acceptance even though a PR was produced).

- **For:** lets the owner use a lightweight Basic Ticket for a small coding task without
  adopting Coding's stricter reviewed-PR-merge gate.
- **Against:** breaks the Template <-> completion-condition <-> capability alignment — a
  Basic Ticket could get an open, unmerged PR "accepted" with no merge requirement,
  expanding the D2 evidence question to Basic Tickets too. Adds a second, competing
  repository concept alongside Coding's repository section. Not requested by any user
  story; v1-scope only describes repository selection on Coding Tickets.
- **Recommendation:** reject for v1. Revisit only alongside a future custom-template
  system (deferred beyond v1).

Also considered and rejected: letting a native-research Agent run supplementary
research on a Coding Ticket without owning completion. v1 keeps one capability per
Ticket at a time; this is deferred rather than solved by loosening the matrix.

## 2. Human-assigned workflow

### Manual transitions (human-assigned Tickets)

No Round ever exists for a human-assigned Ticket, so every transition below is a plain
owner-performed status change — there is no execution-owned state to defer to.

| From | To | Allowed | Notes |
| --- | --- | --- | --- |
| Backlog | Ready | Yes | Title alone is sufficient (§1). |
| Ready | Backlog | Yes | Owner can un-ready before starting. |
| Ready | In Progress | Yes | Owner marks the start of their own work (glossary: "human assignees mark the start themselves"). |
| In Progress | Ready | Yes | Owner can pause/back out. |
| In Progress | Blocked | Yes (Option A, recommended) | Owner self-reports being stuck on something external. No Round exists, so this is a plain manual flag, not a Round-state consequence. |
| Blocked | In Progress | Yes | Owner resumes when unblocked. |
| In Progress | In Review | Yes | Owner marks their own work finished and awaiting the completion condition. |
| In Review | In Progress | Yes | Manual rework — owner resumes further work. No new Round object is created because none ever existed. |
| In Review | Done (Basic) | Yes, via explicit **Accept** | Same "human acceptance" action used for Agent-delivered work; always an owner action regardless of Assignee. |
| In Review | Done (Coding) | No, via plain status-set | Only reachable through the observed/attested-merge mechanism below — identical rule for human- and Agent-assigned Coding Tickets. |
| Done | Ready | Yes (reopen) | Symmetric with the Agent-assigned reopen case; does not restore any already-expired ticket-based Permission (N/A here — those are Agent-specific). |
| Any other skip (e.g. Backlog -> In Progress/In Review/Done, Ready -> In Review/Done) | — | **Rejected** | Must proceed through the canonical sequence above; prevents silently declaring work started/reviewed/done. |

**Blocked as a plain manual flag (Option A) vs. round-only (Option B):** the glossary's
Blocked definition ("...including one whose Round is Waiting for Input, Interrupted, or
Failed") uses "including," which leaves room for other causes. Option A adds a genuine
manual Blocked for human-assigned Tickets (recommended above) so the owner has a way to
flag being stuck without inventing a fake Round. Option B would disallow manual Blocked
entirely, keeping Blocked strictly Round-derived and forcing the owner to just leave the
Ticket In Progress or step it back to Ready/Backlog instead. Recommendation: Option A —
low-risk, useful, and keeps human/Agent lifecycles symmetric. **This is a genuinely new
rule, not implied verbatim by existing docs — flagged for explicit Owner sign-off.**

### Reaching Done without an Agent when completion requires a reviewed PR merge

Two options, as named in #13:

- **Option 1 (recommended): owner-recorded PR link + observed merge.** The owner links
  a PR they authored/merged themselves to the Ticket. The same "observed merge"
  evidence mechanism planned for Agent-delivered PRs (owned by D2/M8) also watches this
  link and moves the Ticket to Done when the PR is observed merged. *Consequence:*
  completion evidence is identical for human- and Agent-assigned Coding Tickets — the
  cleanest reading of "completion condition independent of Assignee." *Cost:* this
  mechanism does not exist before M8 ships; until then Galley must reject a manual Done
  attempt on any Coding Ticket (human- or Agent-assigned) with an explicit reason,
  rather than allowing it early via a different code path.
- **Option 2: explicit manual attestation.** The owner clicks a "Confirm merged"
  action, self-attesting completion with no automated verification. *Pros:* simplest,
  no dependency on GitHub observation, works for any future non-GitHub delivery.
  *Cons:* weaker evidence than the Agent path (unless D2 also lands on attestation for
  agent-authored PRs, in which case Option 2 becomes the shared rule instead), and adds
  a second completion code path alongside Option 1's.
- **Recommendation:** Option 1, contingent on D2. If D2 instead settles on manual
  attestation for agent-authored PRs (plausible, since the owner is often the same
  GitHub identity that would "review" them — see D2's problem statement), the same
  attestation action should be reused for the human-assigned case rather than building
  a second mechanism. **D3 does not pick between Option 1 and Option 2 in isolation —
  it picks "reuse whatever D2 decides," and asks D2 to decide once for both assignee
  kinds.**

## 3. Reassignment

| Round state | Reassignment allowed? |
| --- | --- |
| Round open (In Progress; or Blocked because its Round is Waiting for Input) | **No.** Ticket fields, including Assignee, are locked until the Round ends (existing rule — `ticket-views.md`, `agent-execution.md`: "Changing the goal, success criteria, assignee, linked recipes, or other ticket fields requires ending the round first"). Owner must Stop the round, or let it deliver/fail/get interrupted, first. |
| No open Round (Backlog; Ready; In Review; Blocked from Failed/Interrupted or the new manual human-Blocked flag in §2; Done) | **Yes.** |

Rules that hold across every reassignment:

- The completion condition always comes from the Template and is never copied, altered,
  or reset by reassignment (human<->Agent or Agent<->Agent).
- Reassignment alone never requests execution. Only Ready + Agent-assigned (in either
  order) does (existing Assignee glossary rule).
- Reassignment is checked against the §1 eligibility matrix **immediately, at
  assignment time**, regardless of current status — not deferred until a later Ready
  attempt. An Agent whose capability the matrix marks rejected for the Ticket's Template
  (e.g., a native-research Agent onto a Coding Ticket) cannot be assigned at all, ever,
  on that Ticket. This is simpler and more honest than allowing an invalid combination
  to sit "pencilled in" until it fails later at Ready.

This section mostly restates existing, already-approved invariants rather than
introducing new choices — the two "options" the issue names for the open-Round case
(reject outright vs. queue the change for after the Round ends) resolve the same way:
queuing a hidden pending change would contradict the existing "fields are read-only
while a Round is open" rule, so only outright rejection is proposed.

## 4. Manual moves rejected on Agent-assigned Tickets

| Manual action attempted | Outcome | Reason |
| --- | --- | --- |
| Set status to In Progress | Rejected | Round start (execution) owns this transition. |
| Set status to In Review | Rejected | Round delivery (execution) owns this transition. |
| Set status to Blocked, other than because the Round is Waiting for Input / Interrupted / Failed | Rejected | Agent-assigned Tickets have no manual self-Blocked concept — contrast the new human-assigned manual Blocked in §2. |
| Set status to Done on a Coding-template Ticket without an observed/attested PR merge | Rejected | Same evidence gate as §2, independent of Assignee. |
| Edit any ticket field (goal, Success Criteria, Assignee, linked Recipes, etc.) while a Round is open | Rejected | Fields are locked until the Round ends. |
| Force Backlog + Stopped badge directly | Rejected | Only reachable through explicit Stop request followed by Michelin's confirmed stop. |
| Start a new Round directly, bypassing Ready | Rejected | Ready + Agent-assigned (either order) is the only execution-request path. |

For contrast, owner actions that **remain available** on an Agent-assigned Ticket:
Ready<->Backlog toggling before execution starts; the explicit Stop-round request;
explicit rework requeue (In Review -> Ready); Accept on a Basic Ticket (In Review ->
Done); reassignment when no Round is open (§3); archiving when no Round is open.

**Options considered for this sub-question:**

- **Option A (recommended): strict, no override.** All the rejections above are
  absolute; the owner's only escape hatches for a stuck Round are Stop (with
  confirmation) and, after Failed/Interrupted, returning to Ready for a new Round.
- **Option B: a narrow emergency override**, letting the owner force a stuck
  Agent-assigned Ticket back to Backlog/Blocked without a confirmed Stop, for a runner
  that is permanently gone. More resilient to an abandoned runner, but risks a false
  "stopped" confirmation and duplicate execution if the runner later reconnects —
  directly conflicting with D5's stranded-runner invariant ("no automatic duplicate
  execution or false stop confirmation").
- **Recommendation:** Option A. The abandoned-runner case is D5's problem
  (Stranded runner and stop recovery); an override here would preempt or duplicate that
  decision rather than solve it. D3 does not attempt to resolve D5.

## Consolidated rules table (for M2, M4, M8)

1. **Eligibility matrix** — §1 table. Enforce at Agent assignment, at Ready transition,
   and at reassignment; whichever of Ready/assignment happens second must re-check.
2. **Human-assigned manual transition table** — §2 table, including the new manual
   Blocked flag and the Accept-only Basic Done path.
3. **Coding Done evidence gate** — applies identically whether the Ticket is human- or
   Agent-assigned: no plain manual Done on a Coding Ticket without observed/attested
   merge (mechanism finalized by D2, built in M8).
4. **Rejected-manual-move list for Agent-assigned Tickets** — §4 table.
5. **Reassignment rule** — allowed only when no Round is open; always re-validates
   against the eligibility matrix immediately; never changes the completion condition.

Owning milestones: M2 implements the human-assigned transition table and the Basic
Accept-to-Done path; M4 implements the eligibility matrix at assignment/Ready and the
Agent-assigned rejected-move list; M8 implements the Coding Done evidence gate for both
assignee kinds once D2 is resolved.

## Routing: D2 and D4 (not resolved here)

- **D2 — Human-review evidence for PR completion and agent merge authority.** §2's
  Option 1 vs. Option 2 choice for the human-assigned Coding Done path depends directly
  on D2's outcome; D3 recommends reusing whichever mechanism D2 selects for both
  assignee kinds instead of building two. D2 remains open and is owned by
  [M8 review/merge implementation](https://github.com/cristoforows/ticketIt/issues/9).
- **D4 — Exceptional PRs and template/repository changes after delivery.** Changing the
  selected repository or Template after a Ticket already has a delivered/open PR (for
  either assignee kind), closed-unmerged PRs, reopening after merge, and a merge
  arriving mid-Round are all explicitly out of scope here and remain owned by
  [M8 coding lifecycle](https://github.com/cristoforows/ticketIt/issues/9). D3's rules
  above assume delivery has not yet started; D4 governs what happens once it has.
- **D5 — Stranded runner and stop recovery**, mentioned only in passing in §4's
  Option B discussion, is not resolved or reopened here; it remains owned by
  [M5 controlled recovery](https://github.com/cristoforows/ticketIt/issues/6).

## Assumptions and interpretations to flag for the Owner

- Read `ticket-creation.md`'s goal/Success-Criteria gate as scoped specifically to
  "Ready + Agent-assigned," not to human Ready — so a human-assigned Ticket can be
  Ready/In Progress on a title alone. This is a literal reading of existing docs, not a
  new invention, but is worth the Owner explicitly confirming.
- Added a genuine new rule: a manual Blocked flag for human-assigned Tickets (§2),
  since the glossary's Blocked definition is otherwise Round-centric. Flagged
  explicitly above for sign-off; reject it (Option B in §2) if undesired.
- Chose to validate the eligibility matrix immediately at assignment time rather than
  deferring an "invalid" combination until a later Ready attempt (§3), for honesty over
  convenience.
- Recommended unifying human- and Agent-assigned Coding Done evidence into one
  mechanism instead of two — a substantive recommendation for D2 to build on, not a
  resolution of D2 itself.
