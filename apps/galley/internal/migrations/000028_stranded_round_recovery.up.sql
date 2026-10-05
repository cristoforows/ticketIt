-- No foreign key: re-pairing deletes the runners row, and the Round keeps naming the runner that claimed it.
ALTER TABLE rounds ADD COLUMN runner_id BIGINT;
ALTER TABLE rounds ADD COLUMN claim_idempotency_key TEXT;
ALTER TABLE rounds ADD COLUMN claim_payload JSONB;
ALTER TABLE rounds ADD CONSTRAINT rounds_claim_recorded_together CHECK (
    (runner_id IS NULL) = (claim_idempotency_key IS NULL) AND (runner_id IS NULL) = (claim_payload IS NULL)
);
ALTER TABLE rounds ADD CONSTRAINT rounds_claim_idempotency_key_length CHECK (char_length(claim_idempotency_key) BETWEEN 1 AND 200);
CREATE UNIQUE INDEX rounds_claim_idempotency_key_unique ON rounds (owner_id, claim_idempotency_key)
    WHERE claim_idempotency_key IS NOT NULL;

-- A claimed Round can end interrupted without having started (#171).
ALTER TABLE rounds DROP CONSTRAINT rounds_timestamps_follow_state;
ALTER TABLE rounds ADD CONSTRAINT rounds_timestamps_follow_state CHECK (
    CASE state
        WHEN 'claimed' THEN started_at IS NULL AND ended_at IS NULL
        WHEN 'running' THEN started_at IS NOT NULL AND ended_at IS NULL
        WHEN 'waiting_for_input' THEN started_at IS NOT NULL AND ended_at IS NULL
        WHEN 'delivered' THEN started_at IS NOT NULL AND ended_at IS NOT NULL
        WHEN 'stopped' THEN ended_at IS NOT NULL
        WHEN 'failed' THEN started_at IS NOT NULL AND ended_at IS NOT NULL
        WHEN 'interrupted' THEN ended_at IS NOT NULL
    END
);

CREATE TABLE round_attestations (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id BIGINT NOT NULL,
    round_id BIGINT NOT NULL UNIQUE,
    attested_at TIMESTAMPTZ NOT NULL,
    basis TEXT NOT NULL,
    note TEXT,
    round_state TEXT NOT NULL,
    claim_epoch INTEGER NOT NULL,
    holder_runner_id BIGINT,
    holder_last_seen_at TIMESTAMPTZ,
    holder_health TEXT NOT NULL,
    reconcile_execution TEXT,
    CONSTRAINT round_attestations_round_fk FOREIGN KEY (owner_id, round_id) REFERENCES rounds (owner_id, id),
    CONSTRAINT round_attestations_basis CHECK (basis IN ('runner_process_ended', 'runner_host_off', 'other')),
    CONSTRAINT round_attestations_note_length CHECK (char_length(note) BETWEEN 1 AND 1000),
    CONSTRAINT round_attestations_other_needs_note CHECK (basis <> 'other' OR note IS NOT NULL),
    CONSTRAINT round_attestations_round_state CHECK (round_state IN ('claimed', 'running', 'waiting_for_input')),
    CONSTRAINT round_attestations_holder_health CHECK (holder_health IN ('connected', 'disconnected', 'replaced', 'not_paired')),
    CONSTRAINT round_attestations_reconcile_execution CHECK (reconcile_execution IN ('running', 'stopped', 'unknown'))
);
