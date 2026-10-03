ALTER TABLE rounds DROP CONSTRAINT rounds_state_m5;
-- M5.5's states (#163); later M5 slices replace this.
ALTER TABLE rounds ADD CONSTRAINT rounds_state_m5 CHECK (state IN ('claimed', 'running', 'waiting_for_input', 'delivered', 'stopped', 'failed', 'interrupted'));

ALTER TABLE rounds DROP CONSTRAINT rounds_timestamps_follow_state;
ALTER TABLE rounds ADD CONSTRAINT rounds_timestamps_follow_state CHECK (
    CASE state
        WHEN 'claimed' THEN started_at IS NULL AND ended_at IS NULL
        WHEN 'running' THEN started_at IS NOT NULL AND ended_at IS NULL
        WHEN 'waiting_for_input' THEN started_at IS NOT NULL AND ended_at IS NULL
        WHEN 'delivered' THEN started_at IS NOT NULL AND ended_at IS NOT NULL
        WHEN 'stopped' THEN ended_at IS NOT NULL
        WHEN 'failed' THEN started_at IS NOT NULL AND ended_at IS NOT NULL
        WHEN 'interrupted' THEN started_at IS NOT NULL AND ended_at IS NOT NULL
    END
);

ALTER TABLE round_events DROP CONSTRAINT round_events_type_m5;
-- M5.5's event types (#163); later M5 slices replace this.
ALTER TABLE round_events ADD CONSTRAINT round_events_type_m5 CHECK (type IN ('execution_started', 'progress', 'usage_observed', 'delivered', 'stop_confirmed', 'failed', 'interrupted', 'question_raised', 'resumed'));

CREATE TABLE round_questions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id BIGINT NOT NULL,
    round_id BIGINT NOT NULL,
    question_id UUID NOT NULL,
    text TEXT NOT NULL,
    asked_at TIMESTAMPTZ NOT NULL,
    answer TEXT,
    answered_at TIMESTAMPTZ,
    CONSTRAINT round_questions_round_fk FOREIGN KEY (owner_id, round_id) REFERENCES rounds (owner_id, id),
    CONSTRAINT round_questions_owner_id_id_unique UNIQUE (owner_id, id),
    CONSTRAINT round_questions_question_unique UNIQUE (round_id, question_id),
    CONSTRAINT round_questions_text_length CHECK (char_length(text) BETWEEN 1 AND 2000),
    CONSTRAINT round_questions_answer_length CHECK (char_length(answer) BETWEEN 1 AND 2000),
    -- ASCII-whitespace backstops; Galley's validation rejects any Unicode-blank value.
    CONSTRAINT round_questions_text_not_blank CHECK (btrim(text, E' \t\n\r\f\v') <> ''),
    CONSTRAINT round_questions_answer_not_blank CHECK (btrim(answer, E' \t\n\r\f\v') <> ''),
    CONSTRAINT round_questions_answered_together CHECK ((answer IS NULL) = (answered_at IS NULL)),
    CONSTRAINT round_questions_answered_after_asked CHECK (answered_at >= asked_at)
);
CREATE UNIQUE INDEX round_questions_one_unanswered_per_round ON round_questions (round_id) WHERE answered_at IS NULL;

ALTER TABLE round_commands DROP CONSTRAINT round_commands_type_m5;
-- M5.5's command types (#163); later M5 slices replace this.
ALTER TABLE round_commands ADD CONSTRAINT round_commands_type_m5 CHECK (type IN ('stop', 'answer'));
ALTER TABLE round_commands ADD COLUMN question_id BIGINT;
ALTER TABLE round_commands ADD CONSTRAINT round_commands_question_fk FOREIGN KEY (owner_id, question_id) REFERENCES round_questions (owner_id, id);
ALTER TABLE round_commands ADD CONSTRAINT round_commands_question_follows_type CHECK ((type = 'answer') = (question_id IS NOT NULL));
CREATE UNIQUE INDEX round_commands_one_answer_per_question ON round_commands (question_id) WHERE type = 'answer';
