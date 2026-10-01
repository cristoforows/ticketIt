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
not the loading or error case), or the list itself, in whatever order
Galley returned (this component never re-sorts). A
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

**Router choice: a hand-rolled reader of
`window.location.pathname` (`src/router.ts`), not a routing library.**
Issue #57 needed two routes — the list (`/`) and a Ticket's full-page
detail view (`/tickets/:id`). A third-party router (`react-router`,
`@tanstack/router`, ...) would add a dependency, its own API surface,
and (for the data-loader-style routers) a data-fetching convention this
app does not otherwise use, for capability the platform already
provides for a few fixed routes. This mirrors
`apps/galley/README.md`'s own "Router choice" for the same reason at
the same proportional scale (`net/http.ServeMux` over `chi`/`gorilla/
mux` for "a handful of fixed routes with per-method dispatch") — revisit
this choice explicitly, the same way that section asks Galley's own
routing decision to be revisited as routing needs grow.

**M3.2 (#88) reevaluation:** `/board` is a third fixed route. M3.3
(#89) adds modal background state to the existing history subscription
without a new URL pattern. There are still no nested routes, guards, or
data loaders; revisit the router choice if later routes demand them.

`useRoute()` reads `window.location.pathname` via `useSyncExternalStore`,
subscribed to the browser's native `popstate` event; `navigate(path)`
calls `history.pushState` and then dispatches a synthetic `popstate`
event itself, since `pushState` alone fires no event — this is what
lets one subscription handle both an in-app `Link` click and a real
browser back/forward. `src/components/Link.tsx` is a real `<a href>`
(so middle-click, ctrl/cmd-click, and "open in new tab" behave exactly
as a plain link) that calls `navigate()` on an unmodified left click
instead of a full page load. Any path other than `/`, `/board`, or
`/tickets/:id` falls back to rendering the list — only a Ticket
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

**M3.3 reuses this split:** `TicketDetailModal` wraps the same
`TicketDetailPage` fetch/command container with modal presentation; both
presentations render the same `TicketDetail` and all its controls.
Only the full-page presentation shows "Back to Backlog."

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

## Galley-published Ticket actions (issue #87)

Ticket detail workflow controls use each Ticket's Galley-published
`allowedActions.statusChanges` and `allowedActions.accept`. Unavailable
Accept shows Galley's supplied reason; a stale control rejected by
Galley still shows the live rejection. `parseTicket` requires these
fields on every list, detail, and command response. No workflow table
or Accept message is maintained in Swiftlet. Run `npm test` and
`npm run build` here; `e2e/tests/ticket-allowed-actions.spec.ts` compares
full-page controls with live API values for Backlog and both In Review
completion conditions through `cd e2e && ./run.sh` from repo root.

## Status board (issue #88)

`/board` and `/` are switchable through the authenticated shell's List /
Board links. The board calls the same `GET /api/tickets` as the list;
there is no board endpoint or separate Ticket state. Capture stays on
the list. Each of six Status sections renders even when empty, in
lifecycle order: Backlog, Ready, In Progress, Blocked, In Review, Done.
Cards show title and Template and link to `/tickets/:id`. Nothing on
the board starts or controls execution.

Within each Status, cards retain Galley's list order, the Owner's
priority order (`apps/galley/README.md`, "Ticket ordering"). Grouping only filters
the returned array by its persisted Status; Swiftlet does not infer a
Status or reorder Tickets. An unrecognized Status produces an error
instead of silently dropping a Ticket. Load, non-2xx, and expired
session use the same conventions as the list.

Styling uses Tailwind CSS 4 through `@tailwindcss/vite`. `src/styles.css`
imports its theme and utilities, without Preflight, so the existing
native typography and form styles remain. Board layout and modal
presentation use utility classes; there is no separate board stylesheet.

## Board moves (issue #90)

Board cards support native HTML5 drag-and-drop and a keyboard-operable
Radix UI Dropdown Menu for `Move to…`. Both submit the same
`changeTicketStatus` command (`POST /api/tickets/:id/status`). Drop
highlights and buttons follow that Ticket's `allowedActions.statusChanges`
from Galley. Done is excluded from both targets; only the explicit
Accept command in Ticket detail reaches Done. No reordering or Stop
command is attached to dragging.

The board waits for Galley's returned Ticket before relocating a card
and replacing its offered moves; a rejection keeps the last displayed
card in place and shows Galley's message. During a pending move, its
card reports `aria-busy`, and its detail link is `aria-disabled` and
cannot open a stale modal through a plain click. It becomes available
again after success or rejection. After a keyboard move settles, either
way, focus returns to that card's `Move to…` control; a later collection
read does not move it back to a Ticket whose modal closed earlier. A successful command also
starts a fresh collection read: an overlapping modal-close GET cannot
lose edits to other Tickets or replace the returned Ticket. Native drag
events need no new dependency and are driven by Playwright's `dragTo` in
`e2e/tests/ticket-board-moves.spec.ts`. Run `npm test && npm run build`
here and `cd e2e && ./run.sh` from the repo root.

## Ticket detail modal (issue #89)

Clicking a Ticket link in `/` or `/board` opens its detail in a Radix UI
Dialog over the mounted collection. Address bar shows canonical
`/tickets/:id`; an unmodified click pushes a history entry carrying the
background view and a page-load identifier. Back, Escape, or Close
returns to that view at its existing scroll position; Forward reopens
the modal. Modified clicks/new tabs remain ordinary links. A page
reload or direct navigation has a new page-load identifier, so the
same URL renders the dedicated full page. "Open full page" replaces the
modal history entry with the full-page presentation (its URL stays the
same). The dialog moves focus inside, traps keyboard focus, hides the
background from assistive technology (`aria-hidden`) and blocks its
pointer events; closing returns focus to the originating Ticket
link, including its new board position after a Status change.

`TicketDetailModal` renders `TicketDetailPage` in modal mode: one fetch
and owner-command implementation supplies both presentations with the
same `TicketDetail` fields and controls. On return, the still-mounted
list or board re-fetches `GET /api/tickets` without removing its rows
while loading; Galley determines the Ticket's current title, Status,
ordering, and placement. A failed refresh shows an error beside the
last-good rows, retaining scroll and focus. A command that finishes
after Close or Back triggers another Galley refresh, superseding any
response fetched before that command committed. Refocus is limited to
the originating collection, not later view navigation, and never takes
focus the Owner has already moved elsewhere. No API or
workflow change was needed. Run `npm test && npm run build` here and
`cd e2e && ./run.sh` from repo
root; `e2e/tests/ticket-modal.spec.ts` covers both views and mutations.

## Badges (issue #91)

List rows and board cards render Badge names from each Galley Ticket.
Full-page detail and its modal share one picker: open **Add badge**,
select an unattached existing Badge and **Attach badge**, or enter a
name and **Create and attach**. The latter submits creation then
attachment as two commands; if attachment fails after creation, that
Badge stays reusable in the picker. Validation and ownership remain
Galley's rules; `duplicate_badge_name` and other rejected commands show
Galley's `error.message` inline. Ticket parsing requires `badges` on
every response, including list and commands. Use `npm test && npm run build`
here; `cd e2e && ./run.sh` at repo root covers real creation,
reuse, modal/list/board, rejection, and restart persistence.
An attach `404` shows Galley's "no ticket or badge" message; other
Ticket commands retain their existing `TicketNotFoundError` handling.
Closing and reopening the picker retries a failed Badge list load and
clears the old error when the retry starts.

## Badge filter and detach (issue #92)

List and board share a multi-select **Filter by Badge** control. Each
selection adds a repeated `badgeId` query parameter; Galley returns
Tickets carrying any selected Badge. The query stays in the URL across
reload, List/Board navigation, modal open/close, and Open full page
followed by Back to Backlog. **Clear filter** removes the selected
Badges. An empty match displays an explicit empty state; the capture
form remains available. Full-page detail and modal
each offer **Remove** beside attached Badges and display Galley's
returned Ticket after detach. Closing the modal refreshes the filtered
collection, so a Ticket that no longer matches disappears. Run
`npm test && npm run build` here and `cd e2e && ./run.sh` at the root.

## Archive a Ticket (issue #93)

Detail and modal offer **Archive** with confirmation. Galley returns the
retained Ticket; the modal closes to its original view, which refreshes
without the archived Ticket. Full-page Archive returns to the view the
Ticket was opened from, keeping any Badge filter: Board Ticket links
carry `from=board` in their URL, so the origin survives a new tab and
reload. A detail URL without it returns to the List. A direct Ticket URL remains readable with
its Status, fields, Badges and Archived timestamp. Edit, Assignee, Badge
and Archive controls are disabled and show Galley's read-only reason.
The board and default list exclude archived Tickets, including while a
Badge filter is selected. The Archived filter and Restore arrive in #94.
Run `npm test && npm run build` here and `cd e2e && ./run.sh` at the root.

## Archived filter and Restore (issue #94)

The list's **Archived** checkbox stores `archived=true` in the URL and
loads archived Tickets from Galley. It composes with the multi-Badge
filter and survives reload. The board still shows unarchived Tickets
even when its URL carries `archived=true`, so switching back to the list
keeps the Owner's Archived selection. Archived detail and modal offer
**Restore**; Galley's returned Ticket replaces the displayed state,
including Ready becoming Backlog. On modal close, the archived collection
refreshes and the restored Ticket leaves that view. Use
`npm test && npm run build` here and `cd e2e && ./run.sh` at the root.

## Agents and Agent assignment (issue #127)

**Agents** in the shell's Settings navigation opens `/agents`: Galley's
Agent list with each kind, a **New Agent** form (name and kind; kind is
fixed once created) and a per-row **Rename**. Escape cancels a rename
and returns focus to its button. Every change reloads the list from
Galley, and Galley's rejection, such as a duplicate name, is shown
verbatim.

The receipt's **Assign to** select offers **Me** first, then Galley's
Agents in its order; **Assign** sends the choice and **Unassign** clears
it. Choosing another Assignee replaces the current one. The receipt and
Board slip show the assigned Agent's name, or Owner / Unassigned. If
Agents cannot load, **Me** is still offered. Use
`npm test && npm run build` here and `cd e2e && ./run.sh` at the root.

## Agent readiness (issue #128)

Swiftlet never decides readiness itself. When Galley's
`requestingAgentWork` is true, the receipt and the Board slip show
**Queued for <Agent name>** as a `QueuedTag`. It uses the `tag` cva's `queued` variant: an outline in the Ready deep colour on paper (4.74:1), unlike the transient `PendingTag`.

Galley's reasons appear beside the control that caused them:

- **Status control:** each `allowedActions.statusChangeRejections` entry
  is shown there as "<Status>: <message>", and so is a refused status
  command.
- **Assignee control:** a refused assignment is shown below it.
- **Save area:** a refused save is shown there.

`GalleyError` carries the error's `missing` list. A **Missing** marker then
appears on each listed field, both on the receipt and in the edit form.
The field's value element or input names the marker and Galley's message in `aria-describedby`. The marker is an `InlineError` with `announce={false}`, so it is not an alert.
`parseTicket` requires `requestingAgentWork` and `statusChangeRejections`.
`e2e/tests/agent-readiness.spec.ts` walks both orderings.

## Runner pairing and health (issue #130)

The shell header shows a runner pill: **Runner connected**, **Runner
disconnected** with how long ago Galley last heard from Michelin, or
**Runner not paired**. It reads `GET /api/runner-health` every 10 s and
at once after a pair or revoke. Galley derives the state from its own
clock, so the pill never compares timestamps with the browser's clock.
Only the state label is a live region; the pill does not animate.

`/agents` has a **Runner** section. **Pair runner** issues a credential
and shows it once, with **Copy** and the instruction to put it in
`apps/michelin/.env` as `MICHELIN_RUNNER_TOKEN` (`chmod 600 .env`).
**Done** drops it from the page. **Pair again** and **Revoke** each ask
for an in-page confirmation (Escape or **Cancel** backs out); after
pairing again the page says the previous credential is revoked.
Disconnecting or revoking changes no Ticket.

## Priority order (issue #131)

The list and each board stage show Galley's priority order. The Owner
reorders within a stage:

- **List and phone board:** **Move up** and **Move down**
  (`src/components/ReorderButtons.tsx`) send `POST
  /api/tickets/{id}/position` with the same-Status neighbour as the
  anchor. At either end of the stage the button is disabled, and its
  title says why. The archived list has no reorder buttons. On the phone
  board they sit in the open slip's action panel, which stays open after
  a move.
- **Desktop board:** dragging onto another slip in the same stage places
  the Ticket before that slip on its upper half, and after it on its lower
  half, with a line showing where it will land. Dropping on another stage
  is still a Status move.

After each move, successful or rejected, the view refetches and renders
what Galley returned; it never reorders locally. A rejection shows
Galley's message (`ticket-list-reorder-error` on the list, the move error
on the board). Focus returns to the same button, or to the other one when
the Ticket reached an end.

Tapping another slip's toggle while a slip is open switches the
selection on click, not on pointerdown. The taller reorder panel would
otherwise collapse first and move the toggle out from under the tap.

## Claimed by runner (issue #132)

While Galley's `openRound.state` is `claimed`, the slip
(`board-claimed`) and the receipt (`ticket-detail-claimed`) show
**Claimed by runner** as a `ClaimedTag`, the `tag` cva's `claimed`
variant: an ink outline with ink text on paper (14.91:1, `tokens.test.ts`
"claimed tag: ink on paper"). It differs from the Ready-deep **Queued
for** outline, and the two never show together, because Galley reports
`requestingAgentWork` false while a Round is open. The Ticket stays in
its Status column. Swiftlet computes nothing: `parseTicket` requires
`openRound`, either `null` or a Round with a known state, and rejects
anything else. **Archive** on a Ticket with an open Round shows Galley's
`round_open` message in the action error, and the receipt stays open.
`e2e/tests/runner-claims.spec.ts` covers this against a real Michelin.

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
