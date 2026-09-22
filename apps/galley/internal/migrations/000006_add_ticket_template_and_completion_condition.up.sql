-- Ticket Templates and the retained completion condition (issue #59,
-- following the accepted D3 decision:
-- docs/decisions/d3-agent-template-compatibility.md). template and
-- completion_condition are deliberately separate columns: Go computes
-- completion_condition from the chosen Template's default exactly once,
-- at INSERT (internal/httpapi/ticket.go's defaultCompletionCondition),
-- and no later write path in this codebase ever sets it again --
-- template's presentation/default-condition role ends at creation, per
-- D3 ("a Template does not determine which agent or execution engine
-- must perform the work").
--
-- Backfilled via DEFAULT, not a data migration step: every Ticket
-- captured before this migration went through the Basic-only
-- CreateTicket path with human acceptance as its completion condition,
-- so 'Basic'/'humanAcceptance' are the historically correct values for
-- existing rows, not merely a convenient placeholder.
--
-- No CHECK constraint, matching tickets.status's existing rationale
-- (apps/galley/README.md, "Tickets"): this slice's Galley code is the
-- only writer (ADR 0001) and enforces the two-value enum itself via the
-- generated TicketTemplate/TicketCompletionCondition types' Valid()
-- methods.
ALTER TABLE tickets ADD COLUMN template TEXT NOT NULL DEFAULT 'Basic';
ALTER TABLE tickets ADD COLUMN completion_condition TEXT NOT NULL DEFAULT 'humanAcceptance';

-- One Ticket repository reference (D3 S1 check 3), available on either
-- Template -- not a competing Basic-only concept, and required by
-- nothing in M2. Nullable like goal/context/etc (000005): NULL means
-- "never set", distinct at the storage layer from PATCH's own ""
-- clear signal (see updateTicketForOwner).
ALTER TABLE tickets ADD COLUMN repository TEXT;
