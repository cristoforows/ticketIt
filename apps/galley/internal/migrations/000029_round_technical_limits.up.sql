ALTER TABLE rounds ADD COLUMN active_ms BIGINT NOT NULL DEFAULT 0;
ALTER TABLE rounds ADD COLUMN active_since TIMESTAMPTZ;
-- No earlier record says when a Round left running, so a Round running at this migration counts from its start (#172).
UPDATE rounds SET active_since = started_at WHERE state = 'running';
ALTER TABLE rounds ADD CONSTRAINT rounds_active_ms_nonnegative CHECK (active_ms >= 0);
ALTER TABLE rounds ADD CONSTRAINT rounds_active_since_only_running CHECK (active_since IS NULL OR state = 'running');

CREATE TABLE round_limit_breaches (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id BIGINT NOT NULL,
    round_id BIGINT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    -- Seconds for wall_clock, denied checks for denial_loop.
    "limit" BIGINT NOT NULL,
    measured BIGINT NOT NULL,
    breached_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT round_limit_breaches_round_fk FOREIGN KEY (owner_id, round_id) REFERENCES rounds (owner_id, id),
    CONSTRAINT round_limit_breaches_kind CHECK (kind IN ('wall_clock', 'denial_loop')),
    CONSTRAINT round_limit_breaches_limit_positive CHECK ("limit" >= 1),
    CONSTRAINT round_limit_breaches_measured_reaches_limit CHECK (measured >= "limit")
);
