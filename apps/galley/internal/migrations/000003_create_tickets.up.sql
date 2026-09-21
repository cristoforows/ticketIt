-- Tickets: the first domain record (issue #56). No work-type/category
-- column -- docs/ticket-creation.md, "Flexible ticket structure":
-- Tickets stay generic. owner_id scopes every row to the signed-in
-- Owner (docs/adr/0001-single-authority-galley.md); there is exactly
-- one Owner per deployment today (owners_singleton_uq), but the
-- column and its scoped queries (internal/httpapi/ticket.go) are
-- written as if that could change, rather than assuming a single row.
--
-- status is left as unconstrained TEXT rather than a CHECK constraint
-- enumerating every CONTEXT.md Status name: this slice's Galley code
-- is the only writer (ADR 0001) and only ever writes 'Backlog' -- a
-- CHECK would duplicate that enforcement today and need its own
-- migration the moment #60 adds transitions. created_at/updated_at
-- both default to now() at creation; updated_at has no trigger yet
-- since nothing in this slice ever updates a ticket after creation.
CREATE TABLE tickets (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES owners(id),
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backs "list the Owner's Tickets, newest first": created_at DESC is
-- the documented order, id DESC the deterministic tiebreak for rows
-- sharing a created_at value (id is monotonic via GENERATED ALWAYS AS
-- IDENTITY, so it never ties). See apps/galley/README.md, "Ticket
-- ordering".
CREATE INDEX tickets_owner_id_created_at_id_idx ON tickets (owner_id, created_at DESC, id DESC);
