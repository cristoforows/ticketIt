ALTER TABLE rounds ADD CONSTRAINT rounds_owner_id_ticket_id_id_unique UNIQUE (owner_id, ticket_id, id);

CREATE TABLE round_feedback (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id BIGINT NOT NULL,
    public_id UUID NOT NULL UNIQUE,
    ticket_id BIGINT NOT NULL,
    round_id BIGINT NOT NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    consumed_by_round_id BIGINT,
    CONSTRAINT round_feedback_round_fk FOREIGN KEY (owner_id, ticket_id, round_id) REFERENCES rounds (owner_id, ticket_id, id),
    CONSTRAINT round_feedback_consumed_by_round_fk FOREIGN KEY (owner_id, ticket_id, consumed_by_round_id) REFERENCES rounds (owner_id, ticket_id, id),
    CONSTRAINT round_feedback_consumed_by_another_round CHECK (consumed_by_round_id <> round_id),
    CONSTRAINT round_feedback_body_length CHECK (char_length(body) BETWEEN 1 AND 10000),
    -- ASCII-whitespace backstop; Galley's validation rejects any Unicode-blank value.
    CONSTRAINT round_feedback_body_not_blank CHECK (btrim(body, E' \t\n\r\f\v') <> '')
);
CREATE INDEX round_feedback_unconsumed ON round_feedback (ticket_id) WHERE consumed_by_round_id IS NULL;
CREATE INDEX round_feedback_round ON round_feedback (round_id);
