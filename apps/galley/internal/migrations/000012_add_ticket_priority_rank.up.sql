ALTER TABLE tickets ADD COLUMN priority_rank BIGINT;

UPDATE tickets SET priority_rank = ranked.position * 1024
  FROM (SELECT id, row_number() OVER (PARTITION BY owner_id ORDER BY created_at DESC, id DESC) AS position FROM tickets) AS ranked
 WHERE tickets.id = ranked.id;

ALTER TABLE tickets ALTER COLUMN priority_rank SET NOT NULL;

-- DEFERRABLE makes PostgreSQL check uniqueness at the end of each statement
-- rather than per row, so one UPDATE can renumber the whole collection.
ALTER TABLE tickets ADD CONSTRAINT tickets_owner_priority_rank_unique
    UNIQUE (owner_id, priority_rank) DEFERRABLE INITIALLY IMMEDIATE;

DROP INDEX tickets_owner_id_created_at_id_idx;
