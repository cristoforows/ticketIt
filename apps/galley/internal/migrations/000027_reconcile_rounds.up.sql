ALTER TABLE rounds ADD COLUMN reconcile_required BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE rounds ADD COLUMN reconcile_execution TEXT;
ALTER TABLE rounds ADD COLUMN reconciled_at TIMESTAMPTZ;
ALTER TABLE rounds ADD CONSTRAINT rounds_reconcile_execution CHECK (reconcile_execution IN ('running', 'stopped', 'unknown'));
ALTER TABLE rounds ADD CONSTRAINT rounds_reconciled_at_follows_execution CHECK ((reconcile_execution IS NULL) = (reconciled_at IS NULL));
-- Only a running Reconcile clears the flag (#170).
ALTER TABLE rounds ADD CONSTRAINT rounds_unknown_execution_stays_flagged CHECK (reconcile_execution IS DISTINCT FROM 'unknown' OR reconcile_required);
