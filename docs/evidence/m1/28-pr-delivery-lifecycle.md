# M1.17 — Draft PR delivery lifecycle with mocked reviews and merge

## Purpose

Prove, with local fixtures only, the delivery half of feasibility
experiment S5 ("GitHub delivery and identity",
`docs/integration-feasibility.md`): "Mock OAuth sign-in, PAT identity, PR
creation/update, review/comments, and merge events; use a fake Git/SSH
transport. Verify owner restriction, separate credentials, connected
identity, draft creation, repeat-request reconciliation, branch/PR reuse,
informational feedback, and qualifying-merge completion." This is
[M1.17 — Draft PR delivery lifecycle with mocked reviews and merge
(#28)](https://github.com/cristoforows/ticketIt/issues/28), extending
[#27](https://github.com/cristoforows/ticketIt/issues/27)'s
`experiments/github-delivery/` package (see
`docs/evidence/m1/27-github-identity.md` for the identity half — sign-in
restriction, PAT resource-scope gating, and the fake SSH transport,
unchanged here).

Specifically, this slice establishes with deterministic fixtures that:

- A `DeliveryModule` (`src/delivery-module.ts`) can commit, push over the
  fake SSH transport, and find-or-create exactly one draft GitHub PR per
  ticket branch, carrying a change summary, tests/results, and a Success
  Criteria assessment (`docs/v1-scope.md`, "Deliverables and review";
  `docs/agent-execution.md`, "Coding deliverables").
- Repeating the same delivery request finds the existing PR rather than
  creating a duplicate (list-before-create).
- Rework after an explicit requeue reuses the same branch and PR,
  updating it with a new commit, while every prior Round's delivery
  remains retained and distinct (`docs/v1-scope.md`: "Rework reuses
  branch/worktree/PR until merge. Each round retains its delivered commit
  and result.").
- GitHub reviews (including an APPROVED review) and comments are
  observed and recorded as purely informational — they never change
  Ticket status or start/close a Round
  (`docs/agent-execution.md`, "Coding deliverables": "GitHub reviews and
  comments are informational in the first iteration, including a
  submitted Request changes review.").
- A merge, observed with no open Round, moves the Ticket to Done and
  permanently ends its ticket-based grant while an unrelated time-based
  grant for the same Agent survives
  (`docs/contracts/execution-interface.md`; `docs/v1-scope.md`,
  "Permissions and accounts").
- Reopening a Done Ticket does not restore its ticket-based grant.
- A closed-unmerged PR, and a merge observed while a Round is open, are
  each recorded as an **undefined transition** with the observed data —
  open decision **D4** (`docs/open-decisions.md`) is not resolved here;
  status is never changed and no transition is invented.
- With the ledger disconnected, `DeliveryModule.deliver()` refuses before
  any API call or push.

Relevant open decisions per `docs/open-decisions.md` (read only, not
edited — see "Decision impacts" below): **D2** ("Human-review evidence
for PR completion and agent merge authority") and **D4** ("Exceptional
PR and template/repository changes").

## Exact versions

- Node: `v26.9.0` (matches `experiments/.nvmrc` and this package's
  `engines.node`)
- npm: `11.19.1`
- OS: macOS (Darwin 25.6.0), arm64
- git: `2.39.3 (Apple Git-146)`
- `typescript`: `7.0.2` (devDependency, pinned exact)
- `tsx`: `4.23.13` (devDependency, pinned exact)
- `@types/node`: `26.6.1` (devDependency, pinned exact)
- Test runner: Node's built-in `node --test`, loaded via
  `node --import tsx --test`. No `vitest`, no other runtime dependency.
- Runtime dependency graph: `experiments/shared` (`file:../shared`,
  unchanged by this slice) for `FakeClock` and `AdmissionLedger`; every
  other import is a Node built-in (`node:http`, `node:child_process`,
  `node:fs`, `node:os`, `node:path`, `node:crypto`) plus the global
  `fetch`. No new package was added to `experiments/shared` or this
  package's `package.json`/`package-lock.json`.

## Reproducible commands

Run from a clean checkout:

```sh
cd experiments/github-delivery
rm -rf node_modules
npm ci
npm test
npm run typecheck
```

No environment variables, real credentials, or external services are
required. `FakeGitHubApi` binds to `127.0.0.1` on an OS-assigned
ephemeral port; `FakeGitRemote` creates a bare repository and a fake-SSH
script under a temp directory; nothing leaves the loopback
interface/local filesystem and no real GitHub host, port, or SSH key is
used.

Regression-checked (unaffected by this slice, same versions as
[#27](https://github.com/cristoforows/ticketIt/issues/27)'s evidence
record):

```sh
cd experiments/shared && rm -rf node_modules && npm ci && npm test && npm run typecheck
cd ../_template && rm -rf node_modules && npm ci && npm test
cd ../tracer-fake-clock && rm -rf node_modules && npm ci && npm test
```

## Documentation research (unverified)

Findings below are drawn from reading GitHub's published REST API
documentation (fetched 19 September 2026), not from calling the real
GitHub API. They inform `src/fake-github-api.ts`'s modeled fields; they
are **not** verified against a live GitHub response.

- **Create a pull request** (`docs/rest/pulls/pulls#create-a-pull-request`,
  `POST /repos/{owner}/{repo}/pulls`): required body fields `head` ("The
  name of the branch where your changes are implemented") and `base`
  ("The name of the branch you want the changes pulled into"); optional
  `title`, `body`, `draft` ("Indicates whether the pull request is a
  draft"). `src/fake-github-api.ts`'s create endpoint models exactly
  these fields, plus one fixture-only addition: `headSha`. Real GitHub
  has no such input field — it derives the PR's `head.sha` from the
  actual state of the named branch at creation time. This fake API and
  `FakeGitRemote` are two independently fixtures with no channel between
  them (the fake API never inspects the bare git repository), so
  `DeliveryModule` — which just pushed that exact commit — reports the
  sha it observed. This is documented explicitly in
  `src/fake-github-api.ts`'s module comment and repeated in "Observed
  limitations" below; it is this slice's own bridging mechanism, not a
  real GitHub request field.
- **List pull requests** (`docs/rest/pulls/pulls#list-pull-requests`,
  `GET /repos/{owner}/{repo}/pulls`): documented `head` query parameter
  "Filter pulls by head user or head organization and branch name in the
  format of `user:ref-name` or `organization:ref-name`", and `state`
  ("Either `open`, `closed`, or `all`... default: `open`"). The fake
  API's list endpoint parses `head` in exactly that `owner:branch` format
  and defaults `state` to `open`, matching this documented shape.
- **Get a pull request** (`docs/rest/pulls/pulls#get-a-pull-request`,
  `GET /repos/{owner}/{repo}/pulls/{pull_number}`): response fields
  `state`, `draft`, `merged`, `merged_at` ("string or null"),
  `merge_commit_sha`, and `head.sha`. All six are modeled in
  `toPullRequestJson`/`parsePullRequestView`, plus `closed_at` (not
  explicitly confirmed in the fetched excerpt, included by analogy with
  `merged_at`'s null-until-closed shape — see "Observed limitations").
- **Update a pull request** (`docs/rest/pulls/pulls#update-a-pull-request`,
  `PATCH /repos/{owner}/{repo}/pulls/{pull_number}`): modifiable fields
  `title`, `body`, `state`, `base`. This fake API's `PATCH` endpoint
  models `title` and `body` (this slice never needs `state`/`base`
  changes) plus the same fixture-only `headSha` bridging field as
  create — modeling what real GitHub derives automatically when new
  commits land on the PR's head branch. GitHub's webhook documentation
  describes a related real mechanism, the `pull_request` event's
  `synchronize` action, "triggered when the head branch was updated...
  when new commits are pushed to the head branch" (cited from general
  knowledge of GitHub's webhook events documentation, not re-fetched for
  this record — treat this specific citation as **more weakly verified**
  than the fetched pages above); `headSha` on `updatePullRequest` is this
  slice's stand-in for that synchronize effect, given the fake API has no
  webhook/observation channel to the fake git remote.
- **Merge a pull request**
  (`docs/rest/pulls/pulls#merge-a-pull-request`,
  `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge`): request fields
  `merge_method`, `commit_title`, `commit_message`, `sha`; response
  fields `sha`, `merged`, `message`. **Not modeled as an HTTP endpoint at
  all** — see "Observed limitations" below for why (open decision D2:
  Michelin's PAT is never given merge authority in this slice; a human
  merging is simulated with the `injectMerge` test-control helper
  instead, which sets the same `merged`/`merged_at`/`merge_commit_sha`
  fields `GET .../pulls/{number}` documents, but through a direct method
  call rather than replaying the real merge endpoint's request/response
  shape).
- **List reviews for a pull request**
  (`docs/rest/pulls/reviews#list-reviews-for-a-pull-request`,
  `GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews`): "Lists all
  reviews for a specified pull request... in chronological order."
  Response objects include a required `state` field; the fetched excerpt
  did not enumerate the state values in that specific section. This
  slice's `ReviewState` (`"APPROVED" | "CHANGES_REQUESTED" |
  "COMMENTED"`) is drawn from general knowledge of GitHub's pull-request
  review schema, which also documents `PENDING` and `DISMISSED` states
  not modeled here (see "Observed limitations") — this enum is therefore
  **less directly verified** than the fields confirmed in the fetched
  pages above.
- **List issue comments**
  (`docs/rest/issues/comments#list-issue-comments`,
  `GET /repos/{owner}/{repo}/issues/{issue_number}/comments`): "You can
  use the REST API to list comments on issues and pull requests. Every
  pull request is an issue, but not every issue is a pull request." This
  directly confirms `src/fake-github-api.ts`'s design choice to serve PR
  comments from an `/issues/{number}/comments` path rather than a
  `/pulls/{number}/comments` path.
- **404-vs-403 identity/permission gating**: unchanged from
  [#27](https://github.com/cristoforows/ticketIt/issues/27) (see
  `docs/evidence/m1/27-github-identity.md`, "Documentation research")
  and applied identically to every new endpoint in this slice.

## Fixture/stub evidence (observed)

All commands under "Reproducible commands" ran successfully on the
versions above:

- `experiments/github-delivery`: `npm ci` → `added 9 packages, and
  audited 11 packages`, 0 vulnerabilities (same pre-existing npm 11
  `esbuild`/`fsevents` install-script notice as #27's evidence; no
  install-script content was approved or executed). `npm test` →
  **36/36** tests passed across five files (the four from #27 plus the
  new `test/delivery-lifecycle.test.ts`). `npm run typecheck`
  (`tsc -p tsconfig.json --noEmit`) passed with no errors. Re-verified
  from a clean `node_modules` (`rm -rf node_modules && npm ci && npm
  test`): same 36/36 result.
- `experiments/shared`: unchanged by this slice; re-run for regression
  confirmation — `npm ci` → 0 vulnerabilities, `npm test` → **40/40**
  (same as `docs/evidence/m1/27-github-identity.md`), `npm run
  typecheck` passed.
- `experiments/_template`: unchanged; `npm test` → **1/1**.
- `experiments/tracer-fake-clock`: unchanged; `npm test` → **2/2**.
- `git status --porcelain` after all four `npm ci` runs shows no
  `package-lock.json` diff for `shared`, `_template`, or
  `tracer-fake-clock`; only `experiments/github-delivery/`'s source and
  test files changed.

### Public API added

- `src/fake-github-api.ts` (`FakeGitHubApi`): new HTTP endpoints
  `GET`/`POST /repos/{owner}/{repo}/pulls` (list by `?head=owner:branch`
  and `?state=`, create with the fixture `headSha` field, 422 on a
  duplicate open PR for the same head+base), `GET`/`PATCH
  /repos/{owner}/{repo}/pulls/{number}` (get one, update
  title/body/`headSha`), `GET
  /repos/{owner}/{repo}/pulls/{number}/reviews`, `GET
  /repos/{owner}/{repo}/issues/{number}/comments` — every one applying
  the same repository-resource-set 404 and missing-`pull_requests`
  -permission 403 gates as #27's `/pulls` stub. New types:
  `PullRequestView`, `ReviewView`, `IssueCommentView`, `ReviewState`. New
  test-control methods, never recorded in `requestLog()`: `injectReview`,
  `injectComment`, `injectMerge`, `injectClose`. New optional
  `FakeGitHubApiConfig.clock` (a `FakeClock`) for deterministic
  timestamps.
- `src/github-connection.ts` (`GitHubConnection`): new action constant
  `GitHubConnectionActions.PULLS_WRITE` (alongside the existing
  `PULLS_READ`, now also used by the new read methods). New methods,
  each calling `#admitOrThrow` first exactly like every pre-existing
  method: `listPullRequestsByHead`, `getPullRequest`,
  `createPullRequest`, `updatePullRequest` (`PULLS_WRITE`), `listReviews`,
  `listIssueComments` (all four reads: `PULLS_READ`). New types:
  `CreatePullRequestInput`, `UpdatePullRequestInput`.
- `src/delivery-module.ts` (`DeliveryModule`, new file): constructed with
  `{ connection, owner, repo, base, branch, worktree, remote }`.
  `deliver(input)` → `{ commitSha, prNumber, created, pullRequest }`.
  Exported helper `renderPullRequestBody`.
- `src/galley-substitute.ts` (`GalleySubstitute`): new Ticket API —
  `createTicket(ticketId)`, `getTicket(ticketId)`, `startRound(ticketId)`,
  `recordDelivery(ticketId, input)`, `recordFeedback(ticketId, event)`,
  `observeMerge(ticketId, observation)`, `explicitRequeue(ticketId)`,
  `reopen(ticketId)`. New types: `TicketStatus`, `RoundRecord`,
  `FeedbackEvent`, `UndefinedTransitionRecord`, `PrObservation`,
  `TicketView`.

### Test names and pass counts

`test/delivery-lifecycle.test.ts` (10 tests, all passing):

1. `Round 1 delivery creates exactly one draft PR whose body carries summary, tests and results, and the Success Criteria assessment; Galley records the delivered commit; Ticket In Review`
2. `Replaying the same delivery finds the existing PR; PR count stays 1; the Round record is unchanged`
3. `A CHANGES_REQUESTED review and a comment are recorded as informational; status stays In Review; Round count unchanged`
4. `Explicit requeue moves In Review to Ready; Round 2 commits on the SAME branch and updates the SAME PR (number unchanged); both Rounds' delivered commits are retained and distinct; the PR head sha equals Round 2's commit`
5. `Approval alone leaves the Ticket In Review and the ticket-based grant still allowed`
6. `Merge moves the Ticket to Done, the ticket-based grant then denies with ticket-done, and a time-based grant for the same Agent still allows`
7. `Reopen after Done does not restore the ticket grant`
8. `A closed-unmerged PR is recorded in undefinedTransitions with status unchanged`
9. `A merge observed while a Round is open is recorded in undefinedTransitions, status unchanged, Round still open`
10. `With the ledger disconnected, deliver refuses before any API call or push (request log and remote unchanged)`

Plus the 26 pre-existing tests from #27 (`test/fake-github-api.test.ts`,
`test/fake-git-remote.test.ts`, `test/galley-substitute.test.ts`,
`test/github-connection.test.ts`), unmodified and still passing — see
`docs/evidence/m1/27-github-identity.md` for their names.

Total: **36/36** passing (`node --test` summary: `tests 36`, `pass 36`,
`fail 0`).

### Fixture evidence: PR counts, request-log excerpt, body content (test 1)

Captured by exercising `DeliveryModule.deliver()` for Round 1 of a fresh
Ticket (`GET`-then-`POST` — list found nothing, so create ran):

```json
[
  { "method": "GET",  "path": "/repos/acme/allowed-repo/pulls", "tokenKind": "pat", "status": 200 },
  { "method": "POST", "path": "/repos/acme/allowed-repo/pulls", "tokenKind": "pat", "status": 201 }
]
```

`created: true`, `pullRequest.draft: true`, PR count via
`listPullRequestsByHead(..., "all")` → `1`. The created PR's body:

```
## Summary

Fixed the off-by-one in the retry backoff calculation.

## Tests and results

npm test -> 12/12 passing.

## Success Criteria assessment

Meets Success Criteria: retries now stop after the configured max attempts.
```

Galley's Ticket view after this: `status: "In Review"`, one Round with
`deliveredCommitSha` equal to the pushed commit and `prNumber: 1`.

### Fixture evidence: Round 2 rework reuses the same PR (test 4)

After an explicit requeue and a second `startRound`/`deliver()` call on
the same branch, `DeliveryModule.deliver()` found the existing open PR
(`created: false`, same `prNumber: 1`) and updated it. `GET
/repos/{owner}/{repo}/pulls/1` afterward returned:

```json
{
  "number": 1,
  "title": "Fix the flaky retry logic (round 2)",
  "draft": true,
  "state": "open",
  "merged": false,
  "headRef": "ticket-evidence-1-branch",
  "headSha": "33c0f6b41b5d2a2424d2ac5e8307ee29156b3b98",
  "baseRef": "main"
}
```

`headSha` equals Round 2's own delivered commit sha (Round 1's was
`e4e096385f119d331484a711e0515a693faca005` — different from Round 2's,
per assertion). The Ticket's two retained Rounds:

```json
[
  { "roundNumber": 1, "deliveredCommitSha": "e4e09638...", "prNumber": 1 },
  { "roundNumber": 2, "deliveredCommitSha": "33c0f6b4...", "prNumber": 1 }
]
```

### Fixture evidence: merge → Done, grant precedence (test 6)

After `injectMerge(..., { mergeCommitSha: "merge-commit-abc123" })` and
observing it through `GET .../pulls/{number}` (which returned
`mergeCommitSha: "merge-commit-abc123"`, confirming the observed fact
round-trips through the gated read, not just the test-control call),
`observeMerge()` moved the Ticket to `"Done"`. Subsequent admissions on
the SAME ledger:

```json
{ "admissionId": "admission-13", "decision": "deny", "reason": "ticket-done" }
```

for the ticket-based `PULLS_WRITE` grant, and `decision: "allow"` for an
unrelated time-based `VERIFY_IDENTITY` grant for the same
`agentId`/`account` — matching `AdmissionLedger`'s documented precedence
(`sawTicketDone` continues the scan rather than short-circuiting, so an
independent time-based grant for a different action is unaffected).

### Fixture evidence: the two undefined transitions (D4)

Closed-unmerged (test 8), captured from `galley.getTicket(...)` after
`injectClose` + an observed `GET .../pulls/{number}`:

```json
{
  "status": "In Review",
  "undefinedTransitions": [
    {
      "kind": "closed-unmerged",
      "observed": { "merged": false, "state": "closed", "mergedAt": null, "mergeCommitSha": null, "prNumber": 2 },
      "recordedAtMs": 1767225600000
    }
  ]
}
```

Merge observed while a Round is open (test 9), captured after an
explicit requeue + `startRound()` (opening Round 2, never delivered)
followed by `injectMerge` + an observed `GET .../pulls/{number}`:

```json
{
  "status": "In Progress",
  "roundOpen": true,
  "rounds": [{ "roundNumber": 1, "prNumber": 3 }],
  "undefinedTransitions": [
    {
      "kind": "merge-during-open-round",
      "observed": {
        "merged": true,
        "state": "closed",
        "mergedAt": "2026-01-01T00:00:00.000Z",
        "mergeCommitSha": "merged-6c961bacd2940334a0d3ae26eb93d553775b8f1f",
        "prNumber": 3
      },
      "recordedAtMs": 1767225600000
    }
  ]
}
```

In both cases `status` is unchanged from before the observation
(`"In Review"` and `"In Progress"` respectively) and no PR/Round is
invented — matching D4's "Preserve prior deliveries; never infer a new
PR or successful completion without a defined transition."

### Fixture evidence: disconnected ledger refuses before any API call or push (test 10)

With a valid ticket-based grant for every action but
`ledger.setConnected(false)`, `DeliveryModule.deliver()` throws
`AdmissionRefusedError` with `decision: "hold"`, `reason: "disconnected"`
from inside `GitHubConnection.commit()` — the very first gated call
`deliver()` makes. `api.requestLog().length` is `0` afterward (no `fetch`
ever ran) and `remote.revParse("refs/heads/<branch>")` is `null` (no push
ever ran), confirming `ensureBranch()`'s local `git checkout -b` (which
does run, since it is not ledger-gated — a local-only operation) has no
observable effect on the remote or the API.

## Real-provider evidence (observed, or "none executed")

None executed. This slice makes no call to the real GitHub API, no real
PR create/update/merge/review/comment call, and no real SSH/network
connection — the only network activity is loopback HTTP to
`FakeGitHubApi` on `127.0.0.1`, and the only "remote" Git operations are
local (a bare repo under a temp directory), per `experiments/README.md`'s
"No calls to real providers or real repositories" rule and this issue's
"No real credentials, no calls to real providers, no real repositories"
instruction.

**Outstanding for M8**: the authorized fixture-repository delivery test
against real GitHub — a real fine-grained PAT scoped to a disposable
fixture repository, a real SSH deploy key, and a real draft-PR
create/update/review/merge round-trip — is explicitly deferred, per
`docs/integration-feasibility.md`, S5: "Follow with an authorized
fixture-repository delivery test before coding acceptance," and per
`docs/acceptance-scenarios.md`, "Coding acceptance scenario," which
depends on D2–D4 being resolved first. It is not run here and must not be
treated as covered by the fixture evidence above.

## Observed limitations

- **The fake GitHub API's delivery-lifecycle fields are a model of
  documented behavior, not a capture.** See "Documentation research"
  above for which fields were directly confirmed in the fetched pages
  (create/list/get/update field names, the issues-comments path) versus
  which rest on general knowledge not re-verified for this record (the
  `synchronize` webhook citation for the `headSha` bridging field, the
  full review-state enum, `closed_at`'s exact presence on the get-PR
  response).
- **`headSha` (on create and update) is this slice's own fixture-only
  bridging field, not a real GitHub request field.** Real GitHub derives
  a PR's `head.sha` automatically from the branch's actual state, because
  its API and its Git hosting are the same system. Here, `FakeGitHubApi`
  (an HTTP fixture) and `FakeGitRemote` (a bare-repo fixture) are
  deliberately decoupled, matching #27's existing architecture — there is
  no code path by which the fake API could discover a push on its own.
  `DeliveryModule` bridges this because it is the one component that
  both pushes and calls the API. A resolution that removes this bridging
  field entirely (e.g. giving the fake API a way to inspect
  `FakeGitRemote`'s bare repository) was not attempted; it would blur the
  boundary these two fixtures deliberately keep separate.
- **Merge is not modeled as a real HTTP endpoint at all.** Real GitHub's
  merge endpoint is `PUT .../pulls/{number}/merge`, callable with any
  token that has write access. This slice deliberately does NOT give
  `GitHubConnection` a `mergePullRequest` method and does NOT expose
  `injectMerge` over HTTP — open decision **D2** is unresolved, so this
  slice does not build a code path through which Michelin's PAT could
  merge a PR. `injectMerge`/`injectClose` model a human acting directly
  on GitHub, observed afterward only through the read-only `GET`
  endpoints. If D2 is later resolved in a way that DOES grant Michelin
  merge authority under bounded conditions, a real `mergePullRequest`
  HTTP endpoint would need to be added then — this is out of scope here.
- **The review-state enum is a strict subset of GitHub's real one.**
  `PENDING` and `DISMISSED` review states are not modeled; only
  `APPROVED`, `CHANGES_REQUESTED`, and `COMMENTED` (the three this
  package's acceptance criteria require) exist in `ReviewState`.
- **`GalleySubstitute.reopen()`'s resulting status ("In Review") is this
  slice's own modeling choice, not a directly specified behavior.**
  CONTEXT.md and `docs/v1-scope.md` establish that a ticket-based grant
  "permanently ends at Done; reopening does not restore it" (which this
  slice implements exactly, via the pre-existing
  `AdmissionLedger.ticketReopened()`), but neither document names a
  distinct Ticket Status for "reopened after Done" in the delivery
  lifecycle. Returning to `"In Review"` was chosen as the closest
  existing Status (the Ticket again awaits its completion condition); a
  future decision could instead specify a different resulting Status
  without changing the (already-tested) grant-permanence property.
- **`observeMerge`'s "no open Round" check runs before the merged/closed
  branches, by this slice's own design**, not a behavior directly
  specified in `docs/contracts/execution-interface.md` (which states only
  that the merge fact is "reported outside Round fencing" and routes
  "merge arrival during an open round" to D4 without prescribing the
  exact precedence against a simultaneous closed-unmerged fact). This
  slice treats "a Round is open" as the single overriding condition,
  ahead of interpreting merged/closed at all.
- **No real repository/PR/branch-protection semantics beyond what #27
  already noted** (no concurrency, retry, or rate-limit modeling; PR
  numbers are a single global counter across repos, not GitHub's
  per-repo issue/PR numbering — unobservable in this slice's
  single-repo fixtures but noted for completeness).
- **Ledger reuse, not new ledger behavior.** This slice adds no new
  method to `AdmissionLedger`; `observeMerge`'s Done transition and
  `reopen`'s permanence both exercise `ticketDone()`/`ticketReopened()`,
  already proven in [#15](https://github.com/cristoforows/ticketIt/issues/15)'s
  evidence, applied here to the new Ticket-status domain rather than
  testing new ledger semantics. The two new ledger action constants
  (`PULLS_WRITE`, reusing the existing `PULLS_READ`) are ordinary
  `admit()` action strings, not new ledger mechanics.

## Outstanding checks and owning milestone

- **M8** (real OpenCode coding, per `docs/implementation-plan.md`): the
  authorized fixture-repository delivery test against real GitHub (real
  fine-grained PAT, real SSH deploy key, real disposable fixture repo,
  real draft-PR create/update/review/merge round-trip), per
  `docs/integration-feasibility.md`'s S5 and `docs/acceptance-scenarios.md`'s
  "Coding acceptance scenario" — not run here, see "Real-provider
  evidence" above.
- **M8** (`docs/open-decisions.md`, D2 and D4 resolution gates): once D2
  is resolved, verifying whatever bounded merge authority (if any) it
  grants Michelin against a real merge endpoint; once D4 is resolved,
  revisiting whether `undefinedTransitions`' two recorded kinds
  (`closed-unmerged`, `merge-during-open-round`) become defined
  transitions with an actual Status change, and updating this substitute
  accordingly.
- **M8**: verifying the real GitHub review-state enum in full (`PENDING`,
  `DISMISSED`) and the `X-Accepted-GitHub-Permissions` header interaction
  this record's documentation research did not re-verify.
- **M5** (Permissions/recovery milestone,
  [#6](https://github.com/cristoforows/ticketIt/issues/6)): wiring a real
  Galley (not `GalleySubstitute`) sign-in/grant/Ticket boundary; this
  slice's Ticket record is a bounded local stand-in, same spirit as
  `AdmissionLedger` standing in for Galley's control state.
- Never selects object storage, hosting, native model, or OpenCode
  provider/model, per open decision **D7** and `experiments/README.md`.

## Decision impacts (open-decision IDs)

- **D2** ("Human-review evidence for PR completion and agent merge
  authority"). **Not resolved by this slice.** What this slice does
  establish, as a constraint any D2 resolution must account for: an
  observed merge fact (`merged: true`, `merge_commit_sha` present) proves
  only that GitHub's own state now shows the PR merged — it proves
  nothing about WHO performed that merge or whether a human genuinely
  reviewed the change first. This slice's `injectMerge` test-control
  helper deliberately bypasses identity entirely (unlike every real
  endpoint, which is gated by the configured PAT), which is itself a
  structural reminder that "a PR is merged" and "a human reviewed it" are
  two different facts this fixture cannot conflate — `observeMerge()`
  only interprets the former into `Done`. Because this slice never gives
  `GitHubConnection` a merge-capable method at all, it also demonstrates
  one bounded action-surface option D2's own recommendation-to-evaluate
  names ("owner-controlled merge plus a clearly bounded supported action
  surface"): Michelin's PAT, as configured in this experiment, has no
  code path to merge a PR even if it had `pull_requests` write
  permission on the fake API, since no such method exists to call. This
  is an implementation choice available to a D2 resolution, not itself a
  resolution.
- **D4** ("Exceptional PR and template/repository changes"). **Not
  resolved by this slice**, per the issue's own instruction ("D4 is not
  resolved here"). This slice records, with real observed data (see
  "Fixture evidence: the two undefined transitions" above), the two
  exceptional cases D4 names explicitly: a closed-unmerged PR (`kind:
  "closed-unmerged"`, observed `merged: false, state: "closed"`) and a
  merge arriving during an open Round (`kind:
  "merge-during-open-round"`, observed `merged: true, state: "closed"`
  while `roundOpen: true`). In both cases the Ticket's Status is left
  completely unchanged and no new PR or successful completion is
  inferred, per D4's own text: "Preserve prior deliveries; never infer a
  new PR or successful completion without a defined transition." A
  future D4 resolution can consume `undefinedTransitions`' recorded
  `observed` payloads directly to decide what SHOULD happen in each case,
  without this slice having pre-judged the answer.
- **D7**: this experiment selects no object storage, hosting, native
  model, or OpenCode provider/model; not applicable beyond that
  workspace-wide constraint.
