-- Manual refinement fields (issue #58): optional free text an Owner
-- fills in by hand after quick capture (docs/ticket-creation.md,
-- "Manual guidance"). All four are nullable TEXT with no CHECK
-- constraint -- matching tickets.status's existing rationale (this
-- slice's Galley code is the only writer, ADR 0001, and enforces the
-- documented maximum length itself, internal/httpapi/ticket.go), not a
-- database-level enforcement that would need its own migration if a
-- limit ever changed.
--
-- NULL means "never set" -- distinct at the storage layer from an
-- explicit empty string, which the PATCH /api/tickets/{id} contract
-- also allows (clearing a field). Galley's read path folds both to ""
-- on the wire; only the write path (ticket.go's COALESCE-based update)
-- relies on the NULL/non-NULL distinction to implement "absent leaves
-- the value unchanged" vs. "present clears or sets it".
ALTER TABLE tickets ADD COLUMN goal TEXT;
ALTER TABLE tickets ADD COLUMN context TEXT;
ALTER TABLE tickets ADD COLUMN success_criteria TEXT;
ALTER TABLE tickets ADD COLUMN constraints TEXT;
