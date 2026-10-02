ALTER TABLE rounds DROP CONSTRAINT rounds_state_m4;
-- M5.2's states (#160); later M5 slices replace this.
ALTER TABLE rounds ADD CONSTRAINT rounds_state_m5 CHECK (state IN ('claimed', 'running', 'delivered', 'stopped'));

-- A claimed Round can be stopped, so a stopped Round may have no started_at.
ALTER TABLE rounds DROP CONSTRAINT rounds_timestamps_follow_state;
ALTER TABLE rounds ADD CONSTRAINT rounds_timestamps_follow_state CHECK (
    CASE state
        WHEN 'claimed' THEN started_at IS NULL AND ended_at IS NULL
        WHEN 'running' THEN started_at IS NOT NULL AND ended_at IS NULL
        WHEN 'delivered' THEN started_at IS NOT NULL AND ended_at IS NOT NULL
        WHEN 'stopped' THEN ended_at IS NOT NULL
    END
);

-- M5.3 (#161) widens the state list.
ALTER TABLE rounds ADD COLUMN outcome_note TEXT;
ALTER TABLE rounds ADD CONSTRAINT rounds_outcome_note_follows_state CHECK ((state = 'stopped') = (outcome_note IS NOT NULL));
ALTER TABLE rounds ADD CONSTRAINT rounds_outcome_note_length CHECK (char_length(outcome_note) BETWEEN 1 AND 2000);

ALTER TABLE round_events DROP CONSTRAINT round_events_type_m4;
-- M5.2's event types (#160); later M5 slices replace this.
ALTER TABLE round_events ADD CONSTRAINT round_events_type_m5 CHECK (type IN ('execution_started', 'progress', 'usage_observed', 'delivered', 'stop_confirmed'));

ALTER TABLE badges ADD COLUMN system_key TEXT;
ALTER TABLE badges ADD CONSTRAINT badges_system_key CHECK (system_key IN ('stopped'));
CREATE UNIQUE INDEX badges_owner_system_key_unique ON badges (owner_id, system_key) WHERE system_key IS NOT NULL;
