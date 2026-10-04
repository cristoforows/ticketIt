ALTER TABLE round_events DROP CONSTRAINT round_events_type_m5;
-- M5.7's event types (#165); later M5 slices replace this.
ALTER TABLE round_events ADD CONSTRAINT round_events_type_m5 CHECK (type IN ('execution_started', 'progress', 'usage_observed', 'delivered', 'stop_confirmed', 'failed', 'interrupted', 'question_raised', 'resumed', 'permission_requested'));

ALTER TABLE rounds ADD CONSTRAINT rounds_id_ticket_id_agent_id_unique UNIQUE (id, ticket_id, agent_id);

CREATE TABLE permission_requests (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id BIGINT NOT NULL,
    ticket_id BIGINT NOT NULL,
    agent_id BIGINT NOT NULL,
    round_id BIGINT NOT NULL,
    request_id UUID NOT NULL,
    account TEXT NOT NULL,
    action TEXT NOT NULL,
    resource TEXT NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL,
    decision TEXT,
    decided_at TIMESTAMPTZ,
    CONSTRAINT permission_requests_round_fk FOREIGN KEY (owner_id, ticket_id, round_id) REFERENCES rounds (owner_id, ticket_id, id),
    CONSTRAINT permission_requests_round_agent_fk FOREIGN KEY (round_id, ticket_id, agent_id) REFERENCES rounds (id, ticket_id, agent_id),
    CONSTRAINT permission_requests_owner_id_id_unique UNIQUE (owner_id, id),
    CONSTRAINT permission_requests_round_id_id_unique UNIQUE (round_id, id),
    CONSTRAINT permission_requests_request_unique UNIQUE (round_id, request_id),
    CONSTRAINT permission_requests_scope_unique UNIQUE (id, ticket_id, agent_id, account, action, resource),
    CONSTRAINT permission_requests_account_length CHECK (char_length(account) BETWEEN 1 AND 200),
    CONSTRAINT permission_requests_action_length CHECK (char_length(action) BETWEEN 1 AND 200),
    CONSTRAINT permission_requests_resource_length CHECK (char_length(resource) BETWEEN 1 AND 200),
    CONSTRAINT permission_requests_decision CHECK (decision IN ('approved', 'declined')),
    CONSTRAINT permission_requests_decided_together CHECK ((decision IS NULL) = (decided_at IS NULL)),
    CONSTRAINT permission_requests_decided_after_requested CHECK (decided_at >= requested_at)
);
CREATE UNIQUE INDEX permission_requests_one_undecided_per_round ON permission_requests (round_id) WHERE decision IS NULL;

CREATE TABLE permission_grants (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id BIGINT NOT NULL,
    public_id UUID NOT NULL UNIQUE,
    ticket_id BIGINT NOT NULL,
    agent_id BIGINT NOT NULL,
    request_id BIGINT NOT NULL UNIQUE,
    account TEXT NOT NULL,
    action TEXT NOT NULL,
    resource TEXT NOT NULL,
    form TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    approved_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT permission_grants_owner_id_id_unique UNIQUE (owner_id, id),
    CONSTRAINT permission_grants_ticket_fk FOREIGN KEY (owner_id, ticket_id) REFERENCES tickets (owner_id, id),
    CONSTRAINT permission_grants_agent_fk FOREIGN KEY (owner_id, agent_id) REFERENCES agents (owner_id, id),
    CONSTRAINT permission_grants_request_fk FOREIGN KEY (owner_id, request_id) REFERENCES permission_requests (owner_id, id),
    CONSTRAINT permission_grants_request_scope_fk FOREIGN KEY (request_id, ticket_id, agent_id, account, action, resource)
        REFERENCES permission_requests (id, ticket_id, agent_id, account, action, resource),
    -- M5.7's forms (#165); M5.8 adds 'time'.
    CONSTRAINT permission_grants_form CHECK (form IN ('ticket')),
    -- M5.7's states (#165); later M5 slices end and revoke grants.
    CONSTRAINT permission_grants_state CHECK (state IN ('active')),
    CONSTRAINT permission_grants_approved_at_creation CHECK (approved_at = created_at)
);
CREATE INDEX permission_grants_authority ON permission_grants (owner_id, ticket_id, agent_id, account, action, resource) WHERE state = 'active';

CREATE TABLE round_authority_checks (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id BIGINT NOT NULL,
    round_id BIGINT NOT NULL,
    account TEXT NOT NULL,
    action TEXT NOT NULL,
    resource TEXT NOT NULL,
    claim_epoch INTEGER NOT NULL,
    decision TEXT NOT NULL,
    grant_id BIGINT,
    checked_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT round_authority_checks_round_fk FOREIGN KEY (owner_id, round_id) REFERENCES rounds (owner_id, id),
    CONSTRAINT round_authority_checks_grant_fk FOREIGN KEY (owner_id, grant_id) REFERENCES permission_grants (owner_id, id),
    CONSTRAINT round_authority_checks_decision CHECK (decision IN ('allow', 'deny')),
    CONSTRAINT round_authority_checks_grant_follows_decision CHECK ((decision = 'allow') = (grant_id IS NOT NULL)),
    CONSTRAINT round_authority_checks_claim_epoch_positive CHECK (claim_epoch >= 1)
);
CREATE INDEX round_authority_checks_round ON round_authority_checks (round_id, id);

ALTER TABLE round_commands DROP CONSTRAINT round_commands_type_m5;
-- M5.7's command types (#165); later M5 slices replace this.
ALTER TABLE round_commands ADD CONSTRAINT round_commands_type_m5 CHECK (type IN ('stop', 'answer', 'approval'));
ALTER TABLE round_commands ADD COLUMN permission_request_id BIGINT;
ALTER TABLE round_commands ADD CONSTRAINT round_commands_permission_request_fk FOREIGN KEY (owner_id, permission_request_id) REFERENCES permission_requests (owner_id, id);
ALTER TABLE round_commands ADD CONSTRAINT round_commands_permission_request_follows_type CHECK ((type = 'approval') = (permission_request_id IS NOT NULL));
CREATE UNIQUE INDEX round_commands_one_approval_per_request ON round_commands (permission_request_id) WHERE type = 'approval';

ALTER TABLE round_questions ADD CONSTRAINT round_questions_round_id_id_unique UNIQUE (round_id, id);
ALTER TABLE rounds ADD COLUMN waiting_question_id BIGINT;
ALTER TABLE rounds ADD COLUMN waiting_permission_request_id BIGINT;
ALTER TABLE rounds ADD CONSTRAINT rounds_waiting_question_fk FOREIGN KEY (id, waiting_question_id) REFERENCES round_questions (round_id, id);
ALTER TABLE rounds ADD CONSTRAINT rounds_waiting_permission_request_fk FOREIGN KEY (id, waiting_permission_request_id) REFERENCES permission_requests (round_id, id);
UPDATE rounds r SET waiting_question_id = (SELECT max(q.id) FROM round_questions q WHERE q.round_id = r.id) WHERE r.state = 'waiting_for_input';
ALTER TABLE rounds ADD CONSTRAINT rounds_waits_on_one_ask CHECK (
    num_nonnulls(waiting_question_id, waiting_permission_request_id) = CASE WHEN state = 'waiting_for_input' THEN 1 ELSE 0 END
);
