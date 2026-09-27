# Swiftlet

ticketIt's frontend: React + TypeScript, built with Vite. This slice
(issue #50, "M2.2 — Swiftlet boots and displays Galley-provided
status") adds a single page that fetches `GET /api/status` from Galley
and renders `application`, `status`, `version`, `environment`, and
`startedAt` exactly as Galley returns them. There was no routing, no
authentication, and no Tickets yet — [issue #55](https://github.com/cristoforows/ticketIt/issues/55)
later added sign-in (see "Sign-in, the authenticated shell, and
sign-out" below), [issue #56](https://github.com/cristoforows/ticketIt/issues/56)
added the first Ticket list and quick capture (see "The Ticket list and
quick capture" below), and [issue #57](https://github.com/cristoforows/ticketIt/issues/57)
added client-side routing and the canonical full-page Ticket detail
view (see "Routing and the Ticket detail page" below), and
[issue #58](https://github.com/cristoforows/ticketIt/issues/58) added
manual refinement -- editing a Ticket's title and its four refinement
fields by hand from that same full page (see "Manual refinement
fields" below), and [issue #59](https://github.com/cristoforows/ticketIt/issues/59)
added the two built-in Ticket Templates, a Template selector on quick
capture, and the full page's Template/completion-condition/repository/
Pull-Request presentation (see "Ticket Templates" below). See
[docs/deployment.md](../../docs/deployment.md) and
[docs/adr/0001-single-authority-galley.md](../../docs/adr/0001-single-authority-galley.md):
Swiftlet renders what Galley returns and never owns a workflow rule.

This app builds, tests, and runs entirely independently of the Go
toolchain. Galley does not exist yet (issue #49, in parallel); this app
is built and tested against the documented `/api/status` shape with a
stubbed `fetch`, not a live backend.

[Issue #51](https://github.com/cristoforows/ticketIt/issues/51) later
bound this app's status types to
[`contracts/openapi.yaml`](../../contracts/openapi.yaml), ticketIt's
single source of truth for Galley's HTTP API — see
[`contracts/README.md`](../../contracts/README.md) for the contract-
first convention every later slice follows, the regeneration command,
and the drift check. `src/api/status.ts`'s runtime behavior (its
fetch, its own shape validation, its error messages) is unchanged by
that refactor; only its types now come from the generated schema. This
app's own `npm ci`/`npm test`/`npm run build` still never install or
run anything Go- or codegen-toolchain-shaped — the generated schema is
committed (`src/api/generated/schema.d.ts`).

## Prerequisites

- Node **26.9.0** (pinned in `package.json`'s `engines.node`, matching
  `experiments/.nvmrc`). Use npm.

## Install

```sh
cd apps/swiftlet
npm ci
```

## Dev server

```sh
npm run dev
```

Starts the Vite dev server (default `http://localhost:5173`). The page
fetches `/api/status`, which the dev server proxies to Galley — see
"Galley address configuration" below.

### Galley address configuration

**Single documented place:** `vite.config.ts`'s `server.proxy` block.
It reads the `GALLEY_PROXY_TARGET` environment variable and proxies all
`/api/*` requests there, falling back to `http://localhost:8080`
(Galley's planned local address) when the variable is unset:

```sh
GALLEY_PROXY_TARGET=http://localhost:9090 npm run dev
```

You can also put `GALLEY_PROXY_TARGET=...` in a `.env` or `.env.local`
file in this directory (loaded via Vite's `loadEnv`, which is not
restricted to the `VITE_`-prefixed convention since it only affects the
dev/build-time proxy, not client bundle code); `.env.local` is
gitignored. The same variable applies to `npm run preview`.

**For sign-in to work against a locally running Galley (issue #55),
also set Galley's own `GALLEY_BASE_URL` to this dev server's origin**
(e.g. `GALLEY_BASE_URL=http://localhost:5173`), not Galley's own
address. The browser only ever reaches Galley through this proxy
(`apps/galley/README.md`, "CORS"), so Galley's OAuth callback redirect
to `/` must resolve against *this* origin to land back on the signed-in
shell rather than on Galley's own bare API root — see
`e2e/README.md`, "Signing in," for the same setting applied to the
browser suite.

## Build

```sh
npm run build
```

Type-checks the whole program with `tsc -p tsconfig.json --noEmit`,
then produces a production build with `vite build` into `dist/`.

## Test

```sh
npm test
```

Runs `vitest run` (a single non-watch pass, suitable for CI and the
`npm ci && npm test && npm run build` verification sequence). Use
`npm run test:watch` for local iteration. See
[docs/evidence/m2/50-swiftlet-boot.md](../../docs/evidence/m2/50-swiftlet-boot.md)
for the tooling rationale (Vite/Vitest over the M1 `experiments/`
convention of `node --test` + `tsx`).

Tests stub `global.fetch` (`vi.stubGlobal`) and cover:

- a successful response — every rendered field matches the stub's data,
  and only those fields;
- a non-2xx response (e.g. `503`) — an explicit error state, no
  placeholder values;
- an unreachable backend (`fetch` rejects) — an explicit error state;
- a malformed/schema-mismatched response — an explicit error state,
  since a value that doesn't match the documented shape must not be
  guessed at or partially rendered.

`src/App.test.tsx`, `src/components/AppShell.test.tsx`, and
`src/components/SignInPage.test.tsx` (issue #55) cover the session-aware
shell the same way: a stubbed `fetch` routed by path (`/api/session` vs.
`/api/status`), the loading/signed-out/signed-in/error states App.tsx
renders, and AppShell's sign-out (success, a non-401 failure leaving the
shell in place with an inline error, and a 401 treated as already
signed out).

No browser/end-to-end tests are included here; issue #53 establishes
that harness, and issue #55 adds the authenticated specs to it.

## Regenerating types from the contract

`src/api/generated/schema.d.ts` is generated from
[`contracts/openapi.yaml`](../../contracts/openapi.yaml) and committed
(never hand-edited). After editing the contract, regenerate it via
`contracts`' own, separate toolchain — not this app's:

```sh
cd contracts
npm ci
npm run generate:swiftlet
```

See [`contracts/README.md`](../../contracts/README.md) ("Why a
separate `contracts/package.json` for codegen") for why this isn't an
`npm run generate` script in this `package.json`: the generator
(`openapi-typescript`) needs a different major version of TypeScript
than this app is pinned to, purely for its own code-generation
internals, and isolating that in `contracts/` keeps that version
conflict from ever touching this app's own dependency tree.

## What this app renders, and where from

`src/api/status.ts` fetches `/api/status`, typed against the generated
`components["schemas"]["StatusResponse"]` (`GalleyStatus`), and
validates the response matches the documented shape:

```json
{
  "application": "galley",
  "status": "ok",
  "version": "dev",
  "environment": "development",
  "startedAt": "2026-09-21T10:00:00Z"
}
```

`src/components/StatusView.tsx` renders exactly those five fields, and
nothing else. Every rendered value is sourced from the parsed response
object; there is no local fallback, default, or hardcoded status string
that could be mistaken for backend data. Any fetch failure, non-2xx
response, or shape mismatch renders an explicit error state
(`role="alert"`, `data-testid="status-error"`) instead.

## Sign-in, the authenticated shell, and sign-out (issue #55)

`src/App.tsx` queries `GET /api/session` once on load and renders
exactly one of: a loading state, the sign-in page
(`src/components/SignInPage.tsx`), the authenticated shell
(`src/components/AppShell.tsx`), or an explicit error state (any
session-check failure other than `401`, e.g. Galley entirely
unreachable) — never a guess, and never more than one at a time.

**Swiftlet holds no OAuth secret and performs no token exchange.**
`SignInPage`'s one action is a plain anchor to
`/api/auth/github/start` — a real browser navigation, not a `fetch` —
which leaves the app entirely for Galley's own authorize/callback flow
and the (real or substitute) GitHub provider; Swiftlet's own code never
sees a `code`, a `state`, or an access token. On success, Galley's
callback redirects back to `/`, where `App.tsx` re-queries
`/api/session` and renders the shell.

**Non-owner rejection is not intercepted or reworded.** Galley's
`/api/auth/github/callback` answers a rejected identity with its own
JSON error body directly (`owner_mismatch`, `403`) on that same
navigation — Swiftlet never receives control in between, so there is no
Swiftlet code that could substitute a friendlier message even by
accident. See `docs/evidence/m2/55-swiftlet-sign-in.md` for the browser
spec that asserts Galley's exact reason appears verbatim and that no
part of the authenticated shell renders.

`AppShell` shows the signed-in Owner's login and offers sign-out
(`src/api/session.ts`'s `signOut`, `DELETE /api/session`); on success or
on a `401` (already signed out) it returns to the sign-in page, and on
any other failure it shows an inline error and stays in the shell.
`src/api/session.ts`'s `UnauthenticatedError` is the one signal every
authenticated call in this app treats as "return to the sign-in page" —
the same rule `App.tsx`'s own initial session check follows. `AppShell`
passes App's sign-in callback to both Ticket containers: a `401` from
list/detail loading, capture, edit, or a workflow command returns to
sign-in instead of displaying an inline Ticket error.

Swiftlet enforces no authorization rule of its own here: it renders
whichever of Galley's own responses it receives (`docs/adr/0001-single-authority-galley.md`).
Every rule this depends on — restricting sign-in to the configured
Owner, session validity, sign-out revocation — is Galley's, and is
covered by Galley's own direct-API tests (`apps/galley/internal/httpapi`,
issue #54); this slice added no new Galley behavior.

## The Ticket list and quick capture (issue #56)

`src/components/TicketList.tsx` is the first Swiftlet view of a real
domain record, mounted inside `AppShell` above `StatusView`. It fetches
`GET /api/tickets` (`src/api/tickets.ts`) on mount and renders exactly
one of: a loading state, an explicit error state
(`data-testid="ticket-list-error"`), an empty state
(`data-testid="ticket-list-empty"`, shown for a genuinely empty list —
not the loading or error case), or the list itself, newest first, in
whatever order Galley returned (this component never re-sorts). A
one-field form above it (`data-testid="ticket-capture-form"`) is the
whole of quick capture: a title input and a submit button, disabled
until the trimmed title is non-empty. Capture asks for nothing else —
no work type, no category, no AI (`docs/ticket-creation.md`, "Quick
capture" and "Flexible ticket structure").

**No manual reload after capture.** A successful `POST /api/tickets`
(`src/api/tickets.ts`'s `createTicket`) clears the input and re-fetches
the list; Galley alone decides where the new Ticket sorts
(`apps/galley/README.md`, "Ticket ordering"), so this component never
guesses at the insertion point itself. An older in-flight list response
cannot replace the result of this re-fetch. A rejected capture (Galley's
`invalid_request`, e.g. a blank or over-length title) shows Galley's
own message inline (`data-testid="ticket-capture-error"`) and leaves
the list exactly as it was — no re-fetch, since nothing changed.

Every Ticket call reuses `src/api/session.ts`'s `UnauthenticatedError`
convention (a 401 is not a special "ticket" error, just the existing
"return to the sign-in page" signal every authenticated call in this
app already shares). Swiftlet performs no validation or ownership check
of its own here: title trimming, the 200-character maximum, and
scoping the list to the signed-in Owner are all enforced by Galley
(`apps/galley/internal/httpapi/ticket.go`), proved by Galley's own
direct-API tests, not by anything in this app
(`docs/adr/0001-single-authority-galley.md`).

Out of scope for this slice (`apps/galley` issue #56's own "Not in
scope" list): a board, a modal, Badges, archiving (all M3); Assignee,
Template, and Status controls
([#59](https://github.com/cristoforows/ticketIt/issues/59),
[#60](https://github.com/cristoforows/ticketIt/issues/60),
[#61](https://github.com/cristoforows/ticketIt/issues/61)); any AI.
None of these has a placeholder here.

## Routing and the Ticket detail page (issue #57)

**Router choice: a hand-rolled ~50-line reader of
`window.location.pathname` (`src/router.ts`), not a routing library.**
No router was installed before this slice, and this slice needs exactly
two routes — the Backlog list (`/`) and a Ticket's full-page detail
view (`/tickets/:id`). A third-party router (`react-router`,
`@tanstack/router`, ...) would add a dependency, its own API surface,
and (for the data-loader-style routers) a data-fetching convention this
app does not otherwise use, for capability the platform already
provides for two fixed routes. This mirrors
`apps/galley/README.md`'s own "Router choice" for the same reason at
the same proportional scale (`net/http.ServeMux` over `chi`/`gorilla/
mux` for "a handful of fixed routes with per-method dispatch") — revisit
this choice explicitly, the same way that section asks Galley's own
routing decision to be revisited, if a future milestone's routing needs
grow past two fixed paths (nested routes, route guards, code-splitting
per route).

`useRoute()` reads `window.location.pathname` via `useSyncExternalStore`,
subscribed to the browser's native `popstate` event; `navigate(path)`
calls `history.pushState` and then dispatches a synthetic `popstate`
event itself, since `pushState` alone fires no event — this is what
lets one subscription handle both an in-app `Link` click and a real
browser back/forward. `src/components/Link.tsx` is a real `<a href>`
(so middle-click, ctrl/cmd-click, and "open in new tab" behave exactly
as a plain link) that calls `navigate()` on an unmodified left click
instead of a full page load. Any path other than exactly `/` or
`/tickets/:id` falls back to rendering the Backlog view — only a Ticket
identifier needs its own not-found presentation in this slice (see
below), not an arbitrary unmapped route. Malformed percent encoding in a
Ticket URL also falls back to Backlog rather than crashing the router.

**A reload of `/tickets/:id` renders the same page, not a 404** —
confirmed directly against the production build (`vite preview`,
`curl -i http://.../tickets/some-id` returns the built `index.html`,
`200`) and by the browser suite's own reload assertion (see
"Browser-to-backend suite" below). This works because Vite's default
`appType: "spa"` (unchanged by this slice — `vite.config.ts` sets no
`appType`) enables its HTML-fallback middleware for both the dev server
and `vite preview`: an unmatched path that accepts `text/html` serves
`index.html` instead of a static 404, which is what lets a client-side
route like `/tickets/:id` exist as a real, reloadable, bookmarkable URL
against a plain static file server. This was verified, not assumed —
see `docs/evidence/m2/57-ticket-detail-page.md` for the exact command
and its output, and for the deliberate, reverted `appType: "mpa"` break
that proves the browser suite's reload spec actually depends on this.

**The full page shows title, Status, and timestamps only** — no
Rounds, Reports, PR links, or Grill Mode section, and no placeholder
implying any of them, since none exist yet
(`docs/ticket-views.md`, "Ticket details"). `src/components/
TicketDetail.tsx` is the presentation: it takes an already-fetched
`Ticket` as a prop and renders exactly those fields, with no fetching
or routing of its own. `src/components/TicketDetailPage.tsx` is the
container: it reads the route's `ticketId`, calls
`fetchTicket(ticketId)` (`src/api/tickets.ts`), and renders exactly one
of a loading state, `TicketDetail`, an explicit not-found state
(`data-testid="ticket-detail-not-found"`, shown on Galley's `404`), or
an explicit error state (any other failure) — never a blank screen or
a raw error for an unknown identifier, per the issue's own acceptance
criterion. Switching between detail URLs remounts the page so the prior
Ticket is hidden while the new one loads.

**This container/presentation split is what issue #57 requires for
M3's modal to reuse this content "without a second implementation."**
M3's ticket-detail modal will need its own container (it will read the
Ticket to show from wherever the modal was opened — a board card, a
list row — rather than from a route parameter, and it will not need
`Link`'s "Back to Backlog" affordance a full page needs), but it can
render the exact same `TicketDetail` component this slice wrote, with
the exact same `Ticket` prop shape, inside that different container.
Nothing about `TicketDetail` itself is specific to being a full page —
it renders no navigation, no route awareness, and no fetch of its own,
which is precisely what makes it as usable inside a modal's chrome as
inside `TicketDetailPage`'s `<section>`.

`src/api/tickets.ts`'s `fetchTicket(id)` mirrors `fetchTickets`'s and
`createTicket`'s existing conventions exactly: `UnauthenticatedError`
on a `401` (the same "return to sign-in" signal every authenticated
call in this app already shares), and a new `TicketNotFoundError` on a
`404` — Galley's own shared not-found response for an unknown
identifier, a malformed one, and one belonging to another Owner alike
(`apps/galley/internal/httpapi/ticket.go`); this app performs no
identifier validation or ownership check of its own, matching
`docs/adr/0001-single-authority-galley.md`.

**The Ticket identifier itself is Galley's opaque public UUID
(`Ticket.id`), not the internal sequential id** — see
`apps/galley/README.md`, "Public identifier," for the full reasoning
and the migration. `TicketList.tsx`'s title now links to
`/tickets/<that id>` (`data-testid="ticket-title"` is unchanged; it is
now the `<a>` itself rather than a `<span>` wrapping plain text).

## Manual refinement fields (issue #58)

`TicketDetail.tsx` (still the same pure-presentation component issue
#57 wrote — no fetching, no routing) gained an edit mode for a
Ticket's `title`, `goal`, `context`, `successCriteria`, and
`constraints` (docs/ticket-creation.md, "Manual guidance"). **No AI of
any kind, and this triggers nothing else** — Save performs exactly one
`PATCH /api/tickets/:id` request when fields changed, with only those
fields, and nothing else in this app reacts to it.

**View mode** shows each refinement field's stored value, or an
explicit "Not set." placeholder for whichever are still empty (a
title-only capture has all four empty). **Edit mode** offers `title`
plus the four refinement fields as plain `<input>`/`<textarea>`
elements — **stored and rendered as plain text only; this app never
parses or renders Markdown anywhere.** Report rendering as Markdown is
explicitly M7's, per issue #58's own scope statement; if a future
slice renders these fields as Markdown, that must be stated explicitly
there and handled safely, not assumed from this slice's plain-text
choice. Each refinement field's `<textarea>` is paired with its
docs/ticket-creation.md guidance prompt, shown verbatim just above it
(`data-testid="ticket-detail-guidance-goal"` etc.) — issue #58's own
acceptance criterion requires these to match the source document
exactly, and `TicketDetail.test.tsx` and
`e2e/tests/ticket-refinement.spec.ts` both assert the literal text.

**Saving delegates to an `onSave` prop**
(`(update: TicketUpdate) => Promise<Ticket>`), supplied by
`TicketDetailPage.tsx`, which calls `updateTicket(ticketId, update)` and
routes a `401` to sign-in — the only place in this app that calls
`src/api/tickets.ts`'s new `updateTicket`. This keeps `TicketDetail`
itself free of fetching, exactly like issue #57's read-only fields
already were, which is what lets a future M3 modal container supply
its own `onSave` and render this exact component unchanged.

**Save sends only fields changed relative to the currently loaded Ticket**
(including `""` when clearing a populated field). An unchanged form
sends no PATCH. Galley's `PATCH /api/tickets/:id` genuinely supports a
partial update (a field absent from the request leaves the stored value
unchanged; present and `""` clears it; present with text stores it — see
`apps/galley/README.md`, "Manual refinement fields," for the full
rule), and that partial-update behavior is proven directly against
Galley by its own tests (`apps/galley/internal/httpapi/ticket_test.go`,
per ADR 0001). Disjoint edits from another tab therefore remain intact
when this tab saves a different field; the edit form still displays all
fields.

**Galley's own rejection message is shown verbatim, never
substituted.** `updateTicket` surfaces `error.message` from Galley's
shared error shape exactly like `createTicket` already does (e.g. an
over-length field, or an attempt to clear the title); a rejected save
leaves the edit form open with the Owner's in-progress edits intact
(`data-testid="ticket-detail-save-error"`), rather than discarding
them or substituting a friendlier message.

**Cancel discards local edits and returns to view mode without ever
calling `onSave`** — no request is sent, and the previously-saved
values are shown unchanged, proven directly
(`TicketDetail.test.tsx`'s "discards edits ... without calling
onSave").

Swiftlet performs no validation, trimming, or length-checking of its
own here: every rule (trimming, per-field maximum lengths, title's
"cannot be cleared" exception, Owner scoping) is enforced and proven
by Galley alone (`docs/adr/0001-single-authority-galley.md`).

## Ticket Templates (issue #59)

Follows the accepted [D3 decision](../../docs/decisions/d3-agent-template-compatibility.md):
a Template supplies presentation, required information, and a
**default** completion condition only. Swiftlet enforces nothing of
its own here either — it renders exactly what Galley returns and lets
Galley alone reject an attempted Template change
(`docs/adr/0001-single-authority-galley.md`).

**Capture (`TicketList.tsx`)** gained a Template selector
(`data-testid="ticket-template-select"`, options from the generated
`TICKET_TEMPLATES` constant, defaulting to `Basic`) beside the existing
title input. A title alone remains sufficient to capture either
Template — the selector adds one more field to the request, nothing
that gates submission.

**The full page (`TicketDetail.tsx`, still pure presentation — no
fetching, no routing)** now also shows, in view mode: the Ticket's
Template (`data-testid="ticket-detail-template"`), its retained
completion condition as friendly text — "Human acceptance" or
"Reviewed pull request merged" (`data-testid="ticket-detail-completion-condition"`) —
and the one repository reference
(`data-testid="ticket-detail-field-repository"`, with the same "Not
set." placeholder convention as the four refinement fields). Edit mode
gained a plain repository input
(`data-testid="ticket-detail-input-repository"`) alongside the
existing refinement fields; **Template itself has no edit control
anywhere on this page** — changing it after creation is out of scope
for M2 (D4, owned by M8) — and completionCondition has no control at
all, since `TicketUpdate` never carries it and Save never sends it.

**A Coding-template Ticket's page additionally shows a Pull Request
section** (`data-testid="ticket-detail-pr-section"`) with an honest
empty state (`data-testid="ticket-detail-pr-empty-state"`): no PR
exists until M8, so this states that plainly rather than fabricating a
field nothing can fill. A Basic-template Ticket renders no such
section at all.

`src/api/tickets.ts`'s `createTicket(title, template?)` sends `template`
(defaulting to `"Basic"`) alongside `title`; `parseTicket` now also
requires `template`, `completionCondition`, and `repository` as
strings on every Ticket response, matching the contract's `required`
list. `TicketUpdate` picked up the generated schema's new optional
`repository` (sent like any other refinement field) and `template`
(never sent by this app — there is no UI path that could construct
one) automatically, with no hand-written change needed beyond the
regenerated `schema.d.ts`.

## Browser-to-backend suite

The tests above stub `fetch`, so they never exercise the real proxy or
a real backend. The browser suite in [`e2e/`](../../e2e/README.md) does:

```sh
cd e2e && ./run.sh
```

It builds this app and serves the production build with `vite preview`,
proxying `/api` to a Galley it starts itself. Since issue #55 it also
starts a real substitute GitHub provider (`apps/galley/cmd/githubfake`)
and drives the actual sign-in/rejection/sign-out/reload/restart flows
through a real Chromium — see `e2e/README.md`, "Signing in." Since
issue #56 it also captures Tickets through the real quick-capture form
and proves they survive a real Galley restart — see `e2e/README.md`,
"Creating test data," and `e2e/tests/ticket-persistence-before.spec.ts`
/ `ticket-persistence-after.spec.ts`. Since issue #57 it also drives
list-to-detail navigation, a direct `/tickets/:id` URL load, a reload
of that URL, and the not-found page for an unknown identifier, against
the real, `vite preview`-served production build — see
`e2e/tests/ticket-detail.spec.ts`. Since issue #58 it also drives the
real edit form to fill in and save the title and all four refinement
fields, asserts the guidance prompts render verbatim, and proves both
reload persistence and persistence across a genuine Galley restart —
see `e2e/tests/ticket-refinement.spec.ts` and
`ticket-refinement-before.spec.ts` / `ticket-refinement-after.spec.ts`.
Since issue #59 it also drives the real Template selector to capture
one Ticket per Template, asserts each shows its own retained
completion condition and (for Coding) the honest Pull Request empty
state, and sets the repository reference on both Templates — see
`e2e/tests/ticket-templates.spec.ts`. The retained-completion-condition-
across-a-restart guarantee is proven at the Go level instead
(`apps/galley/README.md`, "Ticket Templates and the retained
completion condition"), so this spec needs no restart of its own.
