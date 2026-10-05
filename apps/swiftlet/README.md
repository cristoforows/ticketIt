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
instead of a full page load. Any path other than `/list`, `/agents`, or
`/tickets/:id` falls back to rendering the board (`/` and `/board`) — only a Ticket
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
elements — **stored and rendered as plain text only.** The only
Markdown this app renders is a delivered Round's Report (issue #136,
below); Ticket fields stay plain text. Each refinement field's `<textarea>` is paired with its
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

`/` and `/board` show the board, the default view; `/list` shows the list.
They are switchable through the authenticated shell's Board / List links.
The board calls the same `GET /api/tickets` as the list; there is no board
endpoint or separate Ticket state. Capture stays on the list. On desktop,
a spike appears at the bottom of the screen while a slip is dragged;
dropping the slip on it calls `POST /api/tickets/:id/archive`. Phones
archive from the Ticket detail. Each of six Status sections renders even when empty, in
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

Clicking a Ticket link in `/list`, `/` or `/board` opens its detail in a Radix UI
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

While Galley's `openRound.state` is `claimed`, the receipt
(`ticket-detail-claimed`) shows **Claimed by runner** as a `ClaimedTag`
(the slip shows the waiting reason instead since issue #162), the `tag` cva's `claimed`
variant: an ink outline with ink text on paper (14.91:1, `tokens.test.ts`
"claimed tag: ink on paper"). It differs from the Ready-deep **Queued
for** outline, and the two never show together, because Galley reports
`requestingAgentWork` false while a Round is open. The Ticket stays in
its Status column. Swiftlet computes nothing: `parseTicket` requires
`openRound`, either `null` or a Round with a known state, and rejects
anything else. A command Galley refuses because a claim landed after the
receipt loaded shows Galley's `round_open` message in the action error,
and the receipt stays open. `e2e/tests/runner-claims.spec.ts` covers
this against a claim made directly with the runner credential.

## Locked while a Round is open (issue #133)

Swiftlet renders the lock from Galley's state and decides nothing.
While `openRound` is set:

- **Receipt.** `ticket-detail-locked` reads "Locked while <Agent> works
  on Round <n>", from `openRound.agent.name` and `openRound.sequence`
  (`lockedLabel` in `components/roundLock.ts`). It is an ink outline
  with ink text on paper, like `ClaimedTag`. Edit, Archive, Unassign,
  the Assignee picker, Add badge and each badge's Remove are disabled,
  titled with Galley's reason (`allowedActions.accept.reason.message`),
  the same path archived Tickets use. Status buttons and Accept follow
  `allowedActions`, which Galley returns empty. `?edit` opens in view
  mode.
- **Slip and Backlog row.** `LockGlyph` (`components/ui/Glyphs.tsx`,
  the shared glyph set's first SVG, drawn in `currentColor`) sits beside
  the serial. Its accessible name is the same lock copy (`board-locked`,
  `ticket-locked`). The slip is not draggable. In its actions, Edit
  and Move stage are disabled and reorder is hidden. The Backlog row has
  no reorder buttons. Another Ticket may still be dropped beside it, because Galley
  allows that.
- **Coexisting with Claimed by runner.** The glyph marks the lock for
  either open state, claimed or running. `ClaimedTag` keeps naming the
  Round's state and still shows only while `claimed`. The glyph goes in
  the serial line, so a claimed slip has one tag, not two.

`tokens.test.ts` "lock notice and lock glyph: ink on paper" pins the
contrast (14.91:1). The greyed active card, its animation and its View
and Stop controls are "Active order slip (issue #162)".

## Rounds, In Progress and refreshing (issue #134)

Once the runner reports Execution started, Galley reports the Ticket as
In Progress with `openRound.state` `running` and a `startedAt`. Swiftlet
renders that and decides nothing:

- **Slip and row.** The slip moves to the In Progress column. It shows
  the Agent as its Assignee and the lock glyph, and no **Claimed by
  runner** tag, because that tag shows only while the Round is
  `claimed`.
- **Rounds section.** A receipt whose Ticket has a Round shows a
  **Rounds** section (`ticket-detail-rounds`), one entry per Round (see
  "Explicit rework" below): an open Round's outcome is "Claimed, waiting
  for the runner to start" or "Running" (`ticket-detail-round-state`),
  with the time Galley says it started (`ticket-detail-round-started`)
  once it has. A Ticket with no Round has no section. The lock banner
  and the **Claimed by runner** tag come from `openRound` and show
  before the Round list has loaded.
- **Runner disconnected.** While the Round is open, the section shows a
  **Runner disconnected** notice (`ticket-detail-runner-disconnected`)
  when Galley's runner health is anything but Connected. It uses the
  header's `useRunnerHealth` (`enabled` only while a Round is open), not
  a second fetch mechanism, so it follows the 10 s cadence. While the
  health is loading or could not be read, no notice shows, because
  nothing is known. The notice says lost contact does not mean the Round
  stopped (docs/contracts/execution-interface.md).
- **Refreshing.** `useExecutionRefresh` calls a refresh every 3 s while
  the receipt's Ticket, or any Ticket on the board or in the list,
  `awaitsExecution`: it has an open Round or is requesting Agent work
  (queued). A tick is skipped while the previous refresh is
  pending; there is no loading state, because the previous data stays
  until the new data arrives; nothing is set when the data is unchanged;
  and it stops when the Ticket is neither queued nor has an open Round,
  or the component unmounts. Otherwise there is no timer. The runner
  health check still runs only while a Round is open. A failed refresh keeps the previous data
  and adds Galley's or the network's message, cleared by the next good
  refresh. A move or reorder in progress skips the tick.
- **Parsing.** `parseTicket` also requires a `running` Round to carry a
  `startedAt` and a `claimed` one not to.

Tests cover each receipt state (`TicketDetail.test.tsx`) and the refresh
(`useExecutionRefresh.test.tsx` and the page, list and board tests, all
with fake timers).
Evidence: `docs/evidence/m4/134-controlled-engine.md`.

## Round activity and usage (issue #135)

The receipt fetches `GET /api/tickets/{id}/rounds` (`fetchTicketRounds`,
`src/api/rounds.ts`) when it loads and on each tick of the same 3 s
refresh, after the Ticket fetch, so there is no second timer (see
"Confirmed Stop" for why every Ticket's list is fetched on load). Each
Round's entry shows:

- **Activity** (`ticket-detail-round-activity`): Galley's notes (the
  latest 50, then **Load earlier**; see #162), oldest first, each with
  the runner's `occurredAt` in local time.
  "No activity yet." when there are none.
- **Usage so far** for an open Round, **Usage** for an ended one
  (`ticket-detail-round-usage`): Cost, Input tokens,
  Output tokens and Active time, each shown from Galley's summary:
  - "Unknown" when the sum is `null`, never `$0` or `0`;
  - "≥ x (incomplete)" when the figure is not `complete`;
  - otherwise the figure itself.

  An **est.** tag (`EstimateTag`, muted on paper) follows any figure
  Galley marks `estimated`. Swiftlet sums nothing and decides nothing
  about completeness; it only formats. The cost stays a string from
  Galley to the screen (`dollars()` in `roundUsage.ts`), so no float
  rounds it.

The list is parsed in full: a malformed record rejects the response
rather than showing part of it. A failed fetch keeps the last activity
and usage and shows "Unable to refresh activity and usage" with the
message, cleared by the next good fetch. A `401` hands the Owner to
sign-in. Tests: `TicketDetailPage.test.tsx` (fake timers) and
`roundUsage.test.ts`. The estimate tag's contrast is in
`tokens.test.ts`. Evidence: `docs/evidence/m4/135-activity-usage.md`.

## Delivery and the retained result (issue #136)

When Michelin delivers, Galley moves the Ticket to In Review, ends the
Round as `delivered` and sets `Ticket.delivery` (the latest Round's
number, Agent and `deliveredAt`; `null` before any delivery and once a
later Round is claimed).

- **Tag.** Slip (`board-delivered`) and receipt
  (`ticket-detail-delivered`) show **Delivered by {Agent}**
  (`DeliveredTag`, In Review's deep colour on paper) whenever
  `delivery` is set.
- **No reload.** On the refresh tick whose Ticket comes
  back delivered, it fetches the list once more in the same tick, so
  In Review, the tag and the deliverable appear together; then
  `openRound` is `null` and the 3 s timer stops. There is no second
  timer. The board's existing refresh moves the slip to In Review the
  same way.
- **Delivered Rounds** show Summary, Criteria assessment and the Report
  (`ticket-detail-round-body`) in the Round's entry.
- **Markdown.** The Report renders with `react-markdown` (pinned
  exactly) and `skipHtml`, with no plugins. Raw HTML is never rendered
  and react-markdown's default URL filter blanks `javascript:`,
  `vbscript:` and `data:` links (`ui/Markdown.test.tsx`). A blanked
  link renders as its text. Every link opens with `target="_blank"` and
  `rel="noopener noreferrer nofollow"`. An image is never fetched: it
  renders as its alt text, plus its source as a link when the filter
  passes it. `ui/Markdown.tsx` lazy-loads the renderer
  (`ui/MarkdownRenderer.tsx`), so react-markdown's chunk loads only
  when a Report is shown, behind a "Loading…" fallback. Typography
  uses the order-rail tokens through `cn()`.
- **Parsing.** `parseRound` accepts `delivered` and requires a
  deliverable exactly when the state is `delivered`. `parseTicket`
  requires `delivery`. Either mismatch rejects the response.
- **Accept** is shown or refused from `allowedActions`, as before:
  available after delivery for a Basic Ticket, refused with Galley's
  reason for a Coding Ticket.

The delivered tag's contrast is in `tokens.test.ts`. Evidence:
`docs/evidence/m4/136-delivery.md`.

## Explicit rework (issue #137)

`allowedActions.rework` is Galley's answer, in the same shape as
`accept`. Swiftlet renders it and decides nothing:

- **Request rework** (`ticket-detail-rework-button`) sits beside Accept
  in the receipt's Workflow section, only when `rework.available`, and
  calls `POST /api/tickets/{id}/rework` (`requestTicketRework`) through
  the same action path as Accept: no optimistic update, Galley's
  rejection shown verbatim. There is no rework control on the slip.
  The page also adopts the Ticket a command returns, so a Ticket
  queued by a command starts refreshing at once.
- **Missing inputs.** When rework is unavailable with
  `agent_readiness_incomplete`, its message shows
  (`ticket-detail-rework-unavailable`) and the empty fields point at it
  through `aria-describedby`. The reasons that explain the missing
  inputs are chosen in order: a failed action, the Ready rejection,
  then this one. A `rework_not_available` reason is never shown: a
  Ticket that cannot be reworked is simply not offered it.
- **Round history.** `RoundsSection` lists every Round from Galley's
  list, newest first, without re-sorting. Each entry
  (`ticket-detail-round`, with `data-round-id` and `data-state`) is a
  `Disclosure` (`ui/Disclosure.tsx`, a native `<details>`): the latest
  Round starts open and earlier ones closed. `open` follows the index
  only when it changes, so the Owner's own toggling survives refreshes,
  and a newly arrived Round collapses the previous latest one. Lines
  (Agent, Claimed at, Started at, Delivered at), the deliverable, Activity
  and Usage sit inside the entry, and their test ids are the same in
  every entry.
- **Refresh.** After rework the Ticket is Ready and queued, so the
  receipt keeps refreshing until Round 2 is claimed, runs and delivers.

Tests: `TicketDetail.test.tsx` (button, rejection, missing inputs, Round
history) and `TicketDetailPage.test.tsx` (In Review to a second
delivered Round, fake timers).

## Stop request (issue #159)

`allowedActions.stop` and `openRound.stopRequestedAt` are Galley's
answers; Swiftlet renders them and decides nothing.

- **Stop** (`ticket-detail-stop-button`) sits beside Request rework in
  the receipt's Workflow section, only when `stop.available`, and calls
  `POST /api/tickets/{id}/stop` (`requestTicketStop`) through the same
  action path: no confirmation, no optimistic update, Galley's
  rejection shown verbatim. It is the one action the open-Round lock
  does not disable. The slip has its own Stop since issue #162.
- **Stopping…** shows once `stopRequestedAt` is set, as a
  `StoppingTag` (the `tag` cva's `stopping` variant: a Blocked-deep
  outline and text on paper, `tokens.test.ts` "stopping tag") on the
  receipt (`ticket-detail-stopping`), next to **Claimed by runner**. The
  slip shows the waiting reason instead (issue #162). Stopping is not a Status: the Ticket
  stays in its Status column, locked, and the receipt keeps refreshing
  while the Round is open. `parseTicket` requires `stopRequestedAt`
  (`null` or a string) on an open Round and `allowedActions.stop`.

Tests: `TicketDetail.test.tsx` ("Stop"), `TicketDetailPage.test.tsx`
(the POST and refresh), `TicketBoard.test.tsx` (the slip tag) and
`api/tickets.test.ts` (parsing).

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

## Confirmed Stop (issue #160)

When Michelin confirms a Stop, Galley ends the Round as `stopped`, moves
the Ticket to Backlog and attaches the Stopped Badge. Swiftlet renders
what Galley returns:

- **Round entry.** A `stopped` Round's summary reads **Round n ·
  Stopped**, with a `StoppedTag` (`ticket-detail-round-stopped`, the
  `tag` cva's `stopped` variant: paper on Blocked-deep,
  `tokens.test.ts` "stopped tag"). The entry shows **Stopped at**
  (`ticket-detail-round-stopped-at`), the Round's `outcomeNote` under
  **Outcome** (`ticket-detail-round-outcome-note`), and its Activity and
  **Usage**. A Round stopped while claimed has no Started at.
- **Badge.** The Stopped Badge is an ordinary Badge and renders through
  the Badge tags; Swiftlet never reads it to infer the outcome.
- **Stopping… disappears** because `openRound` is `null`, and the
  receipt stops refreshing.
- **Loading.** A stopped Ticket has neither an open Round nor a
  delivery, so the receipt fetches the Round list on load for every
  Ticket and on every refresh tick, and shows the Rounds section when
  the Ticket has an open Round, a delivery or any listed Round. A Ticket
  with no Round costs one extra request on load.
- **Parsing.** `parseRound` accepts `stopped` and requires `outcomeNote`
  to be a string exactly when the state is `stopped` and `null`
  otherwise; a mismatch rejects the response.

Tests: `TicketDetail.test.tsx` ("the Round history"),
`TicketDetailPage.test.tsx` (the refresh that sees the Stop, and a
reopened stopped Ticket) and `api/rounds.test.ts` (parsing).

## Failed and Interrupted Rounds (issue #161)

When Michelin reports `failed` or `interrupted`, Galley ends the Round,
moves the Ticket to Blocked and keeps its activity and usage. Swiftlet
renders what Galley returns:

- **Round entry.** The summary reads **Round n · Failed** or **Round n ·
  Interrupted**, with a `FailedTag` (`ticket-detail-round-failed`, paper
  on Blocked-deep, `tokens.test.ts` "failed tag") or an `InterruptedTag`
  (`ticket-detail-round-interrupted`, a dashed Blocked-deep outline on
  paper, "interrupted tag"). The entry shows **Failed at** or
  **Interrupted at**, the runner's explanation or evidence beneath under
  **Outcome** (`ticket-detail-round-outcome-note`), and its Activity and
  **Usage**. There is no Report.
- **Recovery.** The Owner returns the Ticket to Ready with the existing
  status control (`ticket-detail-status-button-Ready`), shown because
  Galley lists `Ready` in `allowedActions.statusChanges` for an
  Agent-assigned Blocked Ticket; there is no separate button.
- **Parsing.** `parseRound` accepts `failed` and `interrupted`, and
  requires `outcomeNote` to be a string exactly when the state is
  `stopped`, `failed` or `interrupted`.

Tests: `TicketDetail.test.tsx` ("the Round history"), `api/rounds.test.ts`
(parsing) and `tokens.test.ts` (the two tags' contrast).

## Active order slip (issue #162)

While `openRound` is set, the Board slip and the Backlog row render the
active order slip (`ActiveOrder` in `components/ActiveOrder.tsx`, test
ids `board-…` and `ticket-…`). Swiftlet decides nothing on it:

- **Waiting reason.** `openRound.waitingReason` is Galley's
  (`apps/galley/README.md`, "Waiting reason and activity paging").
  `waitingReasonLabels` maps it to **Starting**, **Working**,
  **Stopping** or **Runner disconnected** (`board-waiting-reason`,
  `ticket-waiting-reason`); nothing is derived from timestamps or the
  Round's state. `parseTicket` rejects a missing or unknown value. The
  slip no longer shows `ClaimedTag` or `StoppingTag`.
- **Greyed and locked.** The slip paper (`SlipPaper active`, the
  `slipPaper` cva's `active` variant) and the Backlog row are `bg-rule`,
  and every text on them is ink: muted on rule is 3.5:1, so the serial,
  the date and the row's Status switch to ink. `tokens.test.ts` pins
  "ink on rule" (AA text) and the indicator's 3:1, and
  `ActiveOrder.test.tsx` fails if muted, dim or a status-text colour
  appears on an active slip. The lock glyph stays; the slip is not
  draggable; on a phone the actions toggle is hidden, because it would
  cover View and Stop.
- **Delivery indicator.** `DeliveryIndicator` is decorative
  (`aria-hidden`); the text label carries the meaning. The rider idles
  at the kitchen while Starting, rides while Working, rides back while
  Stopping and stands still mid-road while Runner disconnected
  (`styles.css`, `.delivery`). Under `prefers-reduced-motion: reduce`,
  `animation: none` leaves each reason's static position.
- **View and Stop.** View is a link to the receipt (`TicketModalLink`
  with button classes), named "View <title>". Stop is a button named
  "Stop <title>", shown only while `allowedActions.stop.available`. It
  calls `requestTicketStop` and puts Galley's returned Ticket in the
  list. A refusal shows Galley's message under the slip. Neither control
  is nested in another.

Receipt follow-ups from the M4 gate:

- **Local time.** Every timestamp goes through `localTimestamp` /
  `LocalTime` (`components/ui/time.tsx`): "03 Oct 2026 19:35:09
  UTC+05:30" in the viewer's zone, with the ISO value in `dateTime`.
  The slip's `shortDate` is local too. The unit suite runs in
  `Asia/Kolkata` (`vite.config.ts`, `test.env.TZ`), so a UTC rendering
  fails, and `time.test.ts` sets other zones explicitly.
- **Paging.** The receipt shows the Round list's latest 50 notes and a
  **Load earlier** button (`ticket-detail-round-load-earlier`) while
  `earlierActivityCursor` is set. It calls `fetchRoundActivity` with
  the oldest page's cursor. Shown notes are kept across refreshes; a
  refresh whose window skipped past them is back-filled through the
  window's own cursor.
- **One runner health.** `useRunnerHealth` reads one shared poll, so
  the header pill, the receipt's Runner disconnected notice and the
  Runner page always show the same Galley value. A receipt opened
  between polls shows the header's value at once.

Tests: `ActiveOrder.test.tsx` (list and board), `TicketBoard.test.tsx`,
`TicketBoardMobile.test.tsx`, `TicketDetailPage.test.tsx` (paging and
the shared health), `api/tickets.test.ts`, `api/rounds.test.ts`,
`ui/time.test.ts`, `ui/slip.test.ts` (motion) and `ui/tokens.test.ts`.

## Questions and answers (issue #163)

A Round `waiting_for_input` keeps its Ticket Blocked and locked.
Swiftlet renders Galley's question and answer state and decides
nothing:

- **Slip.** `waitingReasonLabels` adds **Waiting for your answer**
  (`waiting_for_answer`) and **Resuming** (`resuming`, answered but not
  yet resumed). The rider idles mid-road for both (`styles.css`).
- **Question panel.** While `openRound.question` is set, the receipt's
  Rounds section opens with a "Question from the Agent" region
  (`QuestionPanel`, `ticket-detail-question`) showing the text and when
  it was asked. While `allowedActions.answer.available`, a form
  (`ticket-detail-answer-form`) takes **Your answer** (up to 2000
  characters, **Send answer** disabled while blank or sending) and
  calls `answerRoundQuestion` (`POST
  /api/tickets/{id}/rounds/{roundId}/questions/{questionId}/answer`).
  The answer is sent as typed; Galley trims nothing either. Galley's
  returned Ticket replaces the receipt and the Round list is reloaded.
  Otherwise the panel shows the recorded answer
  (`ticket-detail-question-answered`) or Galley's reason
  (`ticket-detail-answer-unavailable`, e.g. Stop requested).
- **Rejections.** `question_already_answered` refreshes the receipt
  and says the receipt now shows the answer Galley recorded; any other
  refusal is shown in Galley's words, the draft kept. A `404` names the
  Ticket, Round and question together, so its message is shown rather
  than "not found".
- **History.** Each Round entry lists its questions oldest first
  (`ticket-detail-round-questions`), each with its answer, **Awaiting
  your answer** while the Round waits, or **Not answered** once it has
  ended without one. A waiting Round's summary reads **Waiting for your
  answer**.
- **Parsing.** `parseTicket` requires `allowedActions.answer`, accepts
  `waiting_for_input` as an open state and requires `openRound.question`
  exactly then (`null` otherwise). `parseRound` requires `questions`.

Tests: `TicketDetail.test.tsx` ("a question from the Agent"),
`TicketDetailPage.test.tsx` (the POST, the reload and the refresh on
`question_already_answered`), `ActiveOrder.test.tsx` (both labels on
list and board), `api/tickets.test.ts` and `api/rounds.test.ts`.

## Round feedback (issue #164)

Swiftlet renders Galley's feedback state and decides nothing:

- **Form.** While `allowedActions.feedback.available` (a delivered
  latest Round, In Review or Done), the receipt's Rounds section shows a
  "Feedback for the next Round" region (`FeedbackPanel`,
  `ticket-detail-feedback`) with **Your feedback on Round N** (up to
  10000 characters, described by a hint that the next Round receives it
  once and it cannot be edited or deleted) and **Add feedback**
  (`ticket-detail-feedback-submit`, disabled while blank or sending). It
  calls `addRoundFeedback` (`POST
  /api/tickets/{id}/rounds/{roundId}/feedback`) for `delivery.roundId`,
  sends the text as typed, clears the draft on `201`, and reloads the
  Round list. Several comments may be added one after another.
- **Rejections.** `feedback_not_available` refreshes the receipt and
  says feedback is no longer available on this Round; the form goes
  away with the availability but the message stays. Any other refusal
  is shown in Galley's words, the draft kept.
- **History.** Each Round entry lists its feedback oldest first
  (`ticket-detail-round-feedback`), each with when it was added in local
  time and **Waiting for the next Round** or **Sent to Round N**
  (`ticket-detail-round-feedback-consumed`).
- **Parsing.** `parseTicket` requires `allowedActions.feedback`;
  `parseRound` requires `feedback`, each item with `consumedBy` `null`
  or `{roundId, sequence}`.

Tests: `TicketDetail.test.tsx` ("feedback for the next Round"),
`TicketDetailPage.test.tsx` (the POST, the reload and the refresh on
`feedback_not_available`), `api/tickets.test.ts` and
`api/rounds.test.ts`.

## Permission requests and grants (issue #165)

Swiftlet renders Galley's Permission state and decides nothing:

- **Request panel.** While `openRound.permissionRequest` is set, the
  receipt's Rounds section shows a bordered "Permission request" region
  (`PermissionPanel`, `ticket-detail-permission`). It shows the account,
  action and resource as receipt lines and when the request was made.
  The `controlled` account carries a **Substitute account** tag
  whenever `substituteAccount` is true, here, in the history and on
  grants.
- **Decisions.** **Allow for this Ticket**
  (`ticket-detail-permission-approve`) and **Decline**
  (`ticket-detail-permission-decline`) show only while
  `allowedActions.permissionDecision.available`; otherwise Galley's
  reason is shown. Both are disabled while either is sending. Allow
  calls `approvePermissionRequest` (`POST
  .../permission-requests/{requestId}/approve` with `{"form":
  "ticket"}`), Decline calls `declinePermissionRequest` (`.../decline`,
  no body). Each reloads the Round list. Once decided the panel reads
  **Allowed for this Ticket. The Round resumes.** or **Declined. The
  Round still waits for a Permission; Stop ends it.**
- **Rejections.** Any Galley refusal refreshes the receipt.
  `permission_already_decided` and `permission_decision_not_available`
  say the receipt now shows Galley's state; any other refusal is shown
  in Galley's words.
- **Grants.** `permissionGrants` render as "Permissions for this
  Ticket" (`ticket-detail-permission-grant`): `<Agent> may <action> on
  <resource> (<account>)` and when it was allowed. They stay on the
  receipt after the Round ends.
- **History.** Each Round entry lists its Permission requests
  (`ticket-detail-round-permission-request`, `data-decision`
  `pending | approved | declined`) and its authority checks
  (`ticket-detail-round-authority-check`, **Allowed** or **Denied**,
  oldest first). When `authorityCheckCount` exceeds the 50 listed, it
  says **Showing the latest 50 of N checks.** A waiting Round whose
  questions are all answered and that holds an unapproved request reads
  **Waiting for a Permission**.
- **Slip.** `waitingReason` `waiting_for_permission` is labelled
  **Waiting for a Permission**, with the rider idle as for an answer.
- **Parsing.** `parseTicket` requires `allowedActions.permissionDecision`
  and `permissionGrants` (form `ticket`, state `active`). A waiting
  Round must hold exactly one of `question` and `permissionRequest`;
  any other open Round holds neither. A request's `decision` and
  `decidedAt` are set together, and `grantId` is set exactly when
  approved. `parseRound` requires `permissionRequests`,
  `authorityChecks` (a `grantId` exactly on `allow`) and an integer
  `authorityCheckCount` no smaller than the list.

Tests: `TicketDetail.test.tsx` ("a Permission request from the Agent"),
`TicketDetailPage.test.tsx` (approve, reload and the refresh on
`permission_already_decided`), `api/tickets.test.ts` and
`api/rounds.test.ts`.

## Time-based grants and renewal (issue #166)

- **Form.** Before deciding, the panel offers **For this Ticket**
  (`ticket-detail-permission-form-ticket`, the default) or **For a
  time** (`ticket-detail-permission-form-time`). The time form shows
  **Expires after** (`ticket-detail-permission-duration`: 1 hour,
  8 hours, 1 day, 7 days) and the expiry it implies
  (`ticket-detail-permission-expiry`). Allow then reads **Allow for a
  time** and sends `{"form": "time", "expiresAt"}`, the browser's now
  plus the duration. Galley judges it by its own clock;
  `invalid_grant_expiry` and `grant_form_conflict` are explained and
  the receipt refreshes. Decline sends no form.
- **Renewal.** A request with `renewsGrantId` shows **Renewal.**
  (`ticket-detail-permission-renewal`) and, in the history, **Renews an
  expired grant**. A deny that names `expiredGrantId` adds **its
  time-based grant expired**
  (`ticket-detail-round-authority-check-expired`). An approval reads
  **Allowed for this Ticket** or **Allowed for a time** after the grant's
  form, or **Allowed** when the grant is not among those listed.
- **Grants.** Each grant carries `data-form` and `data-state`. A time
  grant shows when it was allowed, **until** its expiry and the time
  left (`ticket-detail-permission-grant-remaining`, from Galley's
  `remainingSeconds`); an expired one shows an **Expired** tag
  (`ticket-detail-permission-grant-expired`) and when it expired. When
  `permissionGrantCount` exceeds the grants listed, **Showing the latest
  N of M grants.** (`ticket-detail-permission-grants-truncated`).
- **Parsing.** A ticket-form grant is `active` with null `expiresAt` and
  `remainingSeconds`; a time grant has an `expiresAt`, and an integer
  `remainingSeconds` above 0 when `active` or 0 when `expired`.
  `permissionGrantCount` is an integer no smaller than the list.
  Requests require `renewsGrantId`; checks require `expiredGrantId`,
  null on `allow`.

Tests: `TicketDetail.test.tsx` ("the time form"), `api/tickets.test.ts`
and `api/rounds.test.ts`.

## Full Connected Account access (issue #167)

- **Access.** Before deciding, the panel's **Access** radio group offers
  **Only what was requested** (`ticket-detail-permission-scope-requested`,
  always the default) or **Full access to the `<account>` account**
  (`ticket-detail-permission-scope-full`). Choosing full shows a warning
  (`ticket-detail-permission-full-warning`, the full radio's
  description) that the Agent may use every action and resource the
  account declares without asking again, and that anything undeclared
  stays refused. The forms, the hint and the button follow the choice
  (**Allow full access for this Ticket** / **for a time**). The choice
  returns to requested for every new request. Full adds `"scope":
  "full"` to either form's body; requested sends the #166 body
  unchanged, with no `scope`. Decline sends no body.
- **Grants.** A full grant reads `<Agent> has` **Full access** (an
  inverted ink tag, `ticket-detail-permission-grant-full`) `to the
  <account> account`, carries `data-full`, and keeps the #166 form and
  expiry display. An approval reads **Full access allowed for this
  Ticket** or **for a time**; an allow by a full grant adds **by full
  access** (`ticket-detail-round-authority-check-full`); a renewal of an
  expired full grant says so.
- **Parsing.** A grant requires `full`: when true, `action` and
  `resource` are null; when false, both are strings.

Tests: `TicketDetail.test.tsx` ("full access") and `api/tickets.test.ts`.

## Revoking a grant (issue #168)

- **Revoke.** A grant whose `allowedActions.revoke` is available shows
  **Revoke** (`ticket-detail-permission-grant-revoke`, named `Revoke:
  <scope>`). It opens a Radix dialog titled **Revoke this grant?**,
  described by its text, with focus on **Cancel**. Escape and Cancel
  close it unchanged, and focus stays trapped while it is open. The text
  names each Round Galley lists in `coveredOpenRounds` (`Round <n> of
  "<Ticket title>"`), or says no open Round uses the grant. It also says
  completed actions are not undone. Swiftlet never works out coverage
  itself.
- **After.** **Revoke** posts `POST /api/grants/{id}/revoke`, then
  reloads the Ticket and its Rounds. The grant shows **Revoked**
  (`ticket-detail-permission-grant-revoked`) with Galley's `revokedAt`.
  The header shows Stopping for a Round the revoke stopped. On failure
  the dialog closes. An alert under the grants then explains
  `grant_expired`, `grant_already_revoked`, the shared 404 or Galley's
  message, and the receipt is reloaded.
- **Parsing.** A grant requires `revokedAt` (a string exactly when
  `revoked`), `allowedActions.revoke` (available exactly when
  `active`) and `coveredOpenRounds` (empty unless revoke is available).
  A revoked time grant has `remainingSeconds: 0`.

Tests: `TicketDetail.test.tsx` ("revoking a grant"),
`TicketDetailPage.test.tsx` ("revoking the grant") and
`api/tickets.test.ts`.

## Grants ended at Done (issue #169)

A ticket grant Galley ended when its Ticket reached Done has `state:
ended_at_done`. It shows the tag **Ended at Done**
(`ticket-detail-permission-grant-ended`) and Galley's `endedAt`
(`ticket-detail-permission-grant-ended-at`), in the tag style of
**Revoked** and **Expired** and distinct from both. It offers no
Revoke; Swiftlet only reads `allowedActions.revoke`. The parser
requires `endedAt` (a string exactly when `ended_at_done`) and accepts
that state for the `ticket` form only. `grant_ended` is explained if a
stale receipt posts a revoke.

Tests: `TicketDetail.test.tsx` and `api/tickets.test.ts`.

## Reconcile on reconnect (issue #170)

Two waiting reasons join the strict parser, the slip and the receipt:
`reconciling` (**Reconciling with the runner**) and `execution_unknown`
(**Runner cannot confirm execution**). The rider stays still for both.
On the receipt, `execution_unknown` shows a notice styled like Runner
disconnected (`ticket-detail-execution-unknown`, `role="status"`):
"The runner reconnected but cannot confirm this Round is running. It
stays open and the Ticket stays locked." `reconciling` shows a field
note (`ticket-detail-reconciling`). Runner disconnected outranks both.

Tests: `TicketDetail.test.tsx`, `ActiveOrder.test.tsx`,
`ui/slip.test.ts` and `api/tickets.test.ts`.

## Stranded-Round recovery (issue #171)

`runner_replaced` (**Runner replaced**) joins the waiting reasons; the
rider stays still and the receipt shows a notice
(`ticket-detail-runner-replaced`). While
`allowedActions.attestCessation` is available, the open Round offers
**Attest that execution has ceased** (`ticket-detail-attest-open`),
which opens an accessible dialog (`ticket-detail-attest-dialog`) with
the fixed warning copy, a fieldset of three radios (I ended the Michelin
process, The machine running Michelin is off, Other) and a note
(required with Other, at most 1000 characters; a blank optional note is
omitted). Keep waiting has focus on open; confirm stays disabled until a
basis, and with Other a note, is chosen. On success the Ticket and
Rounds reload; a refusal shows Galley's message inline. An Interrupted
Round with an `attestation` shows **Ended by your attestation** with the
basis, note and time. The Round parser requires `attestation`, allowed
only on Interrupted Rounds, and the Ticket parser requires
`attestCessation`.

Tests: `TicketDetail.test.tsx`, `ActiveOrder.test.tsx`,
`ui/slip.test.ts`, `api/rounds.test.ts` and `api/tickets.test.ts`.

## Technical limits (issue #172)

Galley stops a running Round that reaches its active-time or
denied-check limit, and records the breach as `limitBreach` on the open
Round and on the Round record. Swiftlet renders what Galley returns:

- **Stopping.** While the Stop a breach requested is pending, the slip's
  waiting reason and the detail's `StoppingTag` read **Technical limit
  reached. Stopping the Round.** instead of Stopping, and the open
  Round's entry names the limit with the same line as Failed below.
- **Failed.** A breached Round ends Failed. Above Galley's explanation
  under **Outcome**, the entry shows
  (`ticket-detail-round-limit-breach`) **Active time limit reached:
  <measured> of <limit>** or **Denied-check limit reached: <measured> of
  <limit>**. A duration is printed from whole seconds as Go's
  `time.Duration` prints it (`14401` is `4h0m1s`, `90` is `1m30s`), so it
  reads like Galley's explanation, whatever the browser's locale. A
  Round a breach did not end Failed (a late `delivered`, or an
  attestation) names no limit.
- **Parsing.** `parseLimitBreach` (`api/limitBreach.ts`) requires
  `limitBreach` on both shapes: `null`, or a known `kind`, safe integers
  `limit` of at least 1 and `measured` of at least `limit`, and a
  `breachedAt` string. An open Round with a breach must have
  `stopRequestedAt`.

Tests: `api/limitBreach.test.ts`, `api/tickets.test.ts`,
`api/rounds.test.ts`, `ActiveOrder.test.tsx` and `TicketDetail.test.tsx`.
