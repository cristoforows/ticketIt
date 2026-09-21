# Swiftlet sign-in, authenticated shell, and sign-out

## Purpose

Give Swiftlet its first authenticated experience: a sign-in page with a
single "Sign in with GitHub" action, a session-aware application shell
showing which Owner is signed in, sign-out, and non-owner rejection
that surfaces Galley's own reason verbatim. Also owns the integration
debt #54 left explicit: `internal/githubfake`'s constructor requires a
`testing.TB` and so cannot be reached by a real browser, which is what
`e2e/run.sh`'s placeholder OAuth configuration existed to work around.
Touches `apps/swiftlet`, `apps/galley` (only `internal/githubfake` and
a new `cmd/githubfake`, no HTTP/domain behavior), and `e2e/`. Tracking
issue: [#55 — M2.7 — Swiftlet sign-in, authenticated shell, and
sign-out](https://github.com/cristoforows/ticketIt/issues/55), under
[M2 (#3)](https://github.com/cristoforows/ticketIt/issues/3). Blocked
by [#53](https://github.com/cristoforows/ticketIt/issues/53) and
[#54](https://github.com/cristoforows/ticketIt/issues/54), both merged
before this slice began.

## What already existed

- `apps/galley` (#54, merged): the whole OAuth backend —
  `GET /api/auth/github/start`, `GET /api/auth/github/callback`,
  `GET /api/session`, `DELETE /api/session`, `requireSession`, hashed
  sessions and OAuth state in PostgreSQL, the `owner_mismatch` /
  `unauthenticated` / `invalid_oauth_state` error codes. Swiftlet held
  no OAuth secret and performed no token exchange before this slice
  either — there was simply no Swiftlet code that called any of this
  yet.
- `internal/githubfake`: the substitute OAuth provider, with
  `TestOwnerIdentity` (login `ticketit-test-owner`) and
  `NonOwnerIdentity` fixtures, usable only from inside a Go test binary
  (`New(tb testing.TB, identity Identity) *Server`).
- `e2e/` (#53, merged): `run.sh`, the one-command browser harness
  (reset DB, migrate, build+start Galley, build+serve Swiftlet, install
  Chromium's headless shell, run specs, tear down), `tests/status.spec.ts`
  and `tests/backend-failure.spec.ts`. `run.sh` started Galley with
  *placeholder* owner/OAuth settings whose provider URLs pointed at
  `http://127.0.0.1:1` (a closed port) purely so Galley would boot —
  #54 made that configuration mandatory, and #54's own fake provider
  wasn't usable by a browser yet. `e2e/README.md`'s "Signing in"
  section was a stub naming this exact gap and naming #55 as its owner.
- `apps/swiftlet`: `App.tsx` unconditionally rendered `<StatusView/>`.
  No routing, no session concept, no sign-in UI.
- No contract change was anticipated or needed: #54 already added every
  endpoint this slice's frontend calls (`Owner`, `SessionResponse`, the
  four `auth`-tagged operations) to `contracts/openapi.yaml` and to
  both generated clients.

## What this slice added

### `apps/galley/internal/githubfake` (refactor, no behavior change for existing callers)

Split the `testing.TB`-coupled constructor into two:

- `Start(identity Identity) *Server` — starts the fake provider (same
  three real-GitHub-shaped endpoints as before: `GET
  /login/oauth/authorize`, `POST /login/oauth/access_token`, `GET
  /user`), independent of any `testing.TB`. Also registers two new
  control-plane routes under `/_fake/` (see below).
- `New(tb testing.TB, identity Identity) *Server` — now a thin wrapper:
  `s := Start(identity); tb.Cleanup(s.Close); return s`. Every existing
  Go-test caller (`internal/httpapi`, `cmd/galley`) is unchanged.
- `Close()` — stops the server; the one thing `New`'s callers get for
  free via `tb.Cleanup` that a non-test caller (`cmd/githubfake`) must
  call itself.

**New control-plane endpoints**, registered in `Start`'s mux alongside
the real-GitHub-shaped ones:

- `GET /_fake/healthz` — `200`, for `e2e/run.sh`'s startup gate.
- `POST /_fake/identity` — body `{"preset": "owner" | "non-owner"}`,
  calls the existing `SetIdentity` and returns `204`. A browser-driven
  e2e spec has no way to call `SetIdentity` directly (it isn't Go
  code); this is how it switches the shared fake-provider process
  between the Owner and non-owner fixture identities across specs,
  e.g. to run the non-owner-rejection spec after an owner sign-in
  already happened against the same process.

New test: `internal/githubfake/githubfake_test.go` drives a full
authorize → token exchange → identity fetch round trip (the same three
calls `internal/auth.GitHubClient` makes) to prove `/_fake/identity`
actually changes what `/user` reports, and that an unknown preset is
rejected with `400`.

### `apps/galley/cmd/githubfake` (new — the standalone substitute provider)

A small command (`main.go`, `run(ctx, getenv, stdout, ready) error`
factored out exactly like `cmd/galley`'s own `run`, for the same
testability reason) that calls `githubfake.Start(githubfake.TestOwnerIdentity)`
and blocks until `SIGINT`/`SIGTERM`. Its port is OS-assigned; if
`GITHUBFAKE_ADDR_FILE` is set, it writes its real URL and its fixed,
non-secret fake `ClientID`/`ClientSecret`/owner login as shell-sourceable
`KEY=VALUE` lines, which is how `e2e/run.sh` learns them without
choosing a port up front or parsing log output.

**This is a test/development substitute only**, stated plainly in its
own doc comment, `apps/galley/README.md` ("Owner configuration and
GitHub OAuth sign-in"), and `e2e/README.md` ("Signing in"): it is never
imported by or wired into `cmd/galley`, never reachable from a
production build, never talks to real `github.com`, and holds no real
credential — the identity it always serves is the same
`TestOwnerIdentity` fixture the Go test suite already trusts.

New test: `cmd/githubfake/main_test.go` (`TestRun_ServesFakeProviderUntilContextCanceled`,
`TestRun_WritesAddrFileWhenConfigured`), mirroring `cmd/galley/main_test.go`'s
own pattern of driving `run()` directly with a cancelable context
instead of a real OS signal.

### `apps/swiftlet` (the actual sign-in UI)

- `src/api/session.ts` (new): `fetchSession()` (`GET /api/session`) and
  `signOut()` (`DELETE /api/session`), both typed against the
  generated `Owner`/`SessionResponse` schemas from #54. A shared
  `UnauthenticatedError`, thrown on any `401`, is the one signal every
  caller in this app treats as "return to the sign-in page" — the
  literal implementation of the issue's "Any 401 from an API call
  returns the application to the sign-in page." `signOut()` treats a
  `401` as already-signed-out (success), since there is nothing left
  to revoke.
- `src/components/SignInPage.tsx` (new): the signed-out state — a
  single `<a href="/api/auth/github/start">Sign in with GitHub</a>`.
  Deliberately a real anchor, not a `fetch`-driven click handler:
  OAuth's authorize/callback dance is a top-level browser redirect
  chain that must leave the SPA entirely (to the provider's consent
  screen) and come back; `fetch` cannot do this, and Swiftlet has no
  reason to intercept any part of it.
- `src/components/AppShell.tsx` (new): the authenticated state — shows
  `Signed in as {owner.login}` and a sign-out button. On sign-out
  success or a `401`, calls `onSignedOut` (App.tsx returns to the
  sign-in page); on any other failure, shows an inline error and stays
  in the shell (nothing was proven revoked, so nothing changes).
  Renders the pre-existing `StatusView` unchanged — status is still
  Galley's own public data, now shown as part of the signed-in
  experience rather than unconditionally.
- `src/App.tsx` (rewritten): queries `GET /api/session` once on mount
  and renders exactly one of four states — loading, the sign-in page
  (`401`), the authenticated shell (success), or an explicit error
  state (`role="alert"`, any other failure, e.g. Galley entirely
  unreachable). This fourth state is this slice's own engineering
  choice, not asked for word-for-word by the issue's two-state framing
  ("render either the signed-in shell ... or the sign-in page") — it
  follows the same "never guess, never render a partial state"
  convention `StatusView` already established in #50, applied to a
  session-check failure that is not itself evidence of "no session."
- Tests: `App.test.tsx` rewritten (loading / signed-out / signed-in /
  error, fetch routed by path); new `AppShell.test.tsx` (shows the
  owner, sign-out success, sign-out failure leaves the shell in place,
  a `401` on sign-out is treated as already signed out); new
  `SignInPage.test.tsx` (exactly one link, pointing at
  `/api/auth/github/start`).

**No contract change.** Every endpoint this slice calls already existed
from #54; `contracts/openapi.yaml` is untouched, and both drift checks
were run to confirm (see "Reproducible commands" below) rather than
skipped because nothing seemed to change.

### `e2e/` (the browser harness's actual substitute-provider phase)

- `run.sh`: new phase builds and starts `cmd/githubfake`, waits for its
  address file, and passes its address to Galley as
  `GALLEY_OAUTH_GITHUB_BASE_URL`/`_API_BASE_URL`, with
  `GALLEY_OWNER_GITHUB_LOGIN` set to the fake owner's login
  (`ticketit-test-owner`) — replacing the closed-port placeholder #54
  made mandatory and #53 stubbed around. Torn down on exit exactly like
  Galley and Swiftlet (`cleanup()`'s trap now also kills the
  fake-provider PID).
- **`GALLEY_BASE_URL` is now set to Swiftlet's own origin, not
  Galley's.** This is the one non-obvious wiring decision this slice
  made and is recorded here: Galley's `BaseURL` config setting is
  documented as "the externally-visible origin the *browser* is on
  when it reaches Galley" (`apps/galley/internal/config`'s own doc for
  the field), used to build the OAuth `redirect_uri`. The browser only
  ever reaches Galley through Swiftlet's dev/preview proxy
  (`apps/galley/README.md`, "CORS" — "the browser only ever talks to
  Swiftlet's origin"), so *Swiftlet's* origin is the browser-facing
  origin, not Galley's own bind address. Leaving `GALLEY_BASE_URL` at
  Galley's own address (as the #53 placeholder implicitly assumed, back
  when no frontend consumed it) would make the post-sign-in redirect to
  `/` land the browser on Galley's own bare API root — no static
  assets, `404` — instead of back on Swiftlet's signed-in shell. This
  required no Galley code change: `BaseURL` was already an independent
  setting from `GALLEY_HOST`/`GALLEY_PORT`; only `run.sh`'s own value
  for it changed. See `apps/swiftlet/README.md`, "Galley address
  configuration," for the same note applied to running both dev
  servers by hand.
- New spec `tests/auth.spec.ts`: successful Owner sign-in, session
  surviving a page reload, sign-out (with a direct
  `page.context().request.get("/api/session")` call afterward proving
  Galley itself now answers `401` — not just that the UI stopped
  showing the shell), and non-owner rejection (asserts Galley's exact
  `owner_mismatch` code and message text appear on the page, and that
  no authenticated-shell testid is present).
- New specs `tests/session-restart-before.spec.ts` /
  `session-restart-after.spec.ts`: per `e2e/README.md`'s own rule ("the
  spec cannot restart a process it did not start"), split across two
  `playwright test` invocations with `run.sh` performing the actual
  Galley restart in between. The "before" spec signs in and saves
  `page.context().storageState({ path })`; `run.sh` kills and restarts
  the real `galley` binary against the same database and the same
  `GALLEY_BASE_URL`; the "after" spec loads that storage state via
  `test.use({ storageState })` into a fresh browser context and asserts
  the shell still renders with the Owner signed in — the session token
  itself, persisted in PostgreSQL, is what survives, not anything held
  in Galley's process memory (the same property
  `TestRestartDurability_DiagnosticNoteSurvivesFreshProcess` already
  proves at the API level in `apps/galley`, now proven through a real
  browser too).
- `tests/status.spec.ts` and `tests/backend-failure.spec.ts` (#50/#53,
  pre-existing) needed retrofitting, recorded here rather than left
  silently broken: since `StatusView` now only renders inside the
  authenticated shell, `status.spec.ts` signs in first
  (`e2e/support/sign-in.ts`) before asserting against it, and
  `backend-failure.spec.ts` — which stops Galley *entirely* — now
  asserts App.tsx's own `session-error` state rather than
  `StatusView`'s `status-error`, since with Galley completely
  unreachable the app's first call (`GET /api/session`) fails before
  it ever gets far enough to attempt sign-in or mount `StatusView` at
  all. Both changes are direct, necessary consequences of gating the
  app behind a session check, not scope creep beyond this slice's own
  change.
- New helper `e2e/support/sign-in.ts`: `signIn(page, request, preset)`
  drives the real "Sign in with GitHub" UI action to completion, and
  `setFakeIdentity(request, preset)` is the lower-level call to the
  fake provider's `/_fake/identity` control endpoint. Documented in
  `e2e/README.md` under "Signing in," replacing the placeholder
  paragraph #53 left there.

## Non-owner rejection: exact behavior, and why it needed no Galley change

Galley's `GET /api/auth/github/callback` already answered a rejected
identity with its own JSON error body directly (`owner_mismatch`,
`403`, `contracts/openapi.yaml`'s `default` response) — #54's own
design, unrelated to any Swiftlet UI existing yet. Because this
slice's `run.sh` change (above) routes the whole OAuth round trip
through Swiftlet's own origin, that same response now arrives on a
navigation whose URL happens to be under Swiftlet's origin
(`/api/auth/github/callback?...`) — but it is still Galley's own raw
response, rendered by the browser directly, not intercepted or
reformatted by any Swiftlet code. This is not a UI screen Swiftlet
built; it is the literal, verbatim implementation of the issue's
"surfaces Galley's own reason. Do not substitute a friendlier but less
accurate message" — there is no Swiftlet code positioned to substitute
anything, by construction, and so none can. `tests/auth.spec.ts`'s
rejection test asserts the exact code and message text appear on the
page, and that no authenticated-shell testid is present.

## Exact versions and toolchain

- Go `go1.27.1 darwin/arm64` — unchanged.
- Node `v26.9.0`, npm `11.19.1` — unchanged.
- `apps/swiftlet`: no new dependency. Clean-room `rm -rf node_modules
  dist && npm ci` still installs 108 packages (identical to #50/#54's
  baseline) — this slice's new source files (`session.ts`,
  `SignInPage.tsx`, `AppShell.tsx`, three new test files) use only
  React, `@testing-library/react`, and Vitest, all already present.
- `apps/galley`: no new dependency. `internal/githubfake`'s refactor
  and `cmd/githubfake` use only the standard library
  (`net/http`, `net/http/httptest`, `encoding/json`, `log/slog`,
  `os/signal`) plus the package's own pre-existing imports.
- `contracts`: untouched — `openapi-typescript` `7.13.0` and
  `oapi-codegen` `v2.8.0` remain exactly as pinned by #51/#54; neither
  was re-run to produce a change, only to confirm no drift (see below).
- `e2e`: `@playwright/test` `1.63.0` — unchanged. Chromium's headless
  shell only (`--only-shell`), same as #53.
- PostgreSQL server: `17.11` (Homebrew), `localhost:5432`. This
  record's e2e runs used `ticketit_e2e`, reset from empty by `run.sh`
  itself each time, as always; `ticketit_dev`/`ticketit_test` were
  dropped and recreated from empty for the Go-side verification below;
  `ticketit_m1_native` untouched throughout.

## Reproducible commands

**Galley** (from `apps/galley/`, real PostgreSQL):

```sh
gofmt -l .
go vet ./...
go build ./...
go test ./... -v -count=1
./scripts/check-contract-drift.sh
```

**Swiftlet** (from `apps/swiftlet/`, clean checkout):

```sh
rm -rf node_modules dist
npm ci
npm test -- --run
npm run build
```

**Contract drift, Swiftlet side** (from `contracts/`):

```sh
npm ci
./check-swiftlet-drift.sh
```

**Browser suite** (from `e2e/`):

```sh
./run.sh
```

## Observed results

### `gofmt` / `go vet` / `go build`

```
$ gofmt -l .
(no output — clean)
$ go vet ./...
(no output — clean)
$ go build ./...
(no output — success)
```

### `go test ./... -v -count=1` — 45 subtests, all passing

```
=== RUN   TestRun_ConfigurationFailure
--- PASS: TestRun_ConfigurationFailure (0.00s)
=== RUN   TestRun_ServesStatusThenShutsDownCleanly
--- PASS: TestRun_ServesStatusThenShutsDownCleanly (0.03s)
=== RUN   TestRestartDurability_DiagnosticNoteSurvivesFreshProcess
--- PASS: TestRestartDurability_DiagnosticNoteSurvivesFreshProcess (0.94s)
PASS
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/galley	1.487s
=== RUN   TestRun_ServesFakeProviderUntilContextCanceled
--- PASS: TestRun_ServesFakeProviderUntilContextCanceled (0.00s)
=== RUN   TestRun_WritesAddrFileWhenConfigured
--- PASS: TestRun_WritesAddrFileWhenConfigured (0.00s)
PASS
ok  	github.com/cristoforows/ticketIt/apps/galley/cmd/githubfake	0.232s
?   	github.com/cristoforows/ticketIt/apps/galley/cmd/migrate	[no test files]
?   	github.com/cristoforows/ticketIt/apps/galley/internal/auth	[no test files]
?   	github.com/cristoforows/ticketIt/apps/galley/internal/authtest	[no test files]
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/config	(... unchanged subtests, all PASS)
=== RUN   TestStart_HealthzAndIdentityPresetsControlWhatUserReturns
--- PASS: TestStart_HealthzAndIdentityPresetsControlWhatUserReturns (0.00s)
=== RUN   TestStart_SetIdentityRejectsUnknownPreset
--- PASS: TestStart_SetIdentityRejectsUnknownPreset (0.00s)
PASS
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/githubfake	0.659s
=== RUN   TestOAuthSignIn_HappyPath
--- PASS: TestOAuthSignIn_HappyPath (0.03s)
=== RUN   TestOAuthSignIn_NonOwnerRejected
--- PASS: TestOAuthSignIn_NonOwnerRejected (0.01s)
(... every other #54 auth/contract/diagnostic/routing subtest, all PASS, unchanged by this slice)
PASS
ok  	github.com/cristoforows/ticketIt/apps/galley/internal/httpapi	1.005s
?   	github.com/cristoforows/ticketIt/apps/galley/internal/migrations	[no test files]
?   	github.com/cristoforows/ticketIt/apps/galley/internal/postgres	[no test files]
```

43 `--- PASS` lines plus 2 more from the new `cmd/githubfake` package =
45 total subtests, 0 failures. Full untrimmed transcript is reproducible
with the command above.

### Contract-response validation and both drift checks

```
$ cd apps/galley && ./scripts/check-contract-drift.sh
OK: internal/httpapi/api.gen.go matches contracts/openapi.yaml (no drift).

$ cd ../../contracts && npm ci && ./check-swiftlet-drift.sh
> ticketit-contracts@0.0.0 generate:swiftlet
> openapi-typescript openapi.yaml -o ../apps/swiftlet/src/api/generated/schema.d.ts
✨ openapi-typescript 7.13.0
🚀 openapi.yaml → ../apps/swiftlet/src/api/generated/schema.d.ts [15.1ms]
OK: ../apps/swiftlet/src/api/generated/schema.d.ts matches openapi.yaml (no drift).
```

Confirms this slice's premise: no contract edit was needed, and none
occurred.

### Swiftlet: clean-room install, test, build

```
$ rm -rf node_modules dist && npm ci
added 108 packages, and audited 109 packages in 730ms
found 0 vulnerabilities

$ npm test -- --run
 Test Files  4 passed (4)
      Tests  14 passed (14)

$ npm run build
✓ 20 modules transformed.
dist/index.html                  0.31 kB │ gzip:  0.22 kB
dist/assets/index-Bmof9g-H.js  224.27 kB │ gzip: 69.92 kB
✓ built in 47ms
```

108 packages — identical to #54's baseline; no new dependency. 14 tests
across 4 files: `App.test.tsx` (4), `AppShell.test.tsx` (4),
`SignInPage.test.tsx` (1), `StatusView.test.tsx` (5, unchanged from
#50).

### Browser suite — `SUITE PASSED`, 8 specs across 5 files

```
$ cd e2e && ./run.sh
...
[run.sh] starting the substitute GitHub OAuth/identity provider
[run.sh] substitute GitHub provider ready at http://127.0.0.1:55182 (pid 25145, owner login ticketit-test-owner)
[run.sh] starting galley (browser-facing origin http://127.0.0.1:55177, bound to http://127.0.0.1:55176)
[run.sh] galley ready (pid 25154)
...
[run.sh] running tests/status.spec.ts against a live galley
  ✓  1 [chromium] › tests/status.spec.ts:20:1 › status page displays the values Galley actually returns (305ms)
[run.sh] running tests/auth.spec.ts against a live galley and the substitute GitHub provider
  ✓  1 [chromium] › tests/auth.spec.ts:11:3 › sign-in › the Owner can sign in with GitHub and sees the authenticated shell (153ms)
  ✓  2 [chromium] › tests/auth.spec.ts:19:3 › sign-in › the session survives a page reload (129ms)
  ✓  3 [chromium] › tests/auth.spec.ts:29:3 › sign-in › sign-out revokes the session through Galley and returns to the sign-in page (163ms)
  ✓  4 [chromium] › tests/auth.spec.ts:45:3 › sign-in › a non-owner identity is rejected with Galley's own reason, and no authenticated shell renders (132ms)
[run.sh] running tests/session-restart-before.spec.ts (signs in, saves storage state)
  ✓  1 [chromium] › tests/session-restart-before.spec.ts:20:1 › the Owner signs in before Galley restarts (136ms)
[run.sh] restarting galley (same database, same origin, new process) to prove the session survives
[run.sh] starting galley (browser-facing origin http://127.0.0.1:55177, bound to http://127.0.0.1:55176)
[run.sh] galley ready (pid 25303)
[run.sh] running tests/session-restart-after.spec.ts against the restarted galley
  ✓  1 [chromium] › tests/session-restart-after.spec.ts:21:1 › the session survives a Galley restart (82ms)
[run.sh] stopping galley to exercise the failure-mode spec (pid 25303)
[run.sh] running tests/backend-failure.spec.ts against a stopped galley
  ✓  1 [chromium] › tests/backend-failure.spec.ts:28:1 › the app shows its error state when Galley is stopped, instead of a blank or fabricated page (86ms)
[run.sh] status.spec.ts exit code: 0
[run.sh] auth.spec.ts exit code: 0
[run.sh] session-restart-before.spec.ts exit code: 0
[run.sh] session-restart-after.spec.ts exit code: 0
[run.sh] backend-failure.spec.ts exit code: 0
[run.sh] SUITE PASSED
[run.sh] stopping swiftlet preview server (pid 25186)
[run.sh] stopping the substitute GitHub provider (pid 25145)
```

`lsof -iTCP -sTCP:LISTEN -P` immediately after exit showed no
`galley`/`githubfake`/`vite`/`node` listener left behind, both after
this run and after every deliberately-broken run below.

## Proof the suite can fail

Three separate, targeted, reverted breaks — each re-running the full
`./run.sh`, each capturing the actual red output, each reverted and
followed by a confirming green run (the final green run above is the
one after the last revert).

**1. Broken sign-in link** (`SignInPage.tsx`'s `href` changed to
`/api/auth/github/start-BROKEN-FOR-PROOF`) — every spec that signs in
went red, while the two specs that don't depend on sign-in
(`backend-failure.spec.ts`, and — in this run — nothing else, since it
runs after everything) were unaffected:

```
[chromium] › tests/status.spec.ts ... (failed via signIn helper's click never reaching Galley)
4 failed
    tests/auth.spec.ts › the Owner can sign in with GitHub and sees the authenticated shell
    tests/auth.spec.ts › the session survives a page reload
    tests/auth.spec.ts › sign-out revokes the session through Galley and returns to the sign-in page
    tests/auth.spec.ts › a non-owner identity is rejected with Galley's own reason, and no authenticated shell renders
1 failed
    tests/session-restart-before.spec.ts › the Owner signs in before Galley restarts
Error: Error reading storage state from .../auth-storage-state.json: ENOENT ...
    tests/session-restart-after.spec.ts › the session survives a Galley restart
[run.sh] status.spec.ts exit code: 1
[run.sh] auth.spec.ts exit code: 1
[run.sh] session-restart-before.spec.ts exit code: 1
[run.sh] session-restart-after.spec.ts exit code: 1
[run.sh] backend-failure.spec.ts exit code: 0
[run.sh] SUITE FAILED
```

(The non-owner-rejection test failed too here, for a different reason
than usual: it also clicks the same broken link before asserting
Galley's response, so it failed on the click/navigation rather than on
the rejection assertion — still a correct red, since the link is
genuinely broken.)

**2. Non-owner rejection specifically defeated** (`e2e/support/sign-in.ts`'s
`setFakeIdentity` temporarily hardcoded to always request the `"owner"`
preset, ignoring the caller's actual argument — simulating "identity
switching silently doesn't work") — isolated exactly one failure, the
rejection test itself, while every other spec (including the other
three `auth.spec.ts` tests that also call `signIn`) stayed green:

```
  ✓  1 › the Owner can sign in with GitHub and sees the authenticated shell (139ms)
  ✓  2 › the session survives a page reload (124ms)
  ✓  3 › sign-out revokes the session through Galley and returns to the sign-in page (183ms)
  ✘  4 › a non-owner identity is rejected with Galley's own reason, and no authenticated shell renders (121ms)

    Error: expect(received).toContain(expected) // indexOf
    Expected substring: "owner_mismatch"
    Received string:    "
        SwiftletSigned in as ticketit-test-ownerSign outApplicationgalleyStatusok..."

[run.sh] status.spec.ts exit code: 0
[run.sh] auth.spec.ts exit code: 1
[run.sh] session-restart-before.spec.ts exit code: 0
[run.sh] session-restart-after.spec.ts exit code: 0
[run.sh] backend-failure.spec.ts exit code: 0
[run.sh] SUITE FAILED
```

**3. Restart persistence specifically defeated**
(`session-restart-after.spec.ts`'s `test.use({ storageState: ... })`
temporarily hardcoded to `undefined`, discarding the saved session —
simulating "the session didn't actually survive") — isolated exactly
one failure, while `session-restart-before.spec.ts` and everything else
stayed green:

```
[run.sh] running tests/session-restart-before.spec.ts (signs in, saves storage state)
  ✓  1 › the Owner signs in before Galley restarts (168ms)
[run.sh] restarting galley (same database, same origin, new process) to prove the session survives
[run.sh] running tests/session-restart-after.spec.ts against the restarted galley
  ✘  1 › the session survives a Galley restart (5.1s)

    Error: expect(locator).toBeVisible() failed
    Locator: getByTestId('app-shell')
    Expected: visible
    Error: element(s) not found

[run.sh] status.spec.ts exit code: 0
[run.sh] auth.spec.ts exit code: 0
[run.sh] session-restart-before.spec.ts exit code: 0
[run.sh] session-restart-after.spec.ts exit code: 1
[run.sh] backend-failure.spec.ts exit code: 0
[run.sh] SUITE FAILED
```

All three breaks were reverted (confirmed via `git diff`/`grep` against
the intended source before the next run) and the suite returns to
`SUITE PASSED` with all 8 specs green — the final green transcript
above is that confirming run.

## Implementation limitations and follow-ups

- **The non-owner rejection page is Galley's raw JSON error response,
  not a styled Swiftlet screen.** Because the OAuth callback is a
  top-level browser redirect that lands directly on Galley's own
  response (see "Non-owner rejection" above), there is no point at
  which Swiftlet code runs to format it. This satisfies the issue's
  literal requirement (Galley's exact reason, verbatim, with no
  authenticated shell rendered) and, per ADR 0001, keeps Swiftlet from
  ever being in a position to reinterpret or soften Galley's decision
  — but it is a plain, unstyled page, not integrated into the sign-in
  page's own look. Making this a styled in-app message would need
  Galley's callback to redirect back to Swiftlet with an error
  indicator instead of answering directly, which is a contract change
  and a behavior change to #54's already-tested callback error paths —
  judged out of proportion to this slice and not requested by the
  issue's acceptance criteria. No specific follow-up issue exists;
  natural owner is whichever milestone next revisits the sign-in UX
  (plausibly polish work in a later M2 slice or M10).
- **Local development (not `e2e/`) needs one manual setting to see the
  same behavior**: running Galley and Swiftlet's dev server by hand
  requires setting `GALLEY_BASE_URL` to Swiftlet's dev-server origin
  (e.g. `http://localhost:5173`), or the OAuth callback redirects to
  Galley's own bare API root instead of back to the signed-in shell.
  Documented in `apps/swiftlet/README.md`, "Galley address
  configuration" — not a follow-up, since it is fully documented and
  costs one extra environment variable, the same shape as every other
  already-documented local-dev setting in this repository.
- **Real-provider (github.com) verification remains out of scope**,
  unchanged from #54's own recorded limitation — **M10**, per that
  issue and `apps/galley/README.md`.
- **No CI wiring**, unchanged from every prior M2 slice's own recorded
  limitation. Same owner as before: [#62](https://github.com/cristoforows/ticketIt/issues/62)
  or a dedicated CI-setup slice.
- No other required behavior in issue #55 was left unimplemented; every
  acceptance criterion is satisfied and verified above.

## Outstanding checks and owning milestone

- **Real-provider (github.com) verification** — **M10**.
- **CI automation** of the commands recorded here — no owning issue
  yet.
- **Styling the non-owner-rejection response as an in-app message**
  (see "Implementation limitations" above) — no owning issue yet;
  natural owner is a later sign-in-UX polish slice or M10.
- **Domain/Ticket routes actually adopting Swiftlet-side
  session-awareness beyond the shell shown here** —
  [#56](https://github.com/cristoforows/ticketIt/issues/56) is the
  first slice expected to add real protected domain routes.

## Decision impacts (open-decision IDs)

None of D1, D2, D4–D9 are resolved or touched by this slice. D3 is
unrelated — this slice has no Agent, Round, or execution concept, per
M2's scope rule. This record's decision-relevant content is entirely
the engineering choices this slice made and records: refactoring
`internal/githubfake` into a `testing.TB`-independent `Start` plus a
thin `New` wrapper, the `/_fake/identity` control-plane endpoint
design (preset-based, not raw id/login, to keep the browser-side
helper simple), routing `GALLEY_BASE_URL` through Swiftlet's own origin
for the whole OAuth round trip, and the fourth ("error") session state
in `App.tsx` beyond the issue's literal two-state framing. None of
these are open product decisions requiring D-series resolution. This
slice provisions no paid resource and creates no provider account, per
`AGENTS.md`'s "Paid resources" rule — `cmd/githubfake` is a local,
non-secret, test/development substitute, and no real GitHub OAuth app
was created or configured anywhere.
