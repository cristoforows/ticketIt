ALTER TABLE round_events DROP CONSTRAINT round_events_type_m4;
-- M4's event types (#134, #135, #136). M5 (#6) replaces this.
ALTER TABLE round_events ADD CONSTRAINT round_events_type_m4 CHECK (type IN ('execution_started', 'progress', 'usage_observed', 'delivered'));

-- In PostgreSQL until object storage (D7) is selected; Reports move to storage in M7 (#8).
CREATE TABLE round_deliverables (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id BIGINT NOT NULL,
    round_id BIGINT NOT NULL,
    body_markdown TEXT NOT NULL,
    summary TEXT NOT NULL,
    criteria_assessment TEXT NOT NULL,
    CONSTRAINT round_deliverables_round_fk FOREIGN KEY (owner_id, round_id) REFERENCES rounds (owner_id, id),
    CONSTRAINT round_deliverables_round_unique UNIQUE (round_id),
    CONSTRAINT round_deliverables_body_markdown_size CHECK (octet_length(body_markdown) BETWEEN 1 AND 1048576),
    CONSTRAINT round_deliverables_summary_length CHECK (char_length(summary) BETWEEN 1 AND 2000),
    CONSTRAINT round_deliverables_criteria_assessment_length CHECK (char_length(criteria_assessment) BETWEEN 1 AND 10000),
    -- ASCII-whitespace backstops; Galley's validation rejects any Unicode-blank value.
    CONSTRAINT round_deliverables_body_markdown_not_blank CHECK (btrim(body_markdown, E' \t\n\r\f\v') <> ''),
    CONSTRAINT round_deliverables_summary_not_blank CHECK (btrim(summary, E' \t\n\r\f\v') <> ''),
    CONSTRAINT round_deliverables_criteria_assessment_not_blank CHECK (btrim(criteria_assessment, E' \t\n\r\f\v') <> '')
);
