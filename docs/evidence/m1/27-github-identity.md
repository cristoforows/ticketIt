# M1.16 — GitHub identity separation with mocked OAuth, PAT, and Git transport

## Purpose

Prove, with local fixtures only, the identity half of feasibility
experiment S5 ("GitHub delivery and identity",
`docs/integration-feasibility.md`): "Mock OAuth sign-in, PAT identity...
use a fake Git/SSH transport. Verify owner restriction, separate
credentials, connected identity... Apply current grants to subsequent
controlled API and Git admissions." This is
[M1.16 — GitHub identity separation with mocked OAuth, PAT, and Git
transport (#27)](https://github.com/cristoforows/ticketIt/issues/27).

Specifically, this slice establishes with deterministic fixtures that:

- GitHub OAuth sign-in identity (`docs/deployment.md`, "Ownership and
  sign-in": "Use GitHub OAuth for owner sign-in in v1, restricted to the
  configured owner... Signing in is distinct from authorizing agent use
  of a connected external account.") can be restricted to a configured
  Owner, and that a sign-in session alone carries no Connected Account
  authority — only a separate `AdmissionLedger.grant()` call does
  (CONTEXT.md, **Owner**, **Connected Account**, **Permission**).
- A fine-grained PAT's identity (`docs/agent-execution.md`, "Initial
  GitHub connection": "verifies the authenticated account identity")
  can be checked against the expected Connected Account, and that
  repository/permission access outside that token's resource set fails
  explicitly, with no fallback to a broader credential.
- Git commit authorship and the Git-transport SSH identity are
  configuration concerns separate from the API identity
  (`docs/agent-execution.md`: "Git commit authorship and the account
  identity used for API actions remain separate configuration
  concerns").
- Every API and Git action is gated by `AdmissionLedger.admit()`
  (`experiments/shared`, built in
  [#15](https://github.com/cristoforows/ticketIt/issues/15)), refusing
  to run when the decision is not `"allow"`.

Relevant open decision per `docs/open-decisions.md` (read only, not
edited — see "Decision impacts" below): **D2** ("Human-review evidence
for PR completion and agent merge authority").

This slice does not implement PR creation/update, review/comments, merge
events, or repeat-request/branch reuse reconciliation — those are the
delivery-lifecycle half of S5 and belong to
[#28](https://github.com/cristoforows/ticketIt/issues/28), which extends
this same `experiments/github-delivery/` package.

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
  `fetch`. No new package was added to `experiments/shared`.

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
script under a temp directory (`node:os` `tmpdir()`); nothing leaves the
loopback interface/local filesystem and no real GitHub host, port, or
SSH key is used.

Regression-checked (unaffected by this slice, same versions as
[#15](https://github.com/cristoforows/ticketIt/issues/15)'s evidence
record):

```sh
cd experiments/shared && rm -rf node_modules && npm ci && npm test && npm run typecheck
cd ../_template && rm -rf node_modules && npm ci && npm test
cd ../tracer-fake-clock && rm -rf node_modules && npm ci && npm test
```

## Documentation research (unverified)

Findings below are drawn from reading GitHub's published documentation
(fetched 19 September 2026), not from calling the real GitHub API. They
inform `src/fake-github-api.ts`'s modeled behavior; they are **not**
verified against a live GitHub response, and `docs/integration-feasibility.md`'s
own "GitHub identities" row already flags "Fine-grained token
resource-owner/collaborator limitations matter" as something to verify,
not something proven here.

- **Authorization header scheme.** GitHub's OAuth Apps documentation
  ("Authorizing OAuth Apps",
  <https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps>)
  gives the example `Authorization: Bearer OAUTH-TOKEN` and states "The
  access token allows you to make requests to the API on a behalf of a
  user" and "Every time you receive an access token, you should use the
  token to revalidate the user's identity" (i.e. call `GET /user`). The
  REST API reference for `GET /user`
  (<https://docs.github.com/en/rest/users/users?apiVersion=2022-11-28#get-the-authenticated-user>)
  documents the same `Authorization: Bearer <YOUR-TOKEN>` header for
  both OAuth tokens and personal access tokens, noting scope-dependent
  private/public response shape (not modeled here — the fake API always
  returns the same shape, `{ login }`, since this slice only needs
  identity, not the full user resource). `src/fake-github-api.ts`'s `GET
  /user` and repo endpoints accept `Authorization: Bearer <token>`
  (and, forgivingly, the older `Authorization: token <token>` form)
  uniformly for both OAuth- and PAT-kind tokens on this basis.
- **404 instead of 403 for resources outside a token's grant.** GitHub's
  REST API troubleshooting page
  (<https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api>)
  states directly: "GitHub uses a `404 Not Found` response instead of a
  `403 Forbidden` response to avoid confirming the existence of private
  repositories." This is the documented rationale
  `src/fake-github-api.ts`'s `GET /repos/{owner}/{repo}` models: a
  repository outside the presenting PAT's configured `repositories` set
  returns `404`, not `403`. Fine-grained PAT scoping itself ("Managing
  your personal access tokens",
  <https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens>)
  documents "Each token is limited to access resources owned by a single
  user or organization" and "Each token can be further limited to only
  access specific repositories for that user or organization," but does
  not itself state the exact status code for an out-of-scope repository
  — the 404-vs-403 citation above (the troubleshooting page) is the
  authoritative source used for that specific behavior.
- **403 "Resource not accessible by personal access token" for a
  present-but-under-permissioned token.** The same troubleshooting page
  states: "If you are using a GitHub App or fine-grained personal access
  token and you receive a 'Resource not accessible by integration' or
  'Resource not accessible by personal access token' error, then your
  token has insufficient permissions," and recommends checking the
  `X-Accepted-GitHub-Permissions` response header (not modeled here —
  out of scope for this slice; recorded as a limitation below).
  `src/fake-github-api.ts`'s `GET /repos/{owner}/{repo}/pulls` models
  this: a token whose account entry lacks `"pull_requests"` in its
  configured `permissions` gets `403` with exactly that message string,
  but only after passing the repository-level 404 gate first (a token
  cannot learn a permission is missing on a repository it cannot see
  at all — this ordering choice is this slice's own design decision, not
  a directly cited GitHub behavior, since the two failure modes were not
  found isolated from each other in the fetched documentation).
- **Community reports (not GitHub's own docs, read for corroboration
  only, and explicitly marked unverified here):** a web search
  surfaced <https://dev.to/jjoyneriv/your-fine-grained-github-token-gets-404-not-403-check-these-four-things-before-the-url-1l99>
  and GitHub Community discussions
  (<https://github.com/orgs/community/discussions/162365>,
  <https://github.com/orgs/community/discussions/89800>,
  <https://github.com/orgs/community/discussions/106661>) corroborating
  both the 404-for-out-of-scope and 403-"Resource not accessible by
  personal access token" behaviors, including one report that a token
  with `Issues: read` but not `Pull requests` gets a 404 from the pulls
  endpoint rather than 403 in some cases. This slice's fake API always
  uses the repo-then-permission gate order described above; it does not
  attempt to reproduce every permission-combination edge case these
  community reports describe, since they are third-party reports, not
  GitHub's own documentation.

## Fixture/stub evidence (observed)

All commands under "Reproducible commands" ran successfully on the
versions above:

- `experiments/github-delivery`: `npm ci` → `added 9 packages, and
  audited 11 packages`, 0 vulnerabilities (npm additionally warns that
  `esbuild`'s and `fsevents`'s install scripts are not covered by
  `allowScripts`; this is the same pre-existing npm 11 behavior already
  present for every other package in this workspace, not something this
  slice introduced — no install-script content was approved or
  executed). `npm test` → **26/26** tests passed across four files
  (`test/fake-github-api.test.ts`, `test/fake-git-remote.test.ts`,
  `test/galley-substitute.test.ts`, `test/github-connection.test.ts`).
  `npm run typecheck` (`tsc -p tsconfig.json --noEmit`) passed with no
  errors. Re-verified from a clean `node_modules` (`rm -rf node_modules
  && npm ci && npm test`): same 26/26 result.
- `experiments/shared`: unchanged by this slice; re-run for regression
  confirmation — `npm ci` → 0 vulnerabilities, `npm test` → **40/40**
  (same as `docs/evidence/m1/15-admission-ledger.md`), `npm run
  typecheck` passed.
- `experiments/_template`: unchanged; `npm test` → **1/1**.
- `experiments/tracer-fake-clock`: unchanged; `npm test` → **2/2**.
- `git status --porcelain` after all four `npm ci` runs shows no
  `package-lock.json` diff for `shared`, `_template`, or
  `tracer-fake-clock`; only `experiments/github-delivery/` is new.

### Public API added (`experiments/github-delivery/src/index.ts`)

- `FakeGitHubApi` (`src/fake-github-api.ts`): constructed with
  `{ oauthAccounts?, patAccounts? }`. `listen()` → `{ baseUrl }`;
  `close()`; `requestLog()` → `RequestLogEntry[]`
  (`{ method, path, tokenKind: "oauth"|"pat"|"unknown", token, login,
  status }`). Endpoints: `GET /user`, `GET /repos/{owner}/{repo}`,
  `GET /repos/{owner}/{repo}/pulls`. An unrecognized bearer token always
  resolves `tokenKind: "unknown"` and `401`, on every endpoint.
- `FakeGitRemote` (`src/fake-git-remote.ts`): constructor creates a bare
  repo (`git init --bare`) and a `fake-ssh.sh` script under a temp dir.
  `bareRepoPath`, `remoteUrl` (`git@fake-git-host:<abs bare repo path>`,
  scp-like syntax), `sshScriptPath`, `sshCommandFor(identityPath)` →
  `GIT_SSH_COMMAND` value, `invocations()` → `SshInvocation[]`
  (`{ loggedAtIso, identity, argsLine }`), `revParse(ref)`.
- `GalleySubstitute` (`src/galley-substitute.ts`): constructed with
  `(ownerLogin, clock: FakeClock)`. `ownerLogin`, `ledger`
  (`AdmissionLedger`), `signIn(login)` → `SignInResult`
  (`{ accepted, session?, reason? }`), `sessions()`.
- `GitHubConnection` (`src/github-connection.ts`): constructed with
  `{ expectedLogin, pat, apiBaseUrl, gitAuthor: {name,email},
  sshCommand, ledger, ledgerContext: {roundId,ticketId,agentId,account} }`.
  `verifyIdentity()`, `checkRepositoryAccess(owner, repo)`,
  `checkPullRequestAccess(owner, repo)`, `commit(worktree, message)` →
  commit SHA, `push(worktree, remote, branch)`. Error classes:
  `AdmissionRefusedError` (`decision`, `reason`, `action`, `resource`),
  `IdentityMismatchError`, `RepositoryAccessError` (`status: 404|403`),
  `PullRequestPermissionError`. Exported action-name/resource-building
  helpers (`GitHubConnectionActions`, `repoResource`, `pullsResource`,
  `pushResource`) so tests and #28 share one source of truth for the
  ledger scope strings this module uses, instead of duplicating magic
  strings.

### How the fake SSH transport works

`GIT_SSH_COMMAND` (or `core.sshCommand`) is documented by git as a
command line that is shell-split, with the target host and the
transport command (e.g. `git-receive-pack '/path'`) appended as further
arguments. `FakeGitRemote.sshCommandFor(identityPath)` returns
`"<fake-ssh.sh> -i <identityPath>"`; git therefore invokes
`<fake-ssh.sh> -i <identityPath> <host> "<remote-command>"`. The script
(bash, generated per `FakeGitRemote` instance):

1. Scans its argv for `-i` and logs the following value as `identity`,
   plus the full argv line, to a per-instance log file.
2. `eval`s the trailing argument (the remote command string) locally —
   because `FakeGitRemote.remoteUrl` uses the scp-like form
   `git@fake-git-host:<absolute bare repo path>`, the path git passes to
   `git-receive-pack`/`git-upload-pack` is already the real local
   filesystem path, so no path translation is needed. No network
   connection, SSH handshake, or real key file is ever used — the
   `identityPath` is a fixture string (e.g.
   `/fixtures/ssh/michelin-deploy-key`), never read from disk.

Manually verified end-to-end before writing the test suite: a real `git
push` against `FakeGitRemote.remoteUrl` with `GIT_SSH_COMMAND` set from
`sshCommandFor()` succeeded, logged the configured identity, and
`revParse("refs/heads/main")` on the bare repo matched the pushed
commit's SHA. Some git/OpenSSH combinations additionally probe with a
`ssh -G <host>` capability check before the real invocation; the fake
script's `eval` of that probe's trailing argument (a bare hostname, not
a valid command) fails, and git tolerates this exactly as it tolerates
an unrecognized real SSH variant — the real transport invocation always
follows and succeeds. Tests that assert on `invocations()` filter for
the entry whose `argsLine` contains `git-receive-pack`, rather than
assuming exactly one logged invocation, to avoid coupling to that probe.

### Test names and pass counts

`test/fake-github-api.test.ts` (8 tests):

- `GET /user with a configured OAuth token returns that account's login`
- `GET /user with a configured PAT token returns that account's login`
- `GET /user with an unconfigured token is rejected with 401, never accepted`
- `GET /repos/{owner}/{repo} returns 200 only for a repository inside the PAT's resource set`
- `GET /repos/{owner}/{repo} returns 404 for a repository outside the PAT's resource set`
- `GET /repos/{owner}/{repo}/pulls returns 403 when the token lacks pull-request permission`
- `GET /repos/{owner}/{repo}/pulls returns 200 when the token has pull-request permission`
- `requestLog records method, path, token kind, and status for every request`

`test/fake-git-remote.test.ts` (3 tests):

- `push over the fake SSH transport logs the configured identity`
- `pushed commits land in the bare remote repository`
- `different pushes can log different configured identities`

`test/galley-substitute.test.ts` (4 tests):

- `non-owner sign-in is rejected`
- `owner sign-in is accepted and creates a session carrying no account authority`
- `a sign-in session alone cannot perform an account action: no grant means admit() denies`
- `a valid ticket-based grant on the same ledger allows the admission`

`test/github-connection.test.ts` (11 tests):

- `PAT identity mismatch is rejected`
- `PAT identity match is accepted and recorded`
- `repository outside the token's resource set fails explicitly; only the PAT was ever sent, never the broader admin token`
- `pull-request permission missing surfaces 403, no credential substitution`
- `commit author differs from the API identity (read via git log --format)`
- `SSH identity used for push is logged separately from the API token`
- `ledger consulted before API actions: offline downgrades an otherwise-valid admission to hold, and the action does not run`
- `ledger consulted before API actions: an expired time-based grant denies, and the action does not run`
- `ledger consulted before API actions: a revoked grant denies, and the action does not run`
- `ledger consulted before API actions: a valid ticket grant allows, and the action runs`
- `ledger consulted before Git actions too: without a grant, commit and push are refused and never run`

Total: **26/26** passing (`node --test` summary: `tests 26`, `pass 26`,
`fail 0`).

### Request-log excerpt: repository outside the PAT's resource set, admin token never sent

Captured by exercising `GitHubConnection.checkRepositoryAccess("acme",
"other-repo")` against a `FakeGitHubApi` configured with both the
connection's PAT (`repositories: ["acme/allowed-repo"]`) and a separate,
broader "admin" PAT (`repositories: ["acme/allowed-repo",
"acme/other-repo"]`, includes `"acme/other-repo"`) that was **never**
passed to `GitHubConnection`'s constructor:

```
threw: RepositoryAccessError 404
[
  {
    "method": "GET",
    "path": "/repos/acme/other-repo",
    "tokenKind": "pat",
    "token": "pat-fixture-michelin-token",
    "login": "michelin-bot",
    "status": 404
  }
]
```

The request log contains exactly one entry, using only the configured
PAT (`token: "pat-fixture-michelin-token"`); the admin token
(`"pat-fixture-admin-broader-token-never-sent"`) never appears, even
though it was configured in the fake API and would have returned `200`
for the same repository. `GitHubConnection` has no code path that reads
or sends any credential other than its single configured `pat` field —
this is a structural guarantee (see `src/github-connection.ts`'s
`authHeader()`, the only place a bearer token is attached to a request),
not just an observed absence in this one run. The corresponding test
(`repository outside the token's resource set fails explicitly; only the
PAT was ever sent, never the broader admin token`) asserts the same
property with `log.every(entry => entry.token === PAT_TOKEN)` and
`log.every(entry => entry.token !== ADMIN_TOKEN)`.

### Rule-to-behavior mapping

| Rule | Test(s) | Spec / doc basis |
| --- | --- | --- |
| Non-owner sign-in identity is rejected | `non-owner sign-in is rejected` | deployment.md, "Ownership and sign-in": "Use GitHub OAuth for owner sign-in in v1, restricted to the configured owner" |
| Owner sign-in is accepted; the session carries no account-authority field | `owner sign-in is accepted and creates a session carrying no account authority` | deployment.md: "Signing in is distinct from authorizing agent use of a connected external account"; CONTEXT.md, **Permission**: authorization is separate from identity |
| A sign-in session alone cannot perform an account action (no grant → deny) | `a sign-in session alone cannot perform an account action: no grant means admit() denies` | admission-ledger.ts module comment: "no Skill... or anything ... can create or influence a grant" other than an explicit `grant()` call |
| PAT identity mismatch is rejected; match is accepted and recorded | `PAT identity mismatch is rejected`, `PAT identity match is accepted and recorded` | agent-execution.md, "Initial GitHub connection": "verifies the authenticated account identity" |
| Repository outside the token's resource set fails explicitly (404), no substitution | `repository outside the token's resource set fails explicitly; only the PAT was ever sent, never the broader admin token` | troubleshooting-the-rest-api: "GitHub uses a 404 Not Found response... to avoid confirming the existence of private repositories" |
| Missing pull-request permission surfaces 403, no substitution | `pull-request permission missing surfaces 403, no credential substitution` | troubleshooting-the-rest-api: "Resource not accessible by personal access token" |
| Commit author differs from the API identity | `commit author differs from the API identity (read via git log --format)` | agent-execution.md: "Git commit authorship and the account identity used for API actions remain separate configuration concerns" |
| SSH identity is logged separately from the API token | `SSH identity used for push is logged separately from the API token` | agent-execution.md: "Git operations can continue using the configured SSH identity" (separate from the API PAT) |
| Ledger consulted before API actions; offline holds | `ledger consulted before API actions: offline downgrades an otherwise-valid admission to hold, and the action does not run` | admission-ledger.ts `admit()`: disconnected downgrades an otherwise-`allow` to `hold` |
| Ledger consulted before API actions; expired time grant denies | `ledger consulted before API actions: an expired time-based grant denies, and the action does not run` | agent-execution.md, "Permissions and connected accounts": "Check live authority before subsequent tool actions" |
| Ledger consulted before API actions; revoked denies | `ledger consulted before API actions: a revoked grant denies, and the action does not run` | agent-execution.md: "Manual revocation takes effect for subsequent tool actions" |
| Ledger consulted before API actions; valid ticket grant allows and the action runs | `ledger consulted before API actions: a valid ticket grant allows, and the action runs` | v1-scope.md, "Permissions and accounts": ticket-based grant scope |
| Ledger also gates Git actions (commit/push), not only API calls | `ledger consulted before Git actions too: without a grant, commit and push are refused and never run` | issue #27, "consults the admission ledger before every API and Git action" |

## Real-provider evidence (observed, or "none executed")

None executed. This slice makes no call to the real GitHub API, no real
OAuth flow, no real PAT, and no real SSH/network connection — the only
network activity is loopback HTTP to `FakeGitHubApi` on
`127.0.0.1`, and the only "remote" Git operations are local (a bare repo
under a temp directory, reached through a script that runs
`git-receive-pack`/`git-upload-pack` in-process rather than over SSH),
per `experiments/README.md`'s "No calls to real providers or real
repositories" rule and this issue's "No real credentials, no real
GitHub API calls, no real remotes" instruction.

**Outstanding for M8**: the authorized fixture-repository delivery test
against real GitHub — a real fine-grained PAT scoped to a disposable
fixture repository, a real SSH deploy key, and a real `git push`/PR
round-trip — is explicitly deferred, per `docs/integration-feasibility.md`,
S5: "Follow with an authorized fixture-repository delivery test before
coding acceptance," and per this issue's acceptance criterion "The
authorized fixture-repository delivery test is listed as outstanding for
M8." It is not run here and must not be treated as covered by the fixture
evidence above.

## Observed limitations

- **The fake GitHub API is a model of documented behavior, not a
  capture.** `src/fake-github-api.ts`'s status codes and messages are
  built from reading GitHub's docs (see "Documentation research" above),
  not from recording real HTTP responses. Real GitHub's exact behavior
  for edge cases — e.g. a token with some-but-not-all needed permissions,
  organization-level fine-grained token approval requirements
  (mentioned in the fetched PAT-management doc: "Organizations can
  require approval for fine-grained tokens"), rate limiting, or the
  `X-Accepted-GitHub-Permissions` header — is not modeled or verified.
- **The repo-then-permission gating order (404 before 403) is this
  slice's own design choice**, not a behavior directly cited from a
  single GitHub doc passage (see "Documentation research"): the fetched
  pages document each status code's cause independently, not their
  interaction/precedence when both could apply. Community reports found
  during research disagree on some specific permission-combination
  cases; this fake API picks one consistent rule (resource-set
  membership gates first) rather than modeling every reported
  combination.
- **The fake SSH transport is a local shell-out, not a real SSH
  session.** No SSH protocol, handshake, host-key verification, or key
  file is exercised; `FakeGitRemote` proves that a configured identity
  string is observably distinct from the API token and that git's
  `GIT_SSH_COMMAND` mechanism can be intercepted deterministically, not
  that a real deploy key/host authenticates correctly. The occasional
  `ssh -G` capability probe some git/OpenSSH versions issue before the
  real transport command is tolerated (its failed `eval` does not abort
  the push) but not itself asserted on.
- **`GitHubConnection`'s admission gate is per-call, not a general
  interception layer.** Every method calls `#admitOrThrow` first by
  construction of this module, but nothing prevents a future method
  added to this class from forgetting to call it — there is no
  structural (type-level) enforcement analogous to `AdmissionLedger`'s
  own grant-creation guarantees. This is a maintainability note for
  issue #28's extension of this same class, not a defect in the
  current, exhaustively-covered method set.
- **No real repository/PR/branch-protection semantics are modeled.**
  `GET /repos/{owner}/{repo}/pulls` returns a bare `200 []` or the
  documented error codes; no PR bodies, review states, or merge-status
  fields exist yet — those belong to #28.
- **No concurrency, retry, or rate-limit modeling.** `FakeGitHubApi` and
  `FakeGitRemote` are single-process, synchronous-enough fixtures for
  one test at a time; concurrent requests are not deduplicated or
  throttled, unlike real GitHub's rate limits.
- **Ledger reuse, not new ledger behavior.** This slice adds no new
  method to `AdmissionLedger`; it only exercises the existing `admit()`
  precedence (offline/expired/revoked/valid) proven in
  [#15](https://github.com/cristoforows/ticketIt/issues/15)'s evidence,
  applied to a new domain (GitHub API/Git actions) rather than testing
  new ledger semantics.

## Outstanding checks and owning milestone

- **#28** (GitHub delivery lifecycle, extending this same package): PR
  creation/update, review/comments, merge-status checks, repeat-request
  reconciliation, and branch/PR reuse — the rest of S5 beyond identity.
- **M8** (real OpenCode coding, per `docs/implementation-plan.md`): the
  authorized fixture-repository delivery test against real GitHub (real
  fine-grained PAT, real SSH deploy key, real disposable fixture repo),
  per `docs/integration-feasibility.md`'s S5 and this issue's own
  acceptance criterion — not run here, see "Real-provider evidence"
  above.
- **M8**: verifying the actual `X-Accepted-GitHub-Permissions` header
  and any organization-level fine-grained-token-approval interaction
  this slice's documentation research flagged but did not model.
- **M5** (Permissions/recovery milestone,
  [#6](https://github.com/cristoforows/ticketIt/issues/6)): wiring a
  real Galley (not `GalleySubstitute`) sign-in/grant boundary; this
  slice's `GalleySubstitute` is a bounded local stand-in, same
  spirit as `AdmissionLedger` standing in for Galley's control state.
- Never selects object storage, hosting, native model, or OpenCode
  provider/model, per open decision **D7** and `experiments/README.md`.

## Decision impacts (open-decision IDs)

- **D2** ("Human-review evidence for PR completion and agent merge
  authority," `docs/open-decisions.md`: "A personal PR may be authored
  through the same identity that reviews/merges it; a separate GitHub
  approval may not be available. Define what demonstrates owner review
  and ensure agent access cannot silently replace the human completion
  decision.") **is not resolved by this slice.** What this slice does
  establish, as a constraint any D2 resolution must account for: the
  Connected Account identity that authors commits/PRs (verified by
  `GitHubConnection.verifyIdentity()` against the configured PAT) is
  architecturally separate from, and this slice's `GalleySubstitute`
  keeps separate from, the Owner's OAuth sign-in identity used to access
  ticketIt itself. That separation means a resolution of D2 cannot
  assume "the same GitHub login reviewing a PR is inherently the human
  Owner acting" — this experiment's fixtures show the sign-in identity
  and the Connected Account/PAT identity are independently configured
  and independently verified, so if the same physical person's GitHub
  account happens to be configured as both, that coincidence provides
  no automatic proof of *human* review versus agent action through the
  same account. D2's eventual resolution (e.g. "owner-controlled merge
  plus a clearly bounded supported action surface," per the decision's
  own recommendation-to-evaluate) will need evidence independent of
  which GitHub identity performed the API call — this slice's identity
  separation is a relevant constraint for that design, not a proposed
  answer to it.
- **D1** ("Enforceable OpenCode action boundary and disconnect
  behavior"): this slice extends the same admission-gating shape proven
  in [#15](https://github.com/cristoforows/ticketIt/issues/15) to a
  concrete external-credential domain (GitHub API + Git transport),
  showing the ledger gate composes with a real (fixture) network/process
  boundary, not just in-memory decisions. It does not resolve D1.
- **D7**: this experiment selects no object storage, hosting, native
  model, or OpenCode provider/model; not applicable beyond that
  workspace-wide constraint.
