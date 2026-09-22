-- Adds the non-guessable public identifier a Ticket is addressed by in
-- URLs and by GET /api/tickets/{id} (issue #57). The previously-exposed
-- id column is the sequential BIGINT primary key, which lets a client
-- enumerate every Ticket by incrementing an integer; no Galley endpoint
-- exposes it after this migration (internal/httpapi/ticket.go), though
-- it remains the internal primary key every foreign key still uses.
--
-- Backfilled for pre-existing rows, since ticketit_dev/ticketit_test
-- already hold Tickets from #56 and this project's migrations are
-- forward-only (no down-migration could undo a bad backfill).
-- gen_random_uuid() is PostgreSQL core (built in since 13, confirmed
-- against this deployment's 17.11) -- no pgcrypto or other extension
-- needed. New rows generate this in Go instead
-- (internal/httpapi/ticket.go's insertTicket), matching how every
-- other identifier in this codebase (session tokens, OAuth state) is
-- generated in application code rather than a database default; the
-- column default below exists only as a safety net for a future
-- direct-SQL insert, not the path this slice's own code takes.
ALTER TABLE tickets ADD COLUMN public_id UUID;
UPDATE tickets SET public_id = gen_random_uuid() WHERE public_id IS NULL;
ALTER TABLE tickets ALTER COLUMN public_id SET DEFAULT gen_random_uuid();
ALTER TABLE tickets ALTER COLUMN public_id SET NOT NULL;
ALTER TABLE tickets ADD CONSTRAINT tickets_public_id_uq UNIQUE (public_id);
