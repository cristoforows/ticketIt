# M1.6 — OpenCode questions, permission requests, and event reconciliation

## Purpose

Prove the question/permission/reconnect part of feasibility experiment S1
("OpenCode lifecycle and control", `docs/integration-feasibility.md`) for
[M1.6 — OpenCode questions, permission requests, and event reconciliation
(#17)](https://github.com/cristoforows/ticketIt/issues/17): a scripted tool
call that requires permission (and, if supported, a question) can be
observed through both the live event stream and a pending-state query,
replied to through the SDK, and the session continues correctly; dropping
and re-subscribing the event stream does not lose or duplicate a pending
request; duplicate replies are handled one way or the other but never
double-execute a side effect; and "once" versus "always" permission
replies have an observable, recordable effect on later requests. This
extends `experiments/opencode-harness/` (built for
[M1.5 #16](https://github.com/cristoforows/ticketIt/issues/16)) rather
than creating a new package, per this issue's instructions, since later
M1 slices (#18–#20) depend on the same package.

## Exact versions

Identical to `docs/evidence/m1/16-opencode-boot.md` (same package, same
lockfile, nothing re-pinned for this slice):

- Node: `v26.9.0` (matches `experiments/.nvmrc` and `engines.node`)
- npm: `11.19.1`
- OS: macOS (Darwin 25.6.0), arm64
- `typescript`: `7.0.2`, `tsx`: `4.23.13`, `@types/node`: `26.6.1` (devDependencies, exact)
- `opencode-ai` (executable) and `@opencode-ai/sdk` (SDK): `1.18.31` each,
  released together — see 16-opencode-boot.md for the version-pairing
  rationale; unchanged here.
- Test runner: `node --import tsx --test`.

## Reproducible commands

```sh
cd experiments/opencode-harness
rm -rf node_modules
npm ci
npm run typecheck
npm test
```

No env vars or fixture files need to be supplied externally: the stub
server, marker files, and isolated HOME/XDG tree are all created by the
tests themselves under `os.tmpdir()`. Verified three consecutive full
`npm test` runs green (8/8), including one immediately after a clean
`rm -rf node_modules && npm ci`.

## Documentation research (unverified)

Read (not executed against) from the pinned `@opencode-ai/sdk@1.18.31`
package's own shipped TypeScript declarations, in both of its generated
client surfaces:

- **The bare `@opencode-ai/sdk` export** (`dist/gen/types.gen.d.ts`,
  `dist/gen/sdk.gen.d.ts`, already used by `startManagedOpenCode`'s
  `client` for session/prompt/messages since #16): declares a `Permission`
  type (`id, type, pattern, sessionID, messageID, callID, title, metadata,
  time.created`) and two permission events, `EventPermissionUpdated`
  (`type: "permission.updated"`) and `EventPermissionReplied`. It has
  **no `.question` namespace at all** — no question type, no question
  event, no question endpoint declared anywhere in this surface. The only
  permission-reply method is a single top-level
  `postSessionIdPermissionsPermissionId({path:{id,permissionID},
  body:{response:"once"|"always"|"reject"}})`, matching
  `POST /session/{id}/permissions/{permissionID}`.
- **The `@opencode-ai/sdk/v2` subpath export** (`dist/v2/gen/types.gen.d.ts`,
  `dist/v2/gen/sdk.gen.d.ts`, a second generated client shipped in the same
  package, exported via `package.json`'s `"./v2"` entry): declares
  `PermissionRequest` (`id, sessionID, permission, patterns, metadata,
  always, tool?:{messageID,callID}`) and `QuestionRequest` (`id, sessionID,
  questions, tool?`), plus event types `EventPermissionAsked`
  (`"permission.asked"`), `EventPermissionReplied` (`"permission.replied"`),
  `EventQuestionAsked` (`"question.asked"`), `EventQuestionReplied`
  (`"question.replied"`), `EventQuestionRejected` (`"question.rejected"`).
  It also separately declares a third, apparently-unused family
  (`EventPermissionV2Asked`/`"permission.v2.asked"`,
  `EventQuestionV2Asked`/`"question.v2.asked"`, etc.) that this experiment
  never observed emitted. `OpencodeClient.permission` (class `Permission`)
  exposes `.list({directory?,workspace?})`, `.reply({requestID,reply:"once"
  |"always"|"reject",message?})`, and a `@deprecated` `.respond({sessionID,
  permissionID,response})`. `OpencodeClient.question` (class `Question`)
  exposes `.list()`, `.reply({requestID,answers})`, `.reject({requestID})`.
  A nested `client.v2.session.permission`/`.question` (classes `Permission2`/
  `Question2`) additionally declare a per-session-scoped
  `list({sessionID})` — see "Observed limitations" for why this was not
  used.
- `docs/integration-feasibility.md`'s "Events, questions, permissions" row
  cites [opencode.ai/docs/server/](https://opencode.ai/docs/server/) and
  the [generated v2 types on
  GitHub](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/v2/gen/types.gen.ts),
  and flags "SDK prose and generated versions differ." That flag turned
  out to be true in a stronger sense than expected: it is not just that
  different *releases* of the SDK differ, but that this **one pinned
  package version ships two internally inconsistent generated client
  surfaces** (the bare export vs. the `/v2` subpath), only one of which
  (`/v2`) matches what the actual running server emits — see "Fixture/stub
  evidence" below, which is executed, observed confirmation of this, not
  just a reading of the two `.d.ts` files.
- [opencode.ai/docs/permissions/](https://opencode.ai/docs/permissions/) is
  cited by `docs/integration-feasibility.md`'s "Live grants" row for
  allow/ask/deny and once/always/reject approval responses; this matches
  the `reply`/`response` field literal unions found in both generated
  surfaces above.

## Fixture/stub evidence (observed)

All of the following was actually executed on this machine, not just
read. `npm test` (8 suites total — the pre-existing 3 from #16 plus 5
added by this slice) passed on three consecutive runs, one from a fully
clean `node_modules`; `npm run typecheck` passed with no errors; `ps aux |
grep opencode` after every run showed no leftover process.

**Tool discovery (ad hoc probe, not itself a committed test).**
`client.tool.ids()` against a running managed instance returned:
`["invalid","question","bash","read","glob","grep","edit","write","task",
"webfetch","todowrite","websearch","skill","apply_patch"]`. `client.tool.
list()` for `"bash"` returned parameters `{command: string, timeout?:
integer, workdir?: string}`; for `"question"` returned parameters
`{questions: Array<{question, header, options: Array<{label,
description}>, multiple?}>}`. This confirms `"bash"` and `"question"` are
the registered tool ids `scriptBashToolCall`/`scriptQuestionToolCall`
(`experiments/opencode-harness/src/scripting.ts`) target, and their exact
input shapes.

**Live `/doc` OpenAPI probe (ad hoc, not a committed test).** Fetching
`GET /doc` on a running managed server (an endpoint not mentioned in any
docs page cited by `docs/integration-feasibility.md`, discovered by
probing common OpenAPI doc paths) returned the server's own generated
OpenAPI document: 162 paths total, including both unversioned
(`/permission`, `/permission/{requestID}/reply`, `/question`,
`/question/{requestID}/reply`, `/question/{requestID}/reject`,
`/session/{sessionID}/permissions/{permissionID}`) and `/api/*`-prefixed
routes (`/api/session/{sessionID}/permission`, `/api/permission/saved`,
etc.). This is what confirmed the `/v2` SDK subpath's declared types are
the ones matching the live server, ahead of writing any test.

**Test 1 — permission round trip**
(`test/permission-round-trip.test.ts`, passing). Isolated config set
`permission: { bash: "ask" }` (via `startManagedOpenCode`'s existing
`extraConfig`, itself layered into the fully isolated per-instance config
established by #16 — this is the "isolated project config" referred to by
the issue; a separate on-disk project-root `opencode.json` file was not
additionally introduced since the existing isolation already covers it and
#16's `config-isolation.test.ts` already exercises config-source
precedence directly). A scripted `bash` tool call
(`scriptBashToolCall({command: markerAppendCommand(markerFile)})`) raised
exactly one pending permission request, observed identically both ways:

- Event stream (`subscribeEvents(managed.client)`): a
  `{"type":"permission.asked","properties":{"id":"per_...",
  "sessionID":"ses_...","permission":"bash","patterns":["echo '...' >>
  '...'"],"metadata":{"command":"..."},"always":["echo *"],
  "tool":{"messageID":"msg_...","callID":"call_bash_1"}}}` event.
- Query (`listPending(managed.v2Client, session.id)`, i.e.
  `client.permission.list()` filtered by `sessionID`): the identical `id`.

Replying `replyPermission(managed.v2Client, id, "once")` returned
`{ok: true, error: null}`; the session's `session.prompt()` call (issued
without awaiting it up front, so the wait could be observed) then resolved
once the follow-up scripted turn ("Done after permission.") was delivered.
The marker file had exactly one line. `client.session.get({path:{id}})`
confirmed the session id was unchanged across the wait.

**Test 2 — question round trip**
(`test/question-round-trip.test.ts`, passing). The pinned version **does**
expose a question mechanism — this is a genuine supported feature on
`opencode-ai@1.18.31`, not merely a "closest alternative": a first-class
`"question"` tool (see tool discovery above), a `question.asked`/
`question.replied`/`question.rejected` event triple, and
`GET /question` / `POST /question/{requestID}/reply` /
`POST /question/{requestID}/reject` REST endpoints (via
`client.question.list()`/`.reply()`/`.reject()` on the `/v2` client).
Scripted `scriptQuestionToolCall({questions:[{question:"Which approach do
you want?", header:"Approach", options:[{label:"Option A",
description:"First approach"},{label:"Option B",
description:"Second approach"}]}]})`; observed the same request `id` via
both the event stream (`question.asked`) and `listPending`'s
`questions` array; answered with
`replyQuestion(managed.v2Client, id, [["Option A"]])` → `{ok:true}`. After
continuation, the session's messages contained exactly one `"tool"` part
for that `callID`, `state.status === "completed"`, and
`state.metadata.answers` deep-equal to `[["Option A"]]` — the answer was
delivered to the model exactly once, not duplicated. A second
`listPending` call afterward showed the question no longer pending.

**Test 3 — reconnect recovery**
(`test/reconnect-recovery.test.ts`, passing). With a bash permission
request pending, `subscription.stop()` (which calls
`AbortController.abort()` on the SSE fetch — the only way to drop it
observed in this pinned SDK; `ServerSentEventsResult` exposes no separate
`close()`) was called, then `subscription.closed` awaited to confirm the
background consumption loop actually exited. The exact same request id
was then recovered **purely from `listPending`** (no event replay is
possible once the subscription is stopped) — ids matched exactly. A new
subscription was opened, the recovered id was replied to once, and the
marker file showed exactly one line (no duplicate execution from the
drop/reconnect). Note: the resubscribed stream did not show a distinct
`permission.replied` event for this reply (see "Observed limitations" —
the reply endpoint used matters for whether that event is emitted at
all); continuation was instead confirmed via the session's messages
containing the scripted follow-up text, which is sufficient and is what
the test asserts.

**Test 4 — duplicate reply**
(`test/duplicate-reply.test.ts`, passing). Sending the identical `"once"`
reply twice for the same request id: the first succeeded (`{ok:true}`);
the second was **rejected**, not treated idempotently. Exact observed
error: HTTP 404, body
`{"_tag":"PermissionNotFoundError","requestID":"<id>","message":"Permission
request not found: <id>"}`. The permission-request record is apparently
consumed/deleted on first reply rather than kept around for idempotent
re-acknowledgment. The marker file stayed at exactly one line either way
(the duplicate reply had no side effect, rejected or not).

**Test 5 — once versus always**
(`test/once-versus-always.test.ts`, passing; feeds #20). Replying
`"always"` to a first scripted bash permission request was observed to:

1. **Suppress the ask for a second bash tool call in the same session** —
   polled `listPending` for up to ~4.5s after the second `session.prompt`
   call; no new pending permission ever appeared; the second scripted
   shell command executed directly (marker went from 1 to 2 lines).
2. **Suppress the ask for a bash tool call in a brand-new session created
   afterward in the same project** — same polling/marker-count method; the
   third scripted shell command in the new session also executed directly
   with no permission request at any point (marker went from 2 to 3
   lines).

The original `permission.asked` event/`PermissionRequest` carried an
`always: ["echo *"]` field (a command-pattern glob), suggesting the grant
is stored as a saved, pattern-matched rule rather than a strictly
per-`sessionID` flag — consistent with the `/api/permission/saved` route
seen in the `/doc` probe (not asserted in a committed test; an ad hoc
`client.v2.permission.saved.list()` call returned an empty array in one
exploratory run, so the storage mechanism itself is not conclusively
identified here — only the cross-session *behavioral* effect is, and it
was reproduced consistently across every run of the full suite). This is
exactly the "engine once/always choices are not ticketIt's ticket/time
grant model" risk `docs/integration-feasibility.md`'s "Live grants" row
flags, now confirmed rather than theoretical, and it directly feeds the
admission bridge slice (#20): ticketIt cannot rely on OpenCode's own
"always" being scoped to a Round, a session, or even a Ticket's lifetime.

## Real-provider evidence (observed, or "none executed")

None executed. Every completions request in this experiment went to the
local `StubModelServer` on `127.0.0.1` (asserted by the stub's own request
log in the pre-existing boot test and unchanged here); no API key for a
real provider exists anywhere in this repository or its isolated
environment. `npm ci`/`npm view` package-registry access is the only
network activity, per `experiments/README.md`.

## Observed limitations

- **The bare `@opencode-ai/sdk` export's declared permission/event types
  are stale relative to this pinned build's actual runtime behavior.**
  `Permission`/`EventPermissionUpdated` are never actually emitted by the
  server (only `permission.asked`/`permission.replied`, matching the
  `/v2` subpath's types, were ever observed); the bare export has no
  question support at all. Every new function in this slice
  (`listPending`, `replyPermission`, `replyQuestion`, `rejectQuestion`)
  therefore takes the `/v2` client (`ManagedOpenCode.v2Client`), not the
  original `client`; `subscribeEvents` works with either since `/event`'s
  wire shape is identical regardless of which generated client subscribes
  to it.
- **The seemingly more targeted session-scoped `/v2` query
  (`client.v2.session.permission.list({sessionID})`, hitting
  `/api/session/{sessionID}/permission`) returned an empty array even
  while a permission for that exact session was genuinely pending**
  (confirmed side-by-side against the top-level `client.permission.list()`
  returning the real pending entry at the same instant, in an ad hoc
  spike; not asserted as a negative in a committed test, since asserting
  "this declared-but-apparently-unwired endpoint stays empty forever"
  is a weak, implementation-detail-shaped test). `listPending` therefore
  uses the top-level global `client.permission.list()`/`client.question.
  list()` and filters by `sessionID` client-side instead of the
  session-scoped route the `/v2` types suggest exists for this purpose.
- **Two different, both-functional permission-reply endpoints do not
  emit the same events.** Replying through the *old*
  `POST /session/{id}/permissions/{permissionID}` endpoint (the only one
  the bare `@opencode-ai/sdk` export exposes, as
  `client.postSessionIdPermissionsPermissionId(...)`) was observed, in an
  ad hoc spike, to emit a `permission.replied` event to a live subscriber.
  Replying through the *new* top-level `POST /permission/{requestID}/reply`
  endpoint (what `replyPermission` uses, matching the `/v2` client and the
  live `/doc` document) was not observed to emit that event to a
  subscriber in the same window. Both endpoints accept the same request
  id and both genuinely unblock the tool call (confirmed by the
  follow-up turn and marker file in every committed test). This is not
  asserted as a committed test (a negative "no event appears" assertion
  over a fixed polling window is inherently timing-sensitive/flaky), but
  it is a real, reproducible discrepancy: a future slice that reconciles
  purely by watching for `permission.replied` on the event stream, rather
  than also re-querying pending state, could miss a reply that happened
  through this newer endpoint.
- **The "always" grant's storage/scope was confirmed only behaviorally,
  not structurally.** The cross-session suppression in test 5 is real and
  reproducible; which stored object holds it (project-level saved
  permission, global config, command-pattern cache, etc.) was not
  conclusively identified — `client.v2.permission.saved.list()` returned
  empty in one exploratory check, which is itself worth noting as
  possibly *also* a not-fully-wired endpoint on this build, consistent
  with the other `/v2`-declared-but-inert route found above.
- **No network-drop/backoff reconnection was exercised** — test 3 drops
  the subscription with an explicit clean `AbortController.abort()`, not a
  simulated network failure, and the SDK's own SSE retry/backoff options
  (`sseMaxRetryAttempts`, `sseDefaultRetryDelay`, etc.) were not exercised.
  "Reconnect" here means "a new client-side subscription after an
  intentional stop," which is what the issue's acceptance criteria ask
  for, not resilience to an actual dropped TCP connection.
- **Flakiness and how it was stabilized.** All waits for a pending
  request use a bounded poll (up to 40 attempts × 250ms = 10s, or 15
  attempts × 250ms = ~3.75s where a negative result — "no new request
  raised" — is the expected outcome) rather than a fixed sleep, since the
  stub/engine's exact scheduling is not guaranteed. One genuine bug was
  found and fixed during development, not from engine flakiness:
  `StubModelServer`'s turn queue only shifts while more than one turn
  remains (`nextTurn()`'s last item is "sticky" and repeats until more
  turns are enqueued), so `test/once-versus-always.test.ts` originally
  interleaved `enqueueTurn` calls between `session.prompt()` calls and
  intermittently consumed the previous round's leftover text turn instead
  of the newly-queued tool call, silently skipping an expected tool
  execution. The fix (documented in that test file) is to queue every
  round's turns upfront in consumption order; this is a real, documented
  gotcha for anyone else scripting multiple sequential prompts against the
  same `StubModelServer`, not something this slice papered over. With
  that fix, three consecutive full `npm test` runs were all 8/8 green.
- Only a single project/config per managed instance was exercised; whether
  "always" persists across separate `startManagedOpenCode` processes
  (rather than separate sessions within one process) was not tested.

## Outstanding checks and owning milestone

- Abort/cancel of blocked or running work while a permission or question
  is pending, and observed process/tool state before reporting Stopped —
  routed to [#18](https://github.com/cristoforows/ticketIt/issues/18).
- Fixed inputs (settings/skill/recipe versions staying pinned across a
  pause/resume) and durable human input across a process restart (not
  just a dropped-then-resumed SSE subscription within the same process) —
  routed to [#19](https://github.com/cristoforows/ticketIt/issues/19).
- Reconciling engine "once"/"always" behavior against ticketIt's
  ticket-based/time-based Temporary Permission model, and building the
  admission-control layer the "always"-crosses-sessions finding above
  shows is necessary — routed to
  [#20](https://github.com/cristoforows/ticketIt/issues/20).
- The `permission.replied`-event-vs-endpoint discrepancy and the inert
  session-scoped `/v2` permission/question routes were observed but not
  root-caused (would require reading the upstream server's own source,
  not just its shipped `.d.ts` files and live `/doc` output); flagged here
  for whichever milestone next needs event-vs-query reconciliation
  guarantees (#20, and later M7/M8 real-adapter verification).
- Live permission/disconnect admission (S2), OpenRouter payload fidelity
  (S4), and GitHub delivery/identity (S5) are unrelated separate M1
  experiments, not covered here.
- The gate-report slice
  ([#29](https://github.com/cristoforows/ticketIt/issues/29)) owns
  reconciling `docs/evidence/m1/README.md`,
  `docs/integration-feasibility.md`, and `docs/open-decisions.md` against
  this and other M1 evidence.

## Decision impacts (open-decision IDs)

- **D1** (Enforceable OpenCode action boundary and disconnect behavior):
  the once-versus-always finding is direct evidence that OpenCode's own
  permission memory cannot be treated as ticketIt's authority boundary —
  an "always" grant was observed to outlive the session it was granted in
  and to apply to a brand-new session in the same project, meaning a
  Round/Ticket-scoped revocation on ticketIt's side would not by itself
  stop the engine from silently auto-approving a later action if the
  underlying process/project were reused. This does not resolve D1; it
  supplies the concrete "if required behavior cannot be gated, choose an
  integration change or obtain an explicit requirement decision" trigger
  D1 anticipates — the requirement decision is routed to #20.
- **D8** (In-flight manual revocation and non-budget execution limits):
  the duplicate-reply finding (a second reply to an already-resolved
  permission request is rejected with a 404
  `PermissionNotFoundError`, not silently re-applied or re-executed) is
  evidence that this pinned engine does not double-execute a side effect
  from a stale/duplicate authorization message, which is a precondition
  for D8's "subsequent actions must observe revoked authority" /
  "already-dispatched handling" framing — but it is only evidence about
  *duplicate replies to the same request*, not about revoking authority
  for a *different, later* request once one has already been granted
  (that is exactly the once-versus-always/D1 finding above). Neither
  finding resolves D8; both are inputs to the admission-bridge design
  work routed to #20.
