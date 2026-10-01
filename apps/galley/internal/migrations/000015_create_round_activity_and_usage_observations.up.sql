ALTER TABLE round_events DROP CONSTRAINT round_events_type_m4;
-- M4's event types (#134, #135). M4.10 (#136) replaces this.
ALTER TABLE round_events ADD CONSTRAINT round_events_type_m4 CHECK (type IN ('execution_started', 'progress', 'usage_observed'));

CREATE TABLE round_activity (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id BIGINT NOT NULL,
    round_id BIGINT NOT NULL,
    seq INTEGER NOT NULL,
    note TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT round_activity_round_fk FOREIGN KEY (owner_id, round_id) REFERENCES rounds (owner_id, id),
    CONSTRAINT round_activity_seq_unique UNIQUE (round_id, seq),
    CONSTRAINT round_activity_seq_positive CHECK (seq >= 1),
    CONSTRAINT round_activity_note_length CHECK (char_length(note) BETWEEN 1 AND 2000),
    -- An ASCII-whitespace backstop; Galley's validation rejects any Unicode-blank note.
    CONSTRAINT round_activity_note_not_blank CHECK (btrim(note, E' \t\n\r\f\v') <> '')
);

CREATE TABLE usage_observations (
    id UUID PRIMARY KEY,
    owner_id BIGINT NOT NULL,
    round_id BIGINT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens BIGINT,
    output_tokens BIGINT,
    cost_usd NUMERIC(12,6),
    active_ms BIGINT,
    basis TEXT NOT NULL,
    -- Never identity and never unique: the join point for enrichment (M9 #10).
    provider_generation_id TEXT,
    occurred_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT usage_observations_round_fk FOREIGN KEY (owner_id, round_id) REFERENCES rounds (owner_id, id),
    CONSTRAINT usage_observations_basis CHECK (basis IN ('reported', 'estimated')),
    CONSTRAINT usage_observations_provider_length CHECK (char_length(provider) BETWEEN 1 AND 200),
    CONSTRAINT usage_observations_model_length CHECK (char_length(model) BETWEEN 1 AND 200),
    CONSTRAINT usage_observations_provider_generation_id_length CHECK (char_length(provider_generation_id) BETWEEN 1 AND 200),
    CONSTRAINT usage_observations_input_tokens_range CHECK (input_tokens BETWEEN 0 AND 9007199254740991),
    CONSTRAINT usage_observations_output_tokens_range CHECK (output_tokens BETWEEN 0 AND 9007199254740991),
    CONSTRAINT usage_observations_active_ms_range CHECK (active_ms BETWEEN 0 AND 9007199254740991),
    CONSTRAINT usage_observations_cost_usd_non_negative CHECK (cost_usd >= 0)
);

CREATE INDEX usage_observations_round ON usage_observations (round_id);
