-- Development-only diagnostic table (issue #52): a tiny persisted
-- record used to prove data survives a Galley process restart against
-- the same database. Not a domain/ticket table -- those arrive in #56.
CREATE TABLE diagnostic_notes (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    note TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
