ALTER TABLE rounds DROP CONSTRAINT rounds_state_m5;
-- M5.3's states (#161); later M5 slices replace this.
ALTER TABLE rounds ADD CONSTRAINT rounds_state_m5 CHECK (state IN ('claimed', 'running', 'delivered', 'stopped', 'failed', 'interrupted'));

ALTER TABLE rounds DROP CONSTRAINT rounds_timestamps_follow_state;
ALTER TABLE rounds ADD CONSTRAINT rounds_timestamps_follow_state CHECK (
    CASE state
        WHEN 'claimed' THEN started_at IS NULL AND ended_at IS NULL
        WHEN 'running' THEN started_at IS NOT NULL AND ended_at IS NULL
        WHEN 'delivered' THEN started_at IS NOT NULL AND ended_at IS NOT NULL
        WHEN 'stopped' THEN ended_at IS NOT NULL
        WHEN 'failed' THEN started_at IS NOT NULL AND ended_at IS NOT NULL
        WHEN 'interrupted' THEN started_at IS NOT NULL AND ended_at IS NOT NULL
    END
);

ALTER TABLE rounds DROP CONSTRAINT rounds_outcome_note_follows_state;
ALTER TABLE rounds ADD CONSTRAINT rounds_outcome_note_follows_state CHECK ((state IN ('stopped', 'failed', 'interrupted')) = (outcome_note IS NOT NULL));

ALTER TABLE round_events DROP CONSTRAINT round_events_type_m5;
-- M5.3's event types (#161); later M5 slices replace this.
ALTER TABLE round_events ADD CONSTRAINT round_events_type_m5 CHECK (type IN ('execution_started', 'progress', 'usage_observed', 'delivered', 'stop_confirmed', 'failed', 'interrupted'));
