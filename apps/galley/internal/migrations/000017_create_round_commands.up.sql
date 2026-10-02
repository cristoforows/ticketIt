CREATE TABLE round_commands (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id BIGINT NOT NULL,
    round_id BIGINT NOT NULL,
    public_id UUID NOT NULL UNIQUE,
    type TEXT NOT NULL,
    claim_epoch INTEGER NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL,
    acknowledged_at TIMESTAMPTZ,
    ack_outcome TEXT,
    CONSTRAINT round_commands_round_fk FOREIGN KEY (owner_id, round_id) REFERENCES rounds (owner_id, id),
    -- M5.1's command types; later M5 slices replace this.
    CONSTRAINT round_commands_type_m5 CHECK (type IN ('stop')),
    CONSTRAINT round_commands_ack_outcome CHECK (ack_outcome IN ('applied', 'ignored')),
    CONSTRAINT round_commands_ack_together CHECK ((acknowledged_at IS NULL) = (ack_outcome IS NULL)),
    CONSTRAINT round_commands_claim_epoch_positive CHECK (claim_epoch >= 1)
);
CREATE UNIQUE INDEX round_commands_one_stop_per_round ON round_commands (round_id) WHERE type = 'stop';
