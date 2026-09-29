ALTER TABLE tickets ADD COLUMN archived_at TIMESTAMPTZ;

CREATE INDEX tickets_owner_archived_order_idx ON tickets (owner_id, archived_at, created_at DESC, id DESC);
