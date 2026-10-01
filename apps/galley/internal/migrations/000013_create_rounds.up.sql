CREATE TABLE rounds (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES owners(id),
    public_id UUID NOT NULL UNIQUE,
    ticket_id BIGINT NOT NULL,
    agent_id BIGINT NOT NULL,
    sequence INTEGER NOT NULL,
    state TEXT NOT NULL,
    claim_epoch INTEGER NOT NULL,
    claimed_at TIMESTAMPTZ NOT NULL,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    CONSTRAINT rounds_ticket_fk FOREIGN KEY (owner_id, ticket_id) REFERENCES tickets (owner_id, id),
    CONSTRAINT rounds_agent_fk FOREIGN KEY (owner_id, agent_id) REFERENCES agents (owner_id, id),
    CONSTRAINT rounds_ticket_sequence_unique UNIQUE (ticket_id, sequence),
    CONSTRAINT rounds_sequence_positive CHECK (sequence >= 1),
    CONSTRAINT rounds_claim_epoch_positive CHECK (claim_epoch >= 1),
    -- M4's states (#132). M5 (#6) replaces this and rounds_timestamps_follow_state.
    CONSTRAINT rounds_state_m4 CHECK (state IN ('claimed', 'running', 'delivered')),
    CONSTRAINT rounds_timestamps_follow_state CHECK (
        CASE state
            WHEN 'claimed' THEN started_at IS NULL AND ended_at IS NULL
            WHEN 'running' THEN started_at IS NOT NULL AND ended_at IS NULL
            WHEN 'delivered' THEN started_at IS NOT NULL AND ended_at IS NOT NULL
        END
    ),
    CONSTRAINT rounds_timestamps_ordered CHECK (started_at >= claimed_at AND ended_at >= COALESCE(started_at, claimed_at))
);

-- The open states' one SQL definition; openRoundStatesSQL in rounds.go is the Go one.
-- waiting_for_input is M5's (#6), listed now so adding it needs no new index.
CREATE UNIQUE INDEX rounds_one_open_per_owner ON rounds (owner_id)
    WHERE state IN ('claimed', 'running', 'waiting_for_input');
