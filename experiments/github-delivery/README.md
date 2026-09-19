# github-delivery

[M1.16 — GitHub identity separation with mocked OAuth, PAT, and Git
transport (#27)](https://github.com/cristoforows/ticketIt/issues/27):
the identity half of feasibility experiment S5 ("GitHub delivery and
identity", `docs/integration-feasibility.md`). Proves, with local
fixtures only (no real GitHub credentials, no real network calls), that:

- GitHub OAuth sign-in identity (`docs/deployment.md`, "Ownership and
  sign-in") can be restricted to a configured Owner, independent of any
  Connected Account grant (`docs/v1-scope.md`, "Permissions and
  accounts"; CONTEXT.md, **Owner**, **Connected Account**, **Permission**).
- A fine-grained personal access token's identity can be verified
  against the expected Connected Account, and repository/permission
  access outside that token's resource set fails explicitly rather than
  falling back to any broader credential (`docs/agent-execution.md`,
  "Initial GitHub connection").
- Git commit authorship and push SSH identity are configuration
  concerns separate from the API identity (`docs/agent-execution.md`:
  "Git commit authorship and the account identity used for API actions
  remain separate configuration concerns").
- Every API and Git action is gated by `AdmissionLedger.admit()`
  (`experiments/shared`), refusing when the decision is not `allow`.

[M1.17 — Draft PR delivery lifecycle with mocked reviews and merge
(#28)](https://github.com/cristoforows/ticketIt/issues/28) extends this
same package with the delivery half of S5: draft PR creation/update,
review/comment feedback, merge/close observation, and a Ticket-status
Galley substitute. See
[docs/evidence/m1/28-pr-delivery-lifecycle.md](../../docs/evidence/m1/28-pr-delivery-lifecycle.md).

## Modules

- `src/fake-github-api.ts` — `FakeGitHubApi`: a `node:http` server on
  `127.0.0.1` (ephemeral port) modeling `GET /user` (OAuth and PAT
  identity), `GET /repos/{owner}/{repo}` (fine-grained token resource
  scope), and the delivery-lifecycle PR surface added in #28: `GET`/`POST
  /repos/{owner}/{repo}/pulls` (list by head branch / create a draft PR),
  `GET`/`PATCH /repos/{owner}/{repo}/pulls/{number}` (get one / update
  title, body, and the fixture-only `headSha` bridging field), `GET
  /repos/{owner}/{repo}/pulls/{number}/reviews`, and `GET
  /repos/{owner}/{repo}/issues/{number}/comments`. Every PR endpoint
  applies the same repository-resource-set (404) and missing-permission
  (403) gates as #27. Test-control helpers (`injectReview`,
  `injectComment`, `injectMerge`, `injectClose`) simulate a human acting
  directly on GitHub; they bypass identity and are never recorded in
  `requestLog()`. Records every HTTP request for assertions and never
  accepts an unconfigured token.
- `src/fake-git-remote.ts` — `FakeGitRemote`: a local bare repository
  acting as the "remote", reached through a fake `GIT_SSH_COMMAND`
  script that logs the configured SSH identity (`-i` value) and then
  runs the requested git transport (`git-upload-pack`/`git-receive-pack`)
  locally.
- `src/galley-substitute.ts` — `GalleySubstitute`: restricts sign-in to
  the configured Owner, issues a sign-in session that carries no account
  authority, and owns the `AdmissionLedger` (from `shared`, driven by a
  `FakeClock`) that grants come from. #28 adds a bounded Ticket record
  (status, the template-derived `reviewed-pr-merged` completion
  condition, Rounds, informational feedback, and undefined transitions)
  with `createTicket`/`getTicket`/`startRound`/`recordDelivery`/
  `recordFeedback`/`observeMerge`/`explicitRequeue`/`reopen`.
- `src/github-connection.ts` — `GitHubConnection`: the Michelin-side
  module. Verifies token identity, checks repository/pull-request
  access, commits with a configured author distinct from the API
  identity, and pushes over the fake SSH transport — every action first
  consults the ledger and refuses when the decision is not `allow`. #28
  adds `listPullRequestsByHead`, `getPullRequest`, `createPullRequest`,
  `updatePullRequest`, `listReviews`, and `listIssueComments`, each
  gated by the new `PULLS_READ`/`PULLS_WRITE` ledger actions.
- `src/delivery-module.ts` — `DeliveryModule` (#28): `deliver()` ensures
  the ticket branch, commits and pushes through `GitHubConnection`, then
  finds-or-creates the draft PR for that head branch (updating title/body
  on rework), returning the delivered commit sha and PR number.
- `src/index.ts` — re-exports the above.

## Running

```sh
cd experiments/github-delivery
npm ci
npm test
```

## Scope and limitations

Same workspace rules as `experiments/README.md`: no real credentials,
no real GitHub API calls, no real remotes. The fake GitHub API models
documented behavior (see the evidence record's "Documentation research"
section); it is not a capture of real GitHub responses. An authorized
fixture-repository delivery test against a real GitHub App/PAT is
explicitly deferred to M8 (see the evidence record).

See `docs/evidence/m1/27-github-identity.md` (identity half, #27) and
`docs/evidence/m1/28-pr-delivery-lifecycle.md` (delivery-lifecycle half,
#28) for exact versions, commands, documentation research, and observed
limitations.
