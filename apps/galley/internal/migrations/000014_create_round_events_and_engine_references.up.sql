ALTER TABLE rounds ADD CONSTRAINT rounds_owner_id_id_unique UNIQUE (owner_id, id);

CREATE TABLE round_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id BIGINT NOT NULL,
    round_id BIGINT NOT NULL,
    idempotency_key TEXT NOT NULL,
    type TEXT NOT NULL,
    claim_epoch INTEGER NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL,
    payload_hash BYTEA NOT NULL,
    result JSONB NOT NULL,
    CONSTRAINT round_events_round_fk FOREIGN KEY (owner_id, round_id) REFERENCES rounds (owner_id, id),
    CONSTRAINT round_events_key_unique UNIQUE (round_id, idempotency_key),
    -- M4's event types (#134). M4.9 (#135) and M4.10 (#136) replace this.
    CONSTRAINT round_events_type_m4 CHECK (type IN ('execution_started')),
    CONSTRAINT round_events_claim_epoch_positive CHECK (claim_epoch >= 1),
    CONSTRAINT round_events_idempotency_key_length CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
    CONSTRAINT round_events_payload_hash_sha256 CHECK (octet_length(payload_hash) = 32)
);

CREATE TABLE round_engine_references (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id BIGINT NOT NULL,
    round_id BIGINT NOT NULL,
    reference TEXT NOT NULL,
    is_current BOOLEAN NOT NULL,
    attached_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT round_engine_references_round_fk FOREIGN KEY (owner_id, round_id) REFERENCES rounds (owner_id, id),
    CONSTRAINT round_engine_references_reference_length CHECK (char_length(reference) BETWEEN 1 AND 200)
);

CREATE UNIQUE INDEX round_engine_references_one_current_per_round ON round_engine_references (round_id) WHERE is_current;
